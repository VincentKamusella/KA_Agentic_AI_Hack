import json
import re
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from web.accounts import services
from web.accounts.models import SearchRecord

User = get_user_model()
PASSWORD = 'a-long-unusual-passphrase'
PLAIN = {'ALLOWED_HOSTS': ['testserver'], 'SECURE_SSL_REDIRECT': False,
         'STORAGES': {'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'}},
         'EMAIL_BACKEND': 'django.core.mail.backends.locmem.EmailBackend'}


class FakeStore:
    def __init__(self, jobs):
        self.jobs = jobs

    def get(self, token):
        return self.jobs.get(token)


@override_settings(**PLAIN)
class AccountPagesTests(TestCase):
    def test_sign_up_creates_an_account_signs_in_and_opens_the_workspace(self):
        response = self.client.post('/signup/', {'email': 'Buyer@Example.com', 'password': PASSWORD, 'password_again': PASSWORD})
        self.assertRedirects(response, '/app/')
        self.assertTrue(User.objects.filter(username='buyer@example.com', email='buyer@example.com').exists())

    def test_sign_up_rejects_duplicates_mismatches_and_weak_passwords(self):
        User.objects.create_user('buyer@example.com', 'buyer@example.com', PASSWORD)
        for data, message in [
            ({'email': 'BUYER@example.com', 'password': PASSWORD, 'password_again': PASSWORD}, 'already exists'),
            ({'email': 'new@example.com', 'password': PASSWORD, 'password_again': 'different'}, 'do not match'),
            ({'email': 'new@example.com', 'password': '12345678', 'password_again': '12345678'}, 'password'),
        ]:
            response = self.client.post('/signup/', data)
            self.assertContains(response, message, status_code=400)
        self.assertEqual(User.objects.count(), 1)

    def test_sign_in_is_case_insensitive_and_does_not_reveal_which_part_was_wrong(self):
        User.objects.create_user('buyer@example.com', 'buyer@example.com', PASSWORD)
        wrong = self.client.post('/signin/', {'email': 'buyer@example.com', 'password': 'nope'})
        unknown = self.client.post('/signin/', {'email': 'nobody@example.com', 'password': PASSWORD})
        for response in (wrong, unknown):
            self.assertContains(response, 'email address or password is not correct', status_code=400)
        self.assertRedirects(self.client.post('/signin/', {'email': 'Buyer@Example.com', 'password': PASSWORD}), '/app/')

    def test_sign_in_returns_to_local_pages_only(self):
        User.objects.create_user('buyer@example.com', 'buyer@example.com', PASSWORD)
        data = {'email': 'buyer@example.com', 'password': PASSWORD, 'next': 'https://evil.example/'}
        self.assertRedirects(self.client.post('/signin/', data), '/app/')

    def test_sign_out_needs_post_and_returns_to_the_landing_page(self):
        self.client.force_login(User.objects.create_user('buyer@example.com', 'buyer@example.com', PASSWORD))
        self.assertEqual(self.client.get('/signout/').status_code, 405)
        self.assertRedirects(self.client.post('/signout/'), '/')
        self.assertEqual(self.client.get('/app/').status_code, 302)

    def test_forgot_password_sends_a_single_use_link_only_to_existing_accounts(self):
        User.objects.create_user('buyer@example.com', 'buyer@example.com', PASSWORD)
        self.assertRedirects(self.client.post('/password/forgot/', {'email': 'nobody@example.com'}), '/password/forgot/sent/')
        self.assertEqual(len(mail.outbox), 0)
        self.assertRedirects(self.client.post('/password/forgot/', {'email': 'buyer@example.com'}), '/password/forgot/sent/')
        link = re.search(r'http://testserver(/password/reset/\S+)', mail.outbox[0].body).group(1)
        form_url = self.client.get(link).url  # Django moves the token into the session.
        new = 'another-long-unusual-phrase'
        self.assertRedirects(self.client.post(form_url, {'new_password1': new, 'new_password2': new}), '/password/reset/done/')
        self.assertTrue(self.client.login(username='buyer@example.com', password=new))
        self.assertContains(self.client.get(link), 'no longer works')


