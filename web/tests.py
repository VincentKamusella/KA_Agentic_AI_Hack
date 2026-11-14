import json
from unittest.mock import patch
from django.test import SimpleTestCase, Client, override_settings

from backend.tests.support import demo_fixture


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

    def test_old_stage_routes_are_removed(self):
        for route in ['/api/discover/', '/api/evaluate/', '/api/evaluate-jobs/']:
            self.assertEqual(self.client.post(route, data='{}', content_type='application/json').status_code, 404)

    def test_invalid_inputs(self):
        for data in ('invalid', '{}', 'null'):
            result = self.client.post('/api/research/', data=data, content_type='application/json')
            self.assertEqual(result.status_code, 400)

    def test_csrf_required(self):
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.post('/api/research/', data='{}',content_type='application/json').status_code,403)

    def test_demo_is_removed(self):
        self.assertEqual(self.client.get('/api/demo/').status_code, 404)
        self.assertNotContains(self.client.get('/'), 'Fictional demo')
        payload = {**demo_fixture()['request'], 'demo': True}
        result = self.client.post('/api/research/', data=json.dumps(payload), content_type='application/json')
        self.assertEqual(result.status_code, 400)


@override_settings(ALLOWED_HOSTS=['testserver'], SECURE_SSL_REDIRECT=False)
class ResearchApiTests(SimpleTestCase):
    def test_simple_brief_is_queued_without_criteria(self):
        payload = {'requirements': {'product': 'Containers', 'quantity': 2.5,
            'quantity_unit': 'kg', 'delivery_country': 'Germany', 'needed_by': None,
            'other_requirements': 'EU manufacturing required'}}
        with patch('backend.research.jobs.start_job', return_value='a' * 64) as start, patch('backend.persistence.store.ResearchStore'):
            response = self.client.post('/api/research/', data=json.dumps(payload), content_type='application/json')
        self.assertEqual(response.status_code, 202)
        self.assertEqual(start.call_args.args[1].requirements.criteria, [])
        self.assertEqual(start.call_args.args[1].requirements.quantity_unit, 'kg')

    def test_field_errors_do_not_echo_submitted_values(self):
        payload = {'requirements': {'product': 'Private product', 'quantity': -1, 'delivery_country': 'Germany'}}
        response = self.client.post('/api/research/', data=json.dumps(payload), content_type='application/json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()['fields'][0]['path'], 'requirements.quantity')
        self.assertNotIn('Private product', response.content.decode())

    def test_background_discovery_accepts_larger_budgets(self):
        payload = demo_fixture()['request']
        payload['options'] = {'max_suppliers': 100, 'max_pages_per_supplier': 20, 'max_queries': 24}
        with patch('backend.research.jobs.start_job', return_value='a' * 64) as start, patch('backend.persistence.store.ResearchStore'):
            response = self.client.post('/api/research/', data=json.dumps(payload), content_type='application/json')
        self.assertEqual(response.status_code, 202)
        self.assertEqual(start.call_args.args[1].options.max_suppliers, 100)

    def test_background_endpoints_require_csrf(self):
        client = Client(enforce_csrf_checks=True)
        for url in ['/api/research/']:
            self.assertEqual(client.post(url, data='{}', content_type='application/json').status_code, 403)

    def test_status_is_private_and_missing_jobs_return_404(self):
        with patch('backend.persistence.store.ResearchStore') as store:
            store.return_value.get.return_value = None
            self.assertEqual(self.client.get('/api/research/unknown/').status_code, 404)
            store.return_value.get.return_value = {'status': 'completed', 'result': {'suppliers': []}}
            response = self.client.get('/api/research/' + 'a' * 64 + '/')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response['Cache-Control'], 'no-store')

    def test_concurrency_capacity_returns_actionable_error(self):
        with patch('backend.research.jobs.start_job', side_effect=RuntimeError('Research queue is full. Try again later.')):
            response = self.client.post('/api/research/', data=json.dumps(demo_fixture()['request']), content_type='application/json')
        self.assertEqual(response.status_code, 429)

    def test_search_scope_validation(self):
        for options in [{'max_queries': 25}, {'countries': ['']}, {'languages': ['x'] * 9}]:
            payload = demo_fixture()['request'] | {'options': options}
            response = self.client.post('/api/research/', data=json.dumps(payload), content_type='application/json')
            self.assertEqual(response.status_code, 400)


@override_settings(ALLOWED_HOSTS=['testserver'], SECURE_SSL_REDIRECT=False,
                   DATA_UPLOAD_MAX_MEMORY_SIZE=100)
class BodyLimitTests(SimpleTestCase):
    def test_oversized_body_returns_json_413_for_both_api_styles(self):
        for endpoint in ('/api/research/',):
            response = self.client.post(endpoint, data='x' * 101, content_type='application/json')
            self.assertEqual(response.status_code, 413)
            self.assertEqual(response.json()['error'], 'Request is too large.')
