import uuid

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class UUIDMigrationTests(TransactionTestCase):
    def test_existing_records_keep_tokens_keys_and_payloads(self):
        before = [('backend', '0001_initial')]
        after = [('backend', '0002_uuid_primary_keys')]
        executor = MigrationExecutor(connection)
        executor.migrate(before)
        try:
            apps = executor.loader.project_state(before).apps
            for character in ['a', 'b']:
                apps.get_model('backend', 'ResearchJob').objects.create(
                    id=character * 64, status='completed', request={'product': character},
                    result={'suppliers': []})
                apps.get_model('backend', 'ResearchCacheEntry').objects.create(
                    key_hash=character * 64, key=f'page:{character}', value={'text': character})
            executor = MigrationExecutor(connection)
            executor.migrate(after)
            apps = executor.loader.project_state(after).apps
            jobs = apps.get_model('backend', 'ResearchJob').objects
            cache = apps.get_model('backend', 'ResearchCacheEntry').objects
            self.assertEqual(len(set(jobs.values_list('id', flat=True))), 2)
            self.assertEqual(len(set(cache.values_list('id', flat=True))), 2)
            for character in ['a', 'b']:
                job = jobs.get(access_token=character * 64)
                self.assertIsInstance(job.id, uuid.UUID)
                self.assertEqual(job.status, 'completed')
                self.assertEqual(job.request, {'product': character})
                self.assertEqual(job.result, {'suppliers': []})
                entry = cache.get(key_hash=character * 64)
                self.assertIsInstance(entry.id, uuid.UUID)
                self.assertEqual(entry.key, f'page:{character}')
                self.assertEqual(entry.value, {'text': character})
        finally:
            executor = MigrationExecutor(connection)
            executor.migrate(executor.loader.graph.leaf_nodes())


class QueueMigrationTests(TransactionTestCase):
    def test_running_jobs_are_queued_without_losing_checkpoints(self):
        before = [('backend', '0002_uuid_primary_keys')]
        after = [('backend', '0003_durable_queue')]
        executor = MigrationExecutor(connection)
        executor.migrate(before)
        try:
            jobs = executor.loader.project_state(before).apps.get_model('backend', 'ResearchJob').objects
            running = jobs.create(status='running', request={'stage': 'discover'}, result={'suppliers': []})
            completed = jobs.create(status='completed', request={'stage': 'discover'}, result={'suppliers': []})
            executor = MigrationExecutor(connection)
            executor.migrate(after)
            jobs = executor.loader.project_state(after).apps.get_model('backend', 'ResearchJob').objects
            recovered = jobs.get(pk=running.id)
            self.assertEqual(recovered.status, 'queued')
            self.assertEqual(recovered.result, {'suppliers': []})
            self.assertEqual(recovered.attempts, 0)
            self.assertEqual(jobs.get(pk=completed.id).status, 'completed')
        finally:
            executor = MigrationExecutor(connection)
            executor.migrate(executor.loader.graph.leaf_nodes())
