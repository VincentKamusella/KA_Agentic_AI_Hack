import json
import os
import subprocess
import sys
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from backend.research.jobs import execute_job, start_job
from backend.models import ResearchJob
from backend.persistence.store import LeaseLost, ResearchStore
from backend.research.requests import StageRequest
from backend.tests.base import StoreCase
from backend.tests.support import DemoDiscovery, DemoEvaluator, demo_fixture
from backend.tests.test_recommendations import draft, provider_response
from web.accounts.services import record_search


@override_settings(ALLOWED_HOSTS=['testserver'], SECURE_SSL_REDIRECT=False)
class QueueTests(TransactionTestCase):
    def setUp(self):
        self.store = ResearchStore()
        self.payload = StageRequest.model_validate(demo_fixture()['request'])
        self.gemini = AsyncMock()
        self.gemini.post.return_value = provider_response([draft(), draft('gamma')])
        # The research API requires a signed-in account.
        self.user = get_user_model().objects.create_user('buyer@example.com', 'buyer@example.com', 'unused-password')
        self.client.force_login(self.user)

    def own(self, token):
        """Jobs started directly in the store belong to nobody; the API only
        reuses evidence from jobs of the signed-in account."""
        record_search(self.user, token, self.payload.requirements.product)

    def expire(self, claim):
        ResearchJob.objects.filter(pk=claim['id']).update(lease_expires_at=timezone.now() - timedelta(seconds=1))

    def test_enqueue_without_provider_or_worker_and_recover_after_crash(self):
        with patch('backend.integrations.gemini.GeminiClient', side_effect=AssertionError('API must not call Gemini')):
            response = self.client.post('/api/research/', json.dumps(demo_fixture()['request']), content_type='application/json')
        self.assertEqual(response.status_code, 202)
        token = response.json()['job_id']
        self.assertEqual(self.store.get(token)['status'], 'queued')
        first = self.store.claim()
        self.store.update(first['id'], lease_id=first['lease_id'], result={'partial': True})
        self.expire(first)
        recovered = self.store.claim()
        self.assertEqual(first['id'], recovered['id'])
        self.assertNotEqual(first['lease_id'], recovered['lease_id'])
        self.assertEqual(self.store.get(token)['result'], {'partial': True})
        self.assertFalse(self.store.renew(first['id'], first['lease_id']))
        with self.assertRaises(LeaseLost):
            self.store.update(first['id'], lease_id=first['lease_id'], status='completed', result={'stale': True})
        self.store.update(recovered['id'], lease_id=recovered['lease_id'], status='completed', result={'final': True})
        self.assertEqual(self.store.get(token)['result'], {'final': True})

    def test_queue_capacity_is_enforced_across_connections(self):
        from concurrent.futures import ThreadPoolExecutor
        def enqueue(_):
            try:
                return self.store.create({})
            except RuntimeError:
                return None
        with patch('backend.persistence.store.MAX_PENDING', 2), ThreadPoolExecutor(max_workers=6) as pool:
            tokens = list(pool.map(enqueue, range(6)))
        self.assertEqual(sum(token is not None for token in tokens), 2)

    def test_crash_retry_budget_is_bounded(self):
        token = self.store.create({})
        for _ in range(3):
            claim = self.store.claim()
            self.expire(claim)
        self.assertIsNone(self.store.claim())
        self.assertEqual(self.store.get(token)['status'], 'failed')

    def test_heartbeat_and_graceful_release(self):
        token = self.store.create({})
        claim = self.store.claim()
        self.assertTrue(self.store.renew(claim['id'], claim['lease_id']))
        self.assertIsNone(self.store.claim())
        self.store.release(claim['id'], claim['lease_id'])
        self.assertEqual(self.store.get(token)['status'], 'queued')
        self.assertIsNotNone(self.store.claim())

    def test_evaluation_uses_saved_evidence(self):
        with patch('backend.integrations.gemini.GeminiClient', return_value=self.gemini), patch('backend.discovery.service.GeminiDiscovery', return_value=DemoDiscovery()):
            token = start_job(self.store, self.payload, 'discover')
            self.own(token)
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
        payload = self.payload.model_dump(mode='json') | {'discovery_job_id': token}
        with patch('backend.evaluation.service.GeminiEvaluator', return_value=DemoEvaluator()), patch('backend.integrations.gemini.GeminiClient', return_value=self.gemini):
            response = self.client.post('/api/research/', json.dumps(payload), content_type='application/json')
            self.assertEqual(response.status_code, 202)
            evaluation_token = response.json()['job_id']
            self.assertNotIn('suppliers', self.store.get(evaluation_token)['request'])
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
        result = self.store.get(evaluation_token)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['request']['stage'], 'evaluate')
        self.assertEqual(result['result']['recommended_supplier_ids'], ['alpha'])
        self.assertEqual(result['result']['recommendation_report']['recommendations'][0]['supplier_id'], 'alpha')
        # Re-running evaluation against the same discovery job works repeatedly.
        with patch('backend.evaluation.service.GeminiEvaluator', return_value=DemoEvaluator()), patch('backend.integrations.gemini.GeminiClient', return_value=self.gemini):
            second = self.client.post('/api/research/', json.dumps(payload), content_type='application/json')
            self.assertEqual(second.status_code, 202)
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
        self.assertEqual(self.store.get(second.json()['job_id'])['status'], 'completed')
        payload['suppliers'] = demo_fixture()['response']['suppliers']
        self.assertEqual(self.client.post('/api/research/', json.dumps(payload), content_type='application/json').status_code, 400)

    def test_evaluation_can_rerun_when_discovery_finished_before_eval_failed(self):
        with patch('backend.integrations.gemini.GeminiClient', return_value=self.gemini), patch('backend.discovery.service.GeminiDiscovery', return_value=DemoDiscovery()):
            token = start_job(self.store, self.payload, 'research')
            self.own(token)
            ResearchJob.objects.filter(access_token=token).update(
                status='failed',
                result={'phase': 'evaluation', 'suppliers': demo_fixture()['response']['suppliers']},
                error='Evaluation timed out',
            )
        payload = self.payload.model_dump(mode='json') | {'discovery_job_id': token}
        with patch('backend.evaluation.service.GeminiEvaluator', return_value=DemoEvaluator()), patch('backend.integrations.gemini.GeminiClient', return_value=self.gemini):
            response = self.client.post('/api/research/', json.dumps(payload), content_type='application/json')
            self.assertEqual(response.status_code, 202)
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
        self.assertEqual(self.store.get(response.json()['job_id'])['status'], 'completed')

    def test_evaluation_rejects_missing_pending_and_non_discovery_references(self):
        token = start_job(self.store, self.payload, 'discover')
        self.own(token)
        for reference in ['f' * 64, token]:
            payload = self.payload.model_dump(mode='json') | {'discovery_job_id': reference}
            self.assertEqual(self.client.post('/api/research/', json.dumps(payload), content_type='application/json').status_code, 400)
        ResearchJob.objects.filter(access_token=token).update(status='completed', request={'stage': 'evaluate'}, result={'suppliers': [{}]})
        with self.assertRaises(ValueError):
            start_job(self.store, self.payload.model_copy(update={'discovery_job_id': token}), 'evaluate')

    def run_worker_process(self):
        from urllib.parse import quote
        db = settings.DATABASES['default']
        url = f"postgresql://{quote(db['USER'], safe='')}:{quote(db['PASSWORD'], safe='')}@{db['HOST']}:{db['PORT']}/{db['NAME']}"
        process = subprocess.run([sys.executable, '-m', 'web.manage', 'research_worker', '--once'],
                                 env={**os.environ, 'DATABASE_URL': url, 'GEMINI_API_KEY': 'test-key'},
                                 capture_output=True, text=True, timeout=20)
        self.assertEqual(process.returncode, 0, process.stderr)

    def test_separate_worker_process_persists_failure_without_web_execution(self):
        token = self.store.create({'stage': 'research', 'requirements': {}})
        self.run_worker_process()
        job = self.store.get(token)
        self.assertEqual(job['status'], 'failed')
        self.assertIsNotNone(job['error'])

    def test_separate_worker_finishes_cached_research_without_web_process(self):
        import asyncio
        from backend.discovery.service import GeminiDiscovery, search_plan
        from backend.domain.contracts import DiscoveryOptions
        options = DiscoveryOptions(max_queries=1)
        class EmptySearch:
            async def post(self, *args):
                return {'status': 'completed', 'steps': []}
        # Seed the test database through the real search cache path; the subprocess
        # has no mocks and reads the durable cache without provider network calls.
        asyncio.run(GeminiDiscovery(EmptySearch(), store=self.store).search_query(
            search_plan(self.payload.requirements, options)[0], self.payload.requirements, options, [], []))
        token = start_job(self.store, self.payload.model_copy(update={'options': options}))
        self.run_worker_process()
        result = self.store.get(token)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['result']['phase'], 'complete')
        self.assertEqual(result['result']['recommended_supplier_ids'], [])
        self.assertTrue(result['result']['coverage']['queries'][0]['cached'])

    def test_single_submission_runs_discovery_and_evaluation(self):
        with patch('backend.integrations.gemini.GeminiClient', return_value=self.gemini), patch('backend.discovery.service.GeminiDiscovery', return_value=DemoDiscovery()), patch('backend.evaluation.service.GeminiEvaluator', return_value=DemoEvaluator()):
            response = self.client.post('/api/research/', json.dumps(demo_fixture()['request']), content_type='application/json')
            self.assertEqual(response.status_code, 202)
            token = response.json()['job_id']
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
        job = self.store.get(token)
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(job['result']['recommended_supplier_ids'], ['alpha'])
        self.assertEqual(len(job['result']['assessments']), 3)
        self.assertIn('coverage', job['result'])
        report = job['result']['recommendation_report']
        self.assertEqual(report['recommendations'][0]['qualification'], 'meets_documented_requirements')
        self.assertIn('1000 pieces', report['recommendations'][0]['email_draft']['body'])
        status = self.client.get(f'/api/research/{token}/')
        self.assertEqual(status.json()['result']['recommendation_report'], report)

    def test_recommendation_failure_preserves_completed_grades_and_checkpoint(self):
        from backend.integrations.gemini import GeminiError
        self.gemini.post.side_effect = GeminiError('Recommendation provider unavailable')
        with patch('backend.integrations.gemini.GeminiClient', return_value=self.gemini), \
             patch('backend.discovery.service.GeminiDiscovery', return_value=DemoDiscovery()), \
             patch('backend.evaluation.service.GeminiEvaluator', return_value=DemoEvaluator()), \
             patch.object(self.store, 'update', wraps=self.store.update) as updates:
            token = start_job(self.store, self.payload)
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
        checkpoints = [call.kwargs.get('result', {}) for call in updates.call_args_list]
        checkpoint = next(result for result in checkpoints if result.get('phase') == 'recommendation')
        self.assertEqual(len(checkpoint['assessments']), 3)
        job = self.store.get(token)
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(job['result']['recommended_supplier_ids'], ['alpha'])
        self.assertIsNone(job['result']['recommendation_report'])
        self.assertEqual(job['result']['issues'][-1]['stage'], 'recommendation')

    def test_discovery_is_reusable_after_interrupted_recommendation(self):
        from backend.research.jobs import discovery_suppliers
        token = start_job(self.store, self.payload)
        ResearchJob.objects.filter(access_token=token).update(
            status='failed', result={'phase': 'recommendation',
                                     'suppliers': demo_fixture()['response']['suppliers']})
        self.assertEqual(len(discovery_suppliers(self.store, token)), 3)

    def test_worker_supervisor_requeues_on_shutdown_and_terminates_child(self):
        import threading
        from backend.research.worker import supervise
        token = self.store.create({})
        claim = self.store.claim()
        stop = threading.Event()
        stop.set()
        with patch('backend.research.worker.subprocess.Popen') as popen, patch('backend.research.worker.os.killpg') as kill:
            popen.return_value.poll.return_value = None
            supervise(self.store, claim, stop)
            kill.assert_called_once()
            popen.return_value.wait.assert_called_once()
        self.assertEqual(self.store.get(token)['status'], 'queued')

    def test_worker_supervisor_stops_child_after_losing_lease(self):
        import threading
        from backend.research.worker import supervise
        token = self.store.create({})
        claim = self.store.claim()
        self.expire(claim)
        with patch('backend.research.worker.subprocess.Popen') as popen, patch('backend.research.worker.os.killpg') as kill, patch('backend.research.worker.HEARTBEAT_SECONDS', 0):
            popen.return_value.poll.return_value = None
            supervise(self.store, claim, threading.Event())
            kill.assert_called_once()
        self.assertIsNotNone(self.store.claim())


