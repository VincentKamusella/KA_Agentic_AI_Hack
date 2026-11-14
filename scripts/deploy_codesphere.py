"""Deploy a CI-tested commit to an existing Codesphere workspace."""
import json
import os
import re
import shlex
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class DeploymentError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Deployer:
    def __init__(self, workspace, token, api='https://cloud.codesphere.com/api'):
        if not re.fullmatch(r'[0-9]+', workspace) or not token:
            raise DeploymentError('Set CODESPHERE_WORKSPACE_ID and the CODESPHERE_API_TOKEN secret.')
        parsed = urlsplit(api)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise DeploymentError('Codesphere API must be an HTTPS base URL without credentials or query parameters.')
        self.workspace, self.token, self.api = workspace, token, api.rstrip('/')

    def cli(self, *args):
        subprocess.run(['cs', *args], check=True, timeout=1200, env={
            **os.environ, 'CS_WORKSPACE_ID': self.workspace, 'CS_TOKEN': self.token, 'CS_API': self.api,
        })

    def remote(self, command):
        self.cli('exec', '--workdir', '/home/user/app', '--', command)

    def states(self):
        request = Request(f'{self.api}/workspaces/{self.workspace}/pipeline/run',
                          headers={'Authorization': f'Bearer {self.token}',
                                   # The gateway rejects Python's default urllib user agent.
                                   'User-Agent': 'QuotePilot-Deploy/1.0',
                                   'Accept': 'application/json'})
        try:
            with build_opener(NoRedirect()).open(request, timeout=20) as response:
                rows = json.load(response)
        except HTTPError as exc:
            raise DeploymentError(f'Codesphere status request failed with HTTP {exc.code}.') from None
        except (URLError, TimeoutError, ValueError):
            raise DeploymentError('Could not read Codesphere pipeline status.') from None
        if not isinstance(rows, list) or any(not isinstance(row, dict) or 'server' not in row or 'state' not in row for row in rows):
            raise DeploymentError('Codesphere returned an unexpected pipeline status format.')
        return [row for row in rows if row['server'] != 'codesphere-ide']

    def wait(self, *, running, timeout=300):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            rows = self.states()
            if running:
                if any(row['state'] in ('failure', 'aborted') for row in rows):
                    raise DeploymentError('A Codesphere service failed to start. Inspect its deployment logs.')
                counts = {server: len({row.get('replica') for row in rows
                          if row['server'] == server and row['state'] == 'running'})
                          for server in ('web', 'worker')}
                if counts['web'] == 1 and counts['worker'] == 2:
                    return
            elif all(row['state'] in ('idle', 'stopped', 'success', 'failure', 'aborted') for row in rows):
                return
            time.sleep(5)
        raise DeploymentError('Timed out waiting for Codesphere services to ' + ('start.' if running else 'stop.'))

    def deploy(self, sha):
        if not re.fullmatch(r'[a-f0-9]{40}', sha):
            raise DeploymentError('Expected a full commit SHA from a successful main-branch CI run.')
        # Check before stopping anything. Ignored secrets, caches, and data are untouched.
        self.remote('set -eu; test "$(git branch --show-current)" = main; '
                    'test -z "$(git status --porcelain)" || '
                    '{ echo "Workspace has local changes. Preserve and reconcile them before deploying." >&2; exit 1; }; '
                    f'git fetch origin main; git cat-file -e {sha}^{{commit}}; '
                    f'git merge-base --is-ancestor HEAD {sha}; '
                    f'git merge-base --is-ancestor {sha} origin/main')
        database_check = (
            'from django.db import connection\n'
            'try:\n    connection.ensure_connection()\n'
            'except Exception:\n    raise SystemExit("Database connection failed. Fix DATABASE_URL before deploying.")\n'
            'print("Database connection verified.")'
        )
        self.remote('export PATH="$HOME/.nix-profile/bin:$PATH"; '
                    'if command -v uv >/dev/null 2>&1 && test -f .venv/pyvenv.cfg; then '
                    'uv run --no-sync python -m web.manage shell -c ' + shlex.quote(database_check) + '; fi')
        # Verify status access and response parsing before causing downtime.
        self.states()
        self.cli('stop', 'pipeline', 'run')
        self.wait(running=False)
        # Recheck after stopping to detect edits made while the preflight ran.
        self.remote('set -eu; test -z "$(git status --porcelain)"; '
                    f'git merge --ff-only {sha}; test "$(git rev-parse HEAD)" = {sha}')
        self.cli('sync', 'landscape')
        self.cli('start', 'pipeline', '--timeout', '15m', 'prepare', 'test', 'run')
        self.wait(running=True)
        # Probe each service's internal endpoint from the workspace, without exposing the worker.
        for service in ('web', 'worker'):
            url = f'http://ws-server-{self.workspace}-{service}.workspaces:3000/health/'
            self.remote('curl --fail --silent --show-error --retry 12 --retry-all-errors '
                        '--retry-delay 5 --max-time 10 -H "Host: localhost" ' + shlex.quote(url))
        print(f'Deployed {sha} to Codesphere workspace {self.workspace}.')


def main():
    try:
        deployer = Deployer(os.getenv('CODESPHERE_WORKSPACE_ID', ''), os.getenv('CODESPHERE_API_TOKEN', ''),
                            os.getenv('CODESPHERE_API_URL') or 'https://cloud.codesphere.com/api')
        deployer.deploy(os.getenv('DEPLOY_SHA', ''))
    except (DeploymentError, subprocess.SubprocessError) as exc:
        print(f'Deployment failed: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
