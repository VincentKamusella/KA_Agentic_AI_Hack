"""Separate worker supervisor with PostgreSQL leases and killable job processes."""
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from django.conf import settings
from http.server import BaseHTTPRequestHandler, HTTPServer

from django.db import DatabaseError

from backend.persistence.store import ResearchStore

logger = logging.getLogger(__name__)
HEARTBEAT_SECONDS = 10
JOB_TIMEOUT_SECONDS = 1800


def stop_process(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            process.wait()
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


@dataclass
class RunningJob:
    claim: dict
    process: subprocess.Popen
    started: float
    last_heartbeat: float


def launch(store, claim):
    try:
        process = subprocess.Popen([
            sys.executable, '-m', 'web.manage', 'research_worker',
            '--execute', claim['id'], '--lease', claim['lease_id'],
        ], start_new_session=True)
    except OSError:
        store.release(claim['id'], claim['lease_id'])
        raise
    now = time.monotonic()
    return RunningJob(claim, process, now, now)


def keep_running(store, job):
    if job.process.poll() is not None:
        return False
    now = time.monotonic()
    if now - job.started >= JOB_TIMEOUT_SECONDS:
        logger.warning('Research job exceeded worker deadline id=%s', job.claim['id'])
        return False
    if now - job.last_heartbeat >= HEARTBEAT_SECONDS:
        if not store.renew(job.claim['id'], job.claim['lease_id']):
            return False
        job.last_heartbeat = now
    return True


def finish(store, job):
    try:
        stop_process(job.process)
    finally:
        # Completed jobs no longer own a lease. If the database is unavailable,
        # lease expiry recovers unfinished work.
        store.release(job.claim['id'], job.claim['lease_id'])


def supervise(store, claim, stopping):
    job = launch(store, claim)
    try:
        while not stopping.is_set() and keep_running(store, job):
            stopping.wait(1)
    finally:
        finish(store, job)


def supervise_pool(store, stopping):
    """Poll isolated children together so a slow search cannot block the queue."""
    active = []
    try:
        while not stopping.is_set():
            for job in active[:]:
                try:
                    if keep_running(store, job):
                        continue
                except (DatabaseError, OSError):
                    logger.exception('Research job supervision failed id=%s', job.claim['id'])
                try:
                    finish(store, job)
                except (DatabaseError, OSError):
                    logger.exception('Research job cleanup failed id=%s', job.claim['id'])
                active.remove(job)
            try:
                while not stopping.is_set() and len(active) < settings.RESEARCH_MAX_RUNNING:
                    claim = store.claim()
                    if claim is None:
                        break
                    active.append(launch(store, claim))
            except (DatabaseError, OSError):
                logger.exception('Research worker could not claim or launch a job')
            stopping.wait(1 if active else 2)
    finally:
        for job in active:
            try:
                finish(store, job)
            except (DatabaseError, OSError):
                logger.exception('Research job cleanup failed id=%s', job.claim['id'])


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path in ('/', '/health/') else 404)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"service":"research-worker"}')

    def log_message(self, *args):
        pass


def run_worker(*, once=False, execute=None, lease=None, health_port=0, write=print):
    store = ResearchStore()
    if execute:
        from backend.research.jobs import execute_job
        execute_job(store, execute, lease)
        return
    health = HTTPServer(('0.0.0.0', health_port), HealthHandler) if health_port else None
    if health:
        health.timeout = 5
        threading.Thread(target=health.serve_forever, daemon=True).start()
    stopping = threading.Event()
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    for sig in previous:
        signal.signal(sig, lambda *_: stopping.set())
    write(f'Research worker ready (up to {settings.RESEARCH_MAX_RUNNING} concurrent jobs).')
    try:
        if once:
            claim = store.claim()
            if claim:
                supervise(store, claim, stopping)
        else:
            supervise_pool(store, stopping)
    finally:
        if health:
            health.shutdown()
            health.server_close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