@override_settings(RESEARCH_MAX_RUNNING=2)
class ConcurrencyTests(StoreCase):
    def test_job_capacity_is_enforced_across_simultaneous_connections(self):
        from concurrent.futures import ThreadPoolExecutor
        for _ in range(6):
            self.store.create({})
        with ThreadPoolExecutor(max_workers=6) as pool:
            ids = list(pool.map(lambda _: self.store.claim(), range(6)))
        self.assertEqual(len([job for job in ids if job]), 2)


class WorkerPoolTests(TransactionTestCase):
    @override_settings(RESEARCH_MAX_RUNNING=3)
    def test_pool_launches_to_capacity_before_any_child_finishes(self):
        import threading
        from unittest.mock import Mock
        from backend.research.worker import supervise_pool
        store = Mock()
        store.claim.side_effect = [{'id': str(i), 'lease_id': str(i)} for i in range(3)]
        stopping = threading.Event()
        launched = []

        def launch_job(store, claim):
            launched.append(claim['id'])
            if len(launched) == 3:
                stopping.set()
            return Mock(claim=claim)

        with patch('backend.research.worker.launch', side_effect=launch_job), \
             patch('backend.research.worker.finish') as finish:
            supervise_pool(store, stopping)
        self.assertEqual(launched, ['0', '1', '2'])
        self.assertEqual(store.claim.call_count, 3)
        self.assertEqual(finish.call_count, 3)

    @override_settings(RESEARCH_MAX_RUNNING=2)
    def test_pool_refills_finished_slot_while_other_job_keeps_running(self):
        from unittest.mock import Mock
        from backend.research.worker import supervise_pool
        stopping = Mock()
        stopping.is_set.return_value = False
        store = Mock()
        store.claim.side_effect = [{'id': str(i), 'lease_id': str(i)} for i in range(3)]
        jobs = [Mock(claim={'id': str(i), 'lease_id': str(i)}) for i in range(3)]
        launched = []

        def launch_job(store, claim):
            launched.append(claim['id'])
            if len(launched) == 3:
                stopping.is_set.return_value = True
            return jobs[int(claim['id'])]

        with patch('backend.research.worker.launch', side_effect=launch_job), \
             patch('backend.research.worker.keep_running', side_effect=[True, False]) as poll, \
             patch('backend.research.worker.finish') as finish:
            supervise_pool(store, stopping)
        self.assertEqual(launched, ['0', '1', '2'])
        self.assertEqual(poll.call_count, 2)
        self.assertEqual(finish.call_args_list[0].args[1], jobs[1])
        self.assertEqual(finish.call_count, 3)

    @override_settings(RESEARCH_MAX_RUNNING=8)
    def test_configured_limit_is_enforced_across_database_connections(self):
        from concurrent.futures import ThreadPoolExecutor
        store = ResearchStore()
        for _ in range(10):
            store.create({})
        with ThreadPoolExecutor(max_workers=10) as pool:
            claims = list(pool.map(lambda _: store.claim(), range(10)))
        self.assertEqual(sum(claim is not None for claim in claims), 8)