@override_settings(**PLAIN)
class OwnershipTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user('owner@example.com', 'owner@example.com', PASSWORD)
        self.other = User.objects.create_user('other@example.com', 'other@example.com', PASSWORD)
        self.token = 'a' * 64
        self.jobs = {self.token: {
            'job_id': self.token, 'status': 'completed', 'error': None,
            'request': {'requirements': {'product': 'Steel bolts'}, 'stage': 'research'},
            'result': {'suppliers': [{'supplier_id': 'alpha', 'name': 'Example Alpha', 'website': 'https://alpha.example/'}],
                       'assessments': [{'supplier_id': 'alpha', 'eligibility': 'eligible'}],
                       'recommended_supplier_ids': ['alpha']}}}
        services.record_search(self.owner, self.token, 'Steel bolts')
        patcher = patch('backend.persistence.store.ResearchStore', return_value=FakeStore(self.jobs))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_starting_research_records_it_for_the_account(self):
        self.client.force_login(self.other)
        payload = {'requirements': {'product': 'Containers', 'quantity': 5, 'delivery_country': 'Germany'}}
        with patch('backend.research.jobs.start_job', return_value='b' * 64):
            response = self.client.post('/api/research/', data=json.dumps(payload), content_type='application/json')
        self.assertEqual(response.status_code, 202)
        self.assertTrue(SearchRecord.objects.filter(user=self.other, job_token='b' * 64, product='Containers').exists())

    def test_a_job_is_visible_to_its_owner_only(self):
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get(f'/api/research/{self.token}/').status_code, 200)
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(f'/api/research/{self.token}/').status_code, 404)

    def test_saved_evidence_cannot_be_reused_by_another_account(self):
        self.client.force_login(self.other)
        payload = {'requirements': {'product': 'Steel bolts', 'quantity': 5, 'delivery_country': 'Germany'},
                   'discovery_job_id': self.token}
        with patch('backend.research.jobs.start_job', return_value='b' * 64) as start:
            response = self.client.post('/api/research/', data=json.dumps(payload), content_type='application/json')
        self.assertEqual(response.status_code, 400)
        start.assert_not_called()

    def test_history_and_old_suppliers_list_only_the_accounts_own_research(self):
        self.client.force_login(self.owner)
        [search] = self.client.get('/api/history/').json()['searches']
        self.assertEqual((search['product'], search['status'], search['suppliers'], search['shortlisted']),
                         ('Steel bolts', 'completed', 1, 1))
        [supplier] = self.client.get('/api/suppliers/').json()['suppliers']
        self.assertEqual((supplier['name'], supplier['searches'], supplier['last_eligibility'], supplier['last_job_id']),
                         ('Example Alpha', 1, 'eligible', self.token))
        self.client.force_login(self.other)
        self.assertEqual(self.client.get('/api/history/').json(), {'searches': []})
        self.assertEqual(self.client.get('/api/suppliers/').json(), {'suppliers': []})

    def test_a_supplier_seen_twice_is_listed_once_with_its_latest_result(self):
        newer = 'c' * 64
        self.jobs[newer] = {**self.jobs[self.token], 'job_id': newer, 'result': {
            **self.jobs[self.token]['result'], 'assessments': [{'supplier_id': 'alpha', 'eligibility': 'ineligible'}]}}
        services.record_search(self.owner, newer, 'Steel nuts')
        [supplier] = services.known_suppliers(self.owner, FakeStore(self.jobs))
        self.assertEqual((supplier['searches'], supplier['last_eligibility'], supplier['last_product']),
                         (2, 'ineligible', 'Steel nuts'))

    def test_preferences_are_saved_per_account_and_validated(self):
        self.client.force_login(self.owner)
        body = {'quantity_unit': ' kg ', 'delivery_area': {'type': 'world'}, 'other_requirements': 'ISO 9001 required'}
        saved = self.client.put('/api/preferences/', data=json.dumps(body), content_type='application/json')
        self.assertEqual(saved.json(), {'quantity_unit': 'kg', 'delivery_area': {'type': 'world'},
                                        'other_requirements': 'ISO 9001 required'})
        for bad in [{**body, 'quantity_unit': 'x' * 41}, {**body, 'delivery_area': {'type': 'moon'}}, {'quantity_unit': 'kg'}]:
            response = self.client.put('/api/preferences/', data=json.dumps(bad), content_type='application/json')
            self.assertEqual(response.status_code, 400)
        self.client.force_login(self.other)
        self.assertEqual(self.client.get('/api/preferences/').json(),
                         {'quantity_unit': '', 'delivery_area': None, 'other_requirements': ''})


class TestAccountCommandTests(TestCase):
    @override_settings(DEBUG=False)
    def test_refuses_outside_local_development(self):
        with self.assertRaises(CommandError):
            call_command('create_test_account')
        self.assertFalse(User.objects.exists())

    @override_settings(DEBUG=True)
    def test_creates_a_working_account_and_can_be_repeated(self):
        call_command('create_test_account', verbosity=0)
        call_command('create_test_account', verbosity=0)
        self.assertTrue(self.client.login(username='test@quotepilot.local', password='quotepilot-test'))
