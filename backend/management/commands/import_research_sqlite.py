"""One-time, read-only import of the retired research store into PostgreSQL."""
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from backend.models import ResearchCacheEntry, ResearchJob


class Command(BaseCommand):
    help = 'Import legacy research.sqlite3 without modifying it or overwriting PostgreSQL records. Stop old workers first.'

    def add_arguments(self, parser):
        parser.add_argument('path', type=Path)

    def handle(self, *args, **options):
        path = options['path'].resolve()
        if not path.is_file():
            raise CommandError('Legacy research database does not exist.')
        created_jobs = created_cache = 0
        try:
            source = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
            try:
                with transaction.atomic():
                    for job_id, status, updated, request, result, error in source.execute('SELECT id, status, updated, request, result, error FROM jobs'):
                        timestamp = datetime.fromtimestamp(updated, timezone.utc)
                        if status == 'running':
                            status = 'interrupted'
                            error = 'Research was interrupted during database migration. Retry to reuse cached work.'
                        _, created = ResearchJob.objects.get_or_create(access_token=job_id, defaults=dict(
                            status=status, created_at=timestamp, updated_at=timestamp,
                            request=json.loads(request), result=json.loads(result) if result else None, error=error))
                        created_jobs += created
                    for key, updated, value in source.execute('SELECT key, updated, value FROM cache'):
                        _, created = ResearchCacheEntry.objects.get_or_create(
                            key_hash=hashlib.sha256(key.encode()).hexdigest(), defaults=dict(
                                key=key, updated_at=datetime.fromtimestamp(updated, timezone.utc), value=json.loads(value)))
                        created_cache += created
            finally:
                source.close()
        except (sqlite3.Error, ValueError, TypeError, OverflowError) as exc:
            raise CommandError('Could not import the legacy database; no records were imported.') from exc
        self.stdout.write(self.style.SUCCESS(f'Imported {created_jobs} jobs and {created_cache} cache entries. Existing records were preserved.'))
