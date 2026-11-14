import asyncio
import json
from unittest.mock import patch
from django.test import SimpleTestCase, Client, override_settings

from backend.test_support import DemoDiscovery, DemoEvaluator, demo_fixture


@override_settings(ALLOWED_HOSTS=['testserver'], SECURE_SSL_REDIRECT=False,
                   STORAGES={'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'}})
class DeploymentSmokeTests(SimpleTestCase):
    def test_health(self):
        response = self.client.get('/health/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})

    def test_workspace(self):
        response = self.client.get('/')
        self.assertContains(response, 'Supplier workspace')
        self.assertIn('csrftoken', response.cookies)

    def test_admin_requires_login(self):
        response = self.client.get('/admin/')
        self.assertRedirects(response, '/admin/login/?next=/admin/', fetch_redirect_response=False)

    @patch("web.views.GeminiClient")
    @patch("web.views.GeminiDiscovery", return_value=DemoDiscovery())
    @patch("web.views.GeminiEvaluator", return_value=DemoEvaluator())
    def test_provider_workflow(self, *mocks):
        payload = demo_fixture()['request']
        discovery = self.client.post('/api/discover/', data=json.dumps(payload), content_type='application/json')
        self.assertEqual(discovery.status_code, 200)
        payload['suppliers'] = discovery.json()['suppliers']
        result = self.client.post('/api/evaluate/', data=json.dumps(payload), content_type='application/json')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['recommended_supplier_ids'], ['alpha'])
        self.assertNotIn('demo', result.json())

    def test_invalid_inputs(self):
        for data in ('invalid', '{}', 'null'):
            result = self.client.post('/api/discover/', data=data, content_type='application/json')
            self.assertEqual(result.status_code, 400)

    def test_csrf_required(self):
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.post('/api/discover/', data='{}',content_type='application/json').status_code,403)

    def test_missing_key_never_silently_uses_demo(self):
        with patch.dict('os.environ', {'GEMINI_API_KEY':'','GOOGLE_API_KEY':''}):
            payload = demo_fixture()['request']
            result = self.client.post('/api/discover/', data=json.dumps(payload), content_type='application/json')
            self.assertEqual(result.status_code, 502)
            self.assertIn('GEMINI_API_KEY', result.json()['error'])

    def test_slow_stage_returns_actionable_timeout(self):
        async def slow_discovery(*args, **kwargs):
            await asyncio.sleep(1)

        with patch('web.views.GeminiClient'), patch('web.views.STAGE_TIMEOUT_SECONDS', .001), patch(
            'web.views.GeminiDiscovery.discover_suppliers', side_effect=slow_discovery
        ):
            result = self.client.post('/api/discover/',
                                      data=json.dumps(demo_fixture()['request']),
                                      content_type='application/json')
            self.assertEqual(result.status_code, 504)
            self.assertIn('timed out', result.json()['error'])

    def test_demo_is_removed(self):
        self.assertEqual(self.client.get('/api/demo/').status_code, 404)
        self.assertNotContains(self.client.get('/'), 'Fictional demo')
        payload = {**demo_fixture()['request'], 'demo': True}
        result = self.client.post('/api/discover/', data=json.dumps(payload), content_type='application/json')
        self.assertEqual(result.status_code, 400)
