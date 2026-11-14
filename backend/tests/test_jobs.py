from unittest.mock import patch

from backend.integrations.gemini import GeminiError
from backend.tests.base import StoreCase


class JobTests(StoreCase):
    def test_background_job_persists_result(self):
        from backend.research.jobs import start_job, execute_job
        from backend.tests.support import DemoDiscovery, demo_fixture
        from backend.research.requests import StageRequest
        payload = StageRequest.model_validate(demo_fixture()['request'])
        with patch('backend.integrations.gemini.GeminiClient'), patch('backend.discovery.service.GeminiDiscovery', return_value=DemoDiscovery()):
            job = start_job(self.store, payload, 'discover')
            self.assertEqual(self.store.get(job)['status'], 'queued')
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
            state = self.store.get(job)
        self.assertEqual(state['status'], 'completed')
        self.assertEqual(len(state['result']['suppliers']), 3)

    def test_failure_retains_checkpoint(self):
        from backend.research.jobs import start_job, execute_job
        from backend.domain.contracts import DiscoveryResult
        from backend.tests.support import demo_fixture
        from backend.research.requests import StageRequest
        class Broken:
            def __init__(self, client, store, progress):
                self.progress = progress
            async def discover_suppliers(self, *args, **kwargs):
                await self.progress(DiscoveryResult())
                raise GeminiError('Provider unavailable')
        with patch('backend.integrations.gemini.GeminiClient'), patch('backend.discovery.service.GeminiDiscovery', Broken), self.assertLogs('backend.research.jobs', level='ERROR'):
            job = start_job(self.store, StageRequest.model_validate(demo_fixture()['request']), 'discover')
            self.assertEqual(self.store.get(job)['status'], 'queued')
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
            state = self.store.get(job)
        self.assertEqual(state['status'], 'failed')
        self.assertIsNotNone(state['result'])
        self.assertEqual(state['error'], 'Provider unavailable')
