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

Open http://127.0.0.1:8000/. Enter your purchase brief and criteria, choose **Discover suppliers**, then **Evaluate suppliers**.

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
