"""Research records live in the application's PostgreSQL database."""
import secrets
import uuid

from django.db import models
from django.utils import timezone


def new_access_token():
    return secrets.token_hex(32)


class ResearchJob(models.Model):
    class Status(models.TextChoices):
        QUEUED = 'queued'
        RUNNING = 'running'
        COMPLETED = 'completed'
        FAILED = 'failed'
        INTERRUPTED = 'interrupted'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    access_token = models.CharField(max_length=64, unique=True, default=new_access_token, editable=False)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now)
    attempts = models.PositiveSmallIntegerField(default=0)
    lease_id = models.UUIDField(null=True, editable=False)
    lease_expires_at = models.DateTimeField(null=True)
    request = models.JSONField()
    result = models.JSONField(null=True, blank=True)
    error = models.TextField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=['status', 'updated_at'], name='research_active_jobs')]
        constraints = [models.CheckConstraint(condition=models.Q(status__in=[
            'queued', 'running', 'completed', 'failed', 'interrupted']), name='research_job_valid_status')]


class ResearchCacheEntry(models.Model):
    # Hash arbitrary-length URLs instead of indexing their raw text: PostgreSQL
    # B-tree index entries have a byte limit smaller than some supplier URLs.
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    key_hash = models.CharField(max_length=64, unique=True)
    key = models.TextField()
    updated_at = models.DateTimeField(default=timezone.now, db_index=True)
    value = models.JSONField()
