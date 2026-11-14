# QuotePilot

Supplier discovery and recommendations, built with Python and Django.

## Development

Requires [uv](https://docs.astral.sh/uv/) and Docker Compose.

```sh
uv sync --locked
cp .env.example .env  # First setup only; preserve existing configuration.
docker compose up -d --wait db
uv run python -m web.manage migrate
uv run python -m web.manage runserver
```

Open http://127.0.0.1:8000/. Configuration is documented in `.env.example`.

## Checks

```sh
uv run python -m unittest backend.tests
bash scripts/check.sh  # Requires PostgreSQL.
```

## Team and deployment

See [backend interfaces](backend/README.md) for team ownership.
Codesphere deployment is configured in `ci.yml` and `scripts/`.
Configure database and production environment variables before running
Prepare → Test → Run. Deployment automation must be configured separately.
