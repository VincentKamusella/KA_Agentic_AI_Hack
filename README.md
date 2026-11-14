# QuotePilot

Development and deployment foundation only; no product features are implemented.

- `backend/` — Python package for future business logic and integrations.
- `web/` — Django configuration, admin, health response, and smoke tests.
- `ci.yml` / `scripts/` — Codesphere Prepare, Test, and Run stages.
- `compose.yaml` — local PostgreSQL service with persistent storage.

## Local development

Install [uv](https://docs.astral.sh/uv/) and Docker with Compose. From the repository root:

```sh
uv sync --locked
cp .env.example .env  # Only on first setup; preserve an existing .env.
docker compose up -d --wait db
uv run python -m web.manage migrate
uv run python -m web.manage runserver
```

Open http://127.0.0.1:8000/. Use `uv run python -m web.manage createsuperuser` for admin access.
If you already run PostgreSQL locally, create a database and set `DATABASE_URL` in
`.env` instead of using Compose. Python 3.12 is selected by `.python-version`.

The Compose credentials are for local development only. The port is bound to
localhost. `docker compose down` preserves data in the named volume; do not add
`--volumes` unless you intend to delete it. No SQLite fallback or data conversion
is provided; the previous starter database is no longer used.

```sh
bash scripts/check.sh
```

Checks verify Django configuration, migration consistency/applied status, and HTTP
smoke tests. Smoke tests do not create or modify a test database. Future database
tests should run against a separate test service, never production credentials.
The `/` health endpoint checks process availability, not database readiness.

## Codesphere

Target workspace: [691176](https://cloud.codesphere.com/ide/resource-groups/420/workspaces/691176).
The repository configuration is prepared; the remote workspace has not been
changed or deployed from this session.

### One-time workspace configuration

1. Provision or connect a PostgreSQL service, create the application database,
   and obtain its connection URL. This pipeline does not create a managed service.
   The database user needs permission to apply migrations in that database.
2. Set these values in the workspace environment settings:

| Variable | Deployment value |
| --- | --- |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@HOST:PORT/DATABASE` plus provider-required TLS options |
| `DJANGO_SECRET_KEY` | A unique random secret; do not use the local example |
| `DJANGO_DEBUG` | `false` |
| `DJANGO_ALLOWED_HOSTS` | Actual deployment hostname, without scheme or path |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | Actual `https://` deployment origin |
| `DJANGO_TRUST_PROXY` | `true` only after confirming the ingress overwrites `X-Forwarded-Proto` |
| `DJANGO_SSL_REDIRECT` | `true` once HTTPS and proxy handling are confirmed; otherwise enforce HTTPS at ingress |
| `WEB_CONCURRENCY` | Optional; defaults to `2` |

Use the deployment hostname from Codesphere's **Open Deployment**, not the IDE
URL. Percent-encode special characters in database URL credentials. Preserve the
provider's TLS parameters (for example `sslmode=verify-full` and its CA configuration).
Do not copy local `.env` credentials to Codesphere or commit secrets.

3. Push these files to the connected GitHub branch and pull them in the workspace.
4. Open the Landscape Config Editor and select an available resource plan for
   the `django` service. `ci.yml` uses Landscape schema `v0.4`; the optional
   installation-specific plan ID is intentionally not hard-coded. Apply/sync
   the configuration, then run **Prepare → Test → Run**. Editing and deploying
   require write access; the Viewer role cannot perform these actions.
5. Open the deployment and confirm `/` returns `{"status":"ok"}` and `/admin/`
   has styling. Run `.venv/bin/python -m web.manage check --deploy` in the workspace
   and review the HTTPS/HSTS settings for the actual ingress before production use.

### What the pipeline does

- **Prepare:** installs uv via Codesphere's Nix environment if needed; uses uv to
  select Python 3.12 and install locked dependencies; checks Django; collects
  static assets; runs smoke tests; applies migrations to the configured database.
- **Test:** checks configuration, missing/unapplied migrations, and HTTP behavior.
- **Run:** starts Gunicorn on `0.0.0.0:3000`. WhiteNoise serves collected static
  assets, including Django admin CSS. The `django` service has one replica and
  routes `/` through the workspace router to port 3000, preserving request paths.
  The workspace is mounted at `/home/user/app` so the service can access the
  prepared `.venv`, `.codesphere/python`, and static assets. Logs go to stdout/stderr.

Python downloads and uv caches live under ignored `.codesphere/` on the workspace
disk. A network connection is needed on first install. Run Prepare before Run
when dependencies or static files change. Run migrations once per release; do
not run concurrent Prepare stages against the same database.

### Automatic deployments

The pipeline is ready to run in Codesphere, but no push/merge trigger has been
configured or verified. The GitHub connection alone does not establish that.
Configure the intended branch's deployment automation to pull the new revision,
run Prepare, wait for success, run Test, wait for success, and restart Run.
Codesphere's CLI/API can orchestrate these stages; keep its token in the automation
secret store. Stop deployment on failures. Verify the trigger with a small commit.

References: [official Landscape pipeline reference](https://github.com/codesphere-cloud/cs-go/blob/main/cli/cmd/install/skills/codesphere/references/ci-pipeline.md),
[CI pipelines](https://codesphere.ghost.io/ci-pipelines/),
[automation API](https://docs.codesphere.com/apis-and-automations/public-api).
