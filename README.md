# QuotePilot

Discover suppliers, evaluate source evidence against purchase criteria, and build a shortlist.

## Run locally

Requires Python 3.12, [uv](https://docs.astral.sh/uv/), Docker Compose, and a Gemini API key.

```sh
uv sync --locked
cp .env.example .env  # First setup only.
```

Set `GEMINI_API_KEY` in `.env`, then start the app:

```sh
docker compose up -d --wait db
uv run python -m web.manage migrate
uv run python -m web.manage runserver
```

In a second terminal, start the research worker:

```sh
uv run python -m web.manage research_worker
```

Open http://127.0.0.1:8000/ and create an account, or create the local test account (`test@quotepilot.local` / `quotepilot-test`, refused unless `DJANGO_DEBUG` is true):

```sh
uv run python -m web.manage create_test_account
```

Sign in, enter your purchase brief, and choose **Find my shortlist**. Password-reset emails are written to the server log; no mail service is configured.

To look at the interface without Gemini, PostgreSQL, or a worker, run `uv run python scripts/preview_ui.py` (fictional data, http://127.0.0.1:8001/).

## Development

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
bash scripts/check.sh
```

Database tests require a PostgreSQL role that can create test databases.

See [DESIGN.md](DESIGN.md) for UI conventions and [backend/README.md](backend/README.md) for team responsibilities. Codesphere setup is in `ci.yml` and `scripts/`.
