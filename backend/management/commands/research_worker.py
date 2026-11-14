"""Separate worker supervisor with PostgreSQL leases and killable job processes."""
import argparse
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from django.core.management.base import BaseCommand
from django.db import DatabaseError

from backend.research import ResearchStore

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


def supervise(store, claim, stopping):
    process = None
    try:
        process = subprocess.Popen([
            sys.executable, '-m', 'web.manage', 'research_worker',
            '--execute', claim['id'], '--lease', claim['lease_id'],
        ], start_new_session=True)
        started = last_heartbeat = time.monotonic()
        while process.poll() is None and not stopping.wait(1):
            now = time.monotonic()
            if now - started >= JOB_TIMEOUT_SECONDS:
                logger.warning('Research job exceeded worker deadline id=%s', claim['id'])
                break
            if now - last_heartbeat >= HEARTBEAT_SECONDS:
                if not store.renew(claim['id'], claim['lease_id']):
                    break
                last_heartbeat = now
    finally:
        if process is not None:
            stop_process(process)
        # Completed/failed jobs no longer own a lease; release is then a no-op.
        # If PostgreSQL is unavailable, lease expiry handles recovery instead.
        store.release(claim['id'], claim['lease_id'])


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path in ('/', '/health/') else 404)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"service":"research-worker"}')

    def log_message(self, *args):
        pass


class Command(BaseCommand):
    help = 'Process queued research in a separate service. Run alongside the web server.'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true', help='Process at most one queued job, then exit.')
        parser.add_argument('--health-port', type=int, default=0, help='Optional private HTTP liveness port.')
        parser.add_argument('--execute', help=argparse.SUPPRESS)
        parser.add_argument('--lease', help=argparse.SUPPRESS)

    def handle(self, *args, **options):
        store = ResearchStore()
        if options['execute']:
            from backend.jobs import execute_job
            execute_job(store, options['execute'], options['lease'])
            return
        health = HTTPServer(('0.0.0.0', options['health_port']), HealthHandler) if options['health_port'] else None
        if health:
            health.timeout = 5
            threading.Thread(target=health.serve_forever, daemon=True).start()
        stopping = threading.Event()
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        for sig in previous:
            signal.signal(sig, lambda *_: stopping.set())
        self.stdout.write('Research worker ready.')
        try:
            while not stopping.is_set():
                try:
                    claim = store.claim()
                    if claim:
                        supervise(store, claim, stopping)
                    elif not options['once']:
                        stopping.wait(2)
                except (DatabaseError, OSError):
                    logger.exception('Research worker could not process the queue')
                    if options['once']:
                        raise
                    stopping.wait(5)
                if options['once']:
                    break
        finally:
            if health:
                health.shutdown()
                health.server_close()
            for sig, handler in previous.items():
                signal.signal(sig, handler)
