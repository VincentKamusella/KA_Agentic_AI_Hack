"""PostgreSQL research persistence through Django's configured database.

Methods are synchronous; async discovery calls them in worker threads. Each
operation closes its thread's connection so background pools cannot leak sockets.
"""
import hashlib
from datetime import timedelta
from functools import wraps

from django.db import close_old_connections, connections, transaction
from django.utils import timezone


def database_operation(method):
    @wraps(method)
    def call(*args, **kwargs):
        close_old_connections()
        try:
            return method(*args, **kwargs)
        finally:
            connections.close_all()
    return call


class ResearchStore:
    @database_operation
    def create(self, request):
        from backend.models import ResearchJob
        with transaction.atomic():
            # Transaction-scoped advisory lock serializes admission across all
            # web processes/hosts using this database, including an empty table.
            with connections['default'].cursor() as cursor:
                cursor.execute('SELECT pg_advisory_xact_lock(%s)', [1364216399])
            active = ResearchJob.objects.filter(
                status=ResearchJob.Status.RUNNING,
                updated_at__gt=timezone.now() - timedelta(minutes=30),
            ).count()
            if active >= 2:
                raise RuntimeError('Two research jobs are already running. Try again later.')
            job = ResearchJob.objects.create(request=request)
        # The public API retains its job_id name for the bearer token.
        return job.access_token

    @database_operation
    def update(self, job_id, *, status='running', result=None, error=None):
        from backend.models import ResearchJob
        fields = dict(status=status, updated_at=timezone.now(), error=error)
        if result is not None:
            fields['result'] = result
        ResearchJob.objects.filter(access_token=job_id).update(**fields)

    @database_operation
    def get(self, job_id):
        from backend.models import ResearchJob
        job = ResearchJob.objects.filter(access_token=job_id).first()
        if job is None:
            return None
        status, error = job.status, job.error
        if status == 'running' and job.updated_at < timezone.now() - timedelta(minutes=30):
            status = 'interrupted'
            error = 'Research worker stopped. Start discovery again; cached work will be reused.'
        return dict(job_id=job.access_token, status=status, request=job.request, result=job.result, error=error)

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
