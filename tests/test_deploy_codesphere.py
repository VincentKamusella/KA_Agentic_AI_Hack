import io
import subprocess
from urllib.error import HTTPError, URLError
import unittest
from unittest.mock import patch

from scripts.deploy_codesphere import Deployer, DeploymentError

SHA = 'a' * 40


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.deployer = Deployer('691176', 'test-token')

    def test_missing_credentials_and_invalid_target_rejected(self):
        for workspace, token, api in [('691176', '', 'https://cloud.codesphere.com/api'),
                                      ('1;echo bad', 'token', 'https://cloud.codesphere.com/api'),
                                      ('691176', 'token', 'http://cloud.codesphere.com/api'),
                                      ('691176', 'token', 'https:///api')]:
            with self.subTest(workspace=workspace, api=api), self.assertRaises(DeploymentError):
                Deployer(workspace, token, api)

    def test_untrusted_sha_never_reaches_remote_shell(self):
        with patch.object(self.deployer, 'cli') as cli, self.assertRaises(DeploymentError):
            self.deployer.deploy('main; echo bad')
        cli.assert_not_called()

    def test_dirty_workspace_does_not_stop_services(self):
        with patch.object(self.deployer, 'remote', side_effect=subprocess.CalledProcessError(1, 'cs')), patch.object(self.deployer, 'cli') as cli:
            with self.assertRaises(subprocess.CalledProcessError):
                self.deployer.deploy(SHA)
            cli.assert_not_called()

    def test_status_request_identifies_client_and_preserves_authentication(self):
        body = b'[{"server":"codesphere-ide","state":"running"},{"server":"web","state":"stopped"}]'
        with patch('scripts.deploy_codesphere.build_opener') as opener:
            opener.return_value.open.return_value = io.BytesIO(body)
            self.assertEqual(self.deployer.states(), [{'server': 'web', 'state': 'stopped'}])
        request = opener.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://cloud.codesphere.com/api/workspaces/691176/pipeline/run')
        self.assertEqual(request.get_header('User-agent'), 'QuotePilot-Deploy/1.0')
        self.assertEqual(request.get_header('Authorization'), 'Bearer test-token')
        self.assertEqual(request.get_header('Accept'), 'application/json')
        self.assertEqual(opener.return_value.open.call_args.kwargs['timeout'], 20)

    def test_status_preflight_failure_never_stops_services(self):
        failures = [HTTPError('https://cloud.codesphere.com/api', 403, 'Forbidden', {}, None),
                    URLError('unreachable'), ValueError('invalid JSON')]
        for failure in failures:
            with self.subTest(failure=failure), patch.object(self.deployer, 'remote'), \
                 patch.object(self.deployer, 'cli') as cli, \
                 patch('scripts.deploy_codesphere.build_opener') as opener:
                opener.return_value.open.side_effect = failure
                with self.assertRaises(DeploymentError):
                    self.deployer.deploy(SHA)
                cli.assert_not_called()

    def test_malformed_status_preflight_never_stops_services(self):
        with patch.object(self.deployer, 'remote'), patch.object(self.deployer, 'cli') as cli, \
             patch('scripts.deploy_codesphere.build_opener') as opener:
            opener.return_value.open.return_value = io.BytesIO(b'{"unexpected":true}')
            with self.assertRaisesRegex(DeploymentError, 'unexpected pipeline status'):
                self.deployer.deploy(SHA)
            cli.assert_not_called()

    def test_deployment_orders_stop_update_sync_prepare_start_health(self):
        events = []
        with patch.object(self.deployer, 'remote', side_effect=lambda command: events.append(('remote', command))), patch.object(self.deployer, 'cli', side_effect=lambda *args: events.append(('cli', args))), patch.object(self.deployer, 'wait', side_effect=lambda **kwargs: events.append(('wait', kwargs))), patch.object(self.deployer, 'states', side_effect=lambda: events.append(('states', None))):
            self.deployer.deploy(SHA)
        self.assertIn('git status --porcelain', events[0][1])
        self.assertIn('Database connection failed', events[1][1])
        self.assertEqual(events[2], ('states', None))
        self.assertEqual(events[3], ('cli', ('stop', 'pipeline', 'run')))
        self.assertEqual(events[4], ('wait', {'running': False}))
        self.assertIn('git merge --ff-only ' + SHA, events[5][1])
        self.assertEqual(events[6], ('cli', ('sync', 'landscape')))
        self.assertEqual(events[7], ('cli', ('start', 'pipeline', '--timeout', '15m', 'prepare', 'test', 'run')))
        self.assertEqual(events[8], ('wait', {'running': True}))
        self.assertIn('-web.workspaces:3000/health/', events[9][1])
        self.assertIn('-worker.workspaces:3000/health/', events[10][1])

    def test_failed_prepare_never_reports_healthy(self):
        def command(*args):
            if args[0] == 'start':
                raise subprocess.CalledProcessError(1, 'cs')
        with patch.object(self.deployer, 'remote') as remote, patch.object(self.deployer, 'cli', side_effect=command), patch.object(self.deployer, 'wait'), patch.object(self.deployer, 'states', return_value=[]), self.assertRaises(subprocess.CalledProcessError):
            self.deployer.deploy(SHA)
        self.assertEqual(remote.call_count, 3)

    def test_readiness_requires_both_worker_replicas(self):
        web = {'server': 'web', 'replica': 'web-0', 'state': 'running'}
        worker = {'server': 'worker', 'replica': 'worker-0', 'state': 'running'}
        ready = [web, worker, {**worker, 'replica': 'worker-1'}]
        with patch.object(self.deployer, 'states', side_effect=[[], [web, worker, worker], ready]) as states, patch('scripts.deploy_codesphere.time.sleep'):
            self.deployer.wait(running=True)
        self.assertEqual(states.call_count, 3)

    def test_stopping_waits_until_all_services_are_stopped(self):
        with patch.object(self.deployer, 'states', side_effect=[[{'state': 'running'}], [{'state': 'stopped'}]]) as states, patch('scripts.deploy_codesphere.time.sleep'):
            self.deployer.wait(running=False)
        self.assertEqual(states.call_count, 2)

    def test_failed_service_is_not_success(self):
        with patch.object(self.deployer, 'states', return_value=[{'server': 'worker', 'state': 'failure'}]), self.assertRaises(DeploymentError):
            self.deployer.wait(running=True)

    def test_status_timeout_is_bounded(self):
        with patch.object(self.deployer, 'states', return_value=[]), patch('scripts.deploy_codesphere.time.monotonic', side_effect=[0, 0, 301]), patch('scripts.deploy_codesphere.time.sleep'), self.assertRaises(DeploymentError):
            self.deployer.wait(running=True)
