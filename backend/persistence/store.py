"""PostgreSQL queue, fenced worker leases, checkpoints, and source cache."""
import hashlib
import uuid
from datetime import timedelta
from functools import wraps

from django.db import close_old_connections, connections, transaction
from django.utils import timezone

LEASE_SECONDS = 60
MAX_ATTEMPTS = 3
MAX_RUNNING = 2
MAX_PENDING = 100


class LeaseLost(Exception):
    pass


def database_operation(method):
    @wraps(method)
    def call(*args, **kwargs):
        close_old_connections()
        try:
            return method(*args, **kwargs)
        finally:
            connections.close_all()
    return call


def queue_lock():
    with connections['default'].cursor() as cursor:
        cursor.execute('SELECT pg_advisory_xact_lock(%s)', [1364216399])


class ResearchStore:
    @database_operation
    def create(self, request):
        from backend.models import ResearchJob
        with transaction.atomic():
            queue_lock()
            if ResearchJob.objects.filter(status__in=['queued', 'running']).count() >= MAX_PENDING:
                raise RuntimeError('Research queue is full. Try again later.')
            job = ResearchJob.objects.create(request=request)
        # Keep the public job_id field compatible with existing bearer links.
        return job.access_token

    @database_operation
    def claim(self):
        from backend.models import ResearchJob
        with transaction.atomic():
            queue_lock()
            now = timezone.now()
            expired = ResearchJob.objects.filter(status='running', lease_expires_at__lte=now)
            expired.filter(attempts__gte=MAX_ATTEMPTS).update(
                status='failed', error='Research stopped after three worker attempts. Start a new job to retry.',
                lease_id=None, lease_expires_at=None, updated_at=now)
            expired.update(status='queued', lease_id=None, lease_expires_at=None, updated_at=now)
            if ResearchJob.objects.filter(status='running').count() >= MAX_RUNNING:
                return None
            job = ResearchJob.objects.select_for_update(skip_locked=True).filter(status='queued').order_by('created_at', 'id').first()
            if job is None:
                return None
            job.status = 'running'
            job.attempts += 1
            job.lease_id = uuid.uuid4()
            job.lease_expires_at = now + timedelta(seconds=LEASE_SECONDS)
            job.updated_at = now
            job.error = None
            job.save(update_fields=['status', 'attempts', 'lease_id', 'lease_expires_at', 'updated_at', 'error'])
            return dict(id=str(job.id), lease_id=str(job.lease_id))

    def owned(self, job_id, lease_id):
        from backend.models import ResearchJob
        return ResearchJob.objects.filter(pk=job_id, lease_id=lease_id, status='running',
                                          lease_expires_at__gt=timezone.now())

    @database_operation
    def renew(self, job_id, lease_id):
        now = timezone.now()
        return bool(self.owned(job_id, lease_id).update(
            lease_expires_at=now + timedelta(seconds=LEASE_SECONDS), updated_at=now))

    @database_operation
    def claimed_request(self, job_id, lease_id):
        job = self.owned(job_id, lease_id).first()
        if job is None:
            raise LeaseLost()
        return job.request

    @database_operation
    def update(self, job_id, *, lease_id, status='running', result=None, error=None):
        fields = dict(status=status, updated_at=timezone.now(), error=error)
        if result is not None:
            fields['result'] = result
        if status != 'running':
            fields.update(lease_id=None, lease_expires_at=None)
        if not self.owned(job_id, lease_id).update(**fields):
            raise LeaseLost()

    @database_operation
    def release(self, job_id, lease_id):
        """A stopped/crashed child retries within the same bounded attempt budget."""
        with transaction.atomic():
            job = self.owned(job_id, lease_id).select_for_update().first()
            if job is None:
                return
            job.status = 'queued' if job.attempts < MAX_ATTEMPTS else 'failed'
            job.error = None if job.status == 'queued' else 'Research stopped after three worker attempts. Start a new job to retry.'
            job.lease_id = job.lease_expires_at = None
            job.updated_at = timezone.now()
            job.save(update_fields=['status', 'error', 'lease_id', 'lease_expires_at', 'updated_at'])

    @database_operation
    def get(self, job_id):
        from backend.models import ResearchJob
        job = ResearchJob.objects.filter(access_token=job_id).first()
        if job is None:
            return None
        return dict(job_id=job.access_token, status=job.status, request=job.request,
                    result=job.result, error=job.error)

    @database_operation
    def cached(self, key, ttl=86400):
        from backend.models import ResearchCacheEntry
        entry = ResearchCacheEntry.objects.filter(
            key_hash=hashlib.sha256(key.encode()).hexdigest(),
            updated_at__gt=timezone.now() - timedelta(seconds=ttl),
        ).first()
        return entry.value if entry else None

    @database_operation
    def cache(self, key, value):
        from backend.models import ResearchCacheEntry
        ResearchCacheEntry.objects.update_or_create(
            key_hash=hashlib.sha256(key.encode()).hexdigest(),
            defaults=dict(key=key, updated_at=timezone.now(), value=value),
        )
