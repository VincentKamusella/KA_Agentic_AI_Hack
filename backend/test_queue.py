import json
import os
import subprocess
import sys
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from backend.jobs import execute_job, start_job
from backend.models import ResearchJob
from backend.research import LeaseLost, ResearchStore
from backend.requests import StageRequest
from backend.test_support import DemoDiscovery, DemoEvaluator, demo_fixture


@override_settings(ALLOWED_HOSTS=['testserver'], SECURE_SSL_REDIRECT=False)
class QueueTests(TransactionTestCase):
    def setUp(self):
        self.store = ResearchStore()
        self.payload = StageRequest.model_validate(demo_fixture()['request'])

    def expire(self, claim):
        ResearchJob.objects.filter(pk=claim['id']).update(lease_expires_at=timezone.now() - timedelta(seconds=1))

    def test_enqueue_without_provider_or_worker_and_recover_after_crash(self):
        with patch('backend.gemini.GeminiClient', side_effect=AssertionError('API must not call Gemini')):
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
        with patch('backend.research.MAX_PENDING', 2), ThreadPoolExecutor(max_workers=6) as pool:
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
        with patch('backend.gemini.GeminiClient'), patch('backend.discovery.GeminiDiscovery', return_value=DemoDiscovery()):
            token = start_job(self.store, self.payload, 'discover')
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
        payload = self.payload.model_dump(mode='json') | {'discovery_job_id': token}
        with patch('backend.evaluation.GeminiEvaluator', return_value=DemoEvaluator()), patch('backend.gemini.GeminiClient'):
            response = self.client.post('/api/research/', json.dumps(payload), content_type='application/json')
            self.assertEqual(response.status_code, 202)
            evaluation_token = response.json()['job_id']
            self.assertNotIn('suppliers', self.store.get(evaluation_token)['request'])
            claim = self.store.claim()
            execute_job(self.store, claim['id'], claim['lease_id'])
        result = self.store.get(evaluation_token)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['result']['recommended_supplier_ids'], ['alpha'])
        payload['suppliers'] = demo_fixture()['response']['suppliers']
        self.assertEqual(self.client.post('/api/research/', json.dumps(payload), content_type='application/json').status_code, 400)

    def test_evaluation_rejects_missing_pending_and_non_discovery_references(self):
        token = start_job(self.store, self.payload, 'discover')
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
        from backend.discovery import GeminiDiscovery, search_plan
        from backend.contracts import DiscoveryOptions
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
        with patch('backend.gemini.GeminiClient'), patch('backend.discovery.GeminiDiscovery', return_value=DemoDiscovery()), patch('backend.evaluation.GeminiEvaluator', return_value=DemoEvaluator()):
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

    def test_worker_supervisor_requeues_on_shutdown_and_terminates_child(self):
        import threading
        from backend.management.commands.research_worker import supervise
        token = self.store.create({})
        claim = self.store.claim()
        stop = threading.Event()
        stop.set()
        with patch('backend.management.commands.research_worker.subprocess.Popen') as popen, patch('backend.management.commands.research_worker.os.killpg') as kill:
            popen.return_value.poll.return_value = None
            supervise(self.store, claim, stop)
            kill.assert_called_once()
            popen.return_value.wait.assert_called_once()
        self.assertEqual(self.store.get(token)['status'], 'queued')

    def test_worker_supervisor_stops_child_after_losing_lease(self):
        import threading
        from backend.management.commands.research_worker import supervise
        token = self.store.create({})
        claim = self.store.claim()
        self.expire(claim)
        with patch('backend.management.commands.research_worker.subprocess.Popen') as popen, patch('backend.management.commands.research_worker.os.killpg') as kill, patch('backend.management.commands.research_worker.HEARTBEAT_SECONDS', 0):
            popen.return_value.poll.return_value = None
            supervise(self.store, claim, threading.Event())
            kill.assert_called_once()
        self.assertIsNotNone(self.store.claim())
