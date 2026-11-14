from unittest.mock import AsyncMock, patch

from backend.integrations.gemini import GeminiError
from backend.tests.base import StoreCase


class JobTests(StoreCase):
    def test_simple_brief_is_interpreted_saved_and_can_be_reevaluated(self):
        from backend.research.jobs import start_job, execute_job
        from backend.tests.support import DemoDiscovery, DemoEvaluator
        from backend.research.requests import StageRequest
        payload = StageRequest.model_validate({'requirements': {
            'product': 'Containers', 'quantity': 2.5, 'quantity_unit': 'kg', 'delivery_country': 'Germany',
        }})
        with patch('backend.integrations.gemini.GeminiClient'), \
             patch('backend.discovery.service.GeminiDiscovery', return_value=DemoDiscovery()), \
             patch('backend.evaluation.service.GeminiEvaluator', return_value=DemoEvaluator()), \
             patch('backend.research.recommendations.GeminiRecommendationAgent') as agent:
            from backend.domain.contracts import RecommendationReport
            agent.return_value.recommend = AsyncMock(return_value=RecommendationReport(
                summary='No supplier meets all mandatory requirements yet.', no_eligible_suppliers=True,
                candidate_supplier_ids=[], recommendations=[]))
            job = start_job(self.store, payload)
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
        state = self.store.get(job)
        self.assertEqual(state['status'], 'completed')
        self.assertEqual(state['request']['requirements']['criteria'], [])
        interpreted = state['result']['requirements']
        self.assertEqual([c['id'] for c in interpreted['criteria']], ['product', 'quantity', 'destination'])
        self.assertEqual(len(state['result']['assessments']), 3)
        self.assertTrue(state['result']['recommendation_report']['no_eligible_suppliers'])
        agent.return_value.recommend.assert_awaited_once()
        revised = StageRequest.model_validate({'requirements': interpreted, 'discovery_job_id': job})
        self.assertTrue(start_job(self.store, revised))
        for field, value in [('quantity_unit', 'pieces'), ('needed_by', '2027-03-15'),
                             ('other_requirements', 'EU required')]:
            changed = StageRequest.model_validate({'requirements': {**interpreted, field: value}, 'discovery_job_id': job})
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'fresh research'):
                start_job(self.store, changed)

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
