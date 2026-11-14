import io
import time
import uuid
from datetime import timedelta

from django.utils import timezone

from backend.models import ResearchCacheEntry, ResearchJob
from backend.persistence.store import ResearchStore
from backend.tests.base import StoreCase


class ResearchTests(StoreCase):
    def test_uuid_ids_are_separate_from_lookup_keys(self):
        token = self.store.create({})
        job = ResearchJob.objects.get(access_token=token)
        self.assertIsInstance(job.id, uuid.UUID)
        self.assertEqual(len(token), 64)
        self.assertIsNone(self.store.get(str(job.id)))
        self.store.cache('page:test', {'version': 1})
        entry = ResearchCacheEntry.objects.get(key='page:test')
        self.assertIsInstance(entry.id, uuid.UUID)
        self.store.cache('page:test', {'version': 2})
        self.assertEqual(ResearchCacheEntry.objects.get(key='page:test').id, entry.id)
        self.assertEqual(ResearchCacheEntry.objects.count(), 1)
        self.assertEqual(self.store.cached('page:test'), {'version': 2})

    def test_persistence_and_expiration(self):
        job = self.store.create({'product': 'bolts'})
        claim = self.store.claim()
        self.store.update(claim['id'], lease_id=claim['lease_id'], result={'suppliers': []})
        reopened = ResearchStore()
        self.assertEqual(reopened.get(job)['result'], {'suppliers': []})
        self.store.cache('test', {'text': 'source'})
        self.assertEqual(reopened.cached('test'), {'text': 'source'})
        self.assertIsNone(reopened.cached('test', ttl=-1))
        ResearchJob.objects.filter(access_token=job).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
        self.store.claim()
        self.assertEqual(self.store.get(job)['status'], 'running')
        self.assertIsNotNone(self.store.get(job)['result'])

    def test_admission_control_and_release(self):
        for _ in range(3):
            self.store.create({})
        first = self.store.claim()
        self.assertIsNotNone(self.store.claim())
        self.assertIsNone(self.store.claim())
        self.store.update(first['id'], lease_id=first['lease_id'], status='completed')
        self.assertIsNotNone(self.store.claim())


class LegacyImportTests(StoreCase):
    def test_import_preserves_records_and_is_idempotent(self):
        import sqlite3
        import tempfile
        from pathlib import Path
        from django.core.management import call_command
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'legacy.sqlite3'
            with sqlite3.connect(path) as source:
                source.execute('CREATE TABLE jobs(id TEXT, status TEXT, updated REAL, request TEXT, result TEXT, error TEXT)')
                source.execute('CREATE TABLE cache(key TEXT, updated REAL, value TEXT)')
                source.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)',
                               ('a' * 64, 'running', time.time(), '{"stage":"discover"}', '{"suppliers":[]}', None))
                source.execute('INSERT INTO cache VALUES(?,?,?)', ('page:test', time.time(), '{"text":"source"}'))
            call_command('import_research_sqlite', str(path), stdout=io.StringIO())
            self.assertEqual(self.store.get('a' * 64)['status'], 'interrupted')
            self.assertEqual(self.store.cached('page:test'), {'text': 'source'})
            ResearchJob.objects.filter(access_token='a' * 64).update(status='completed', result={'new': True})
            call_command('import_research_sqlite', str(path), stdout=io.StringIO())
            self.assertEqual(self.store.get('a' * 64)['result'], {'new': True})
            with sqlite3.connect(path) as source:
                self.assertEqual(source.execute('SELECT status FROM jobs').fetchone()[0], 'running')
