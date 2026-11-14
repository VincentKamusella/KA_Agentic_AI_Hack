# QuotePilot

Supplier discovery → evidence evaluation → explainable shortlist, built with Django and Python. This first version follows the supplier-discovery workflow; it does not implement the older quotation-upload proposal.

## Run locally

Requires Python 3.12, [uv](https://docs.astral.sh/uv/), and Docker Compose for the existing admin/database setup.

```sh
uv sync --locked
cp .env.example .env  # First setup only; preserve existing configuration.
docker compose up -d --wait db
uv run python -m web.manage migrate
uv run python -m web.manage runserver
```

Open http://127.0.0.1:8000/. Enter your purchase brief and criteria, click **Discover suppliers**, then **Evaluate suppliers**. All searches use Gemini; configure your key first.

For a stateless local product preview without a running database (admin still needs PostgreSQL):

```sh
uv run python -m web.manage collectstatic --noinput
uv run gunicorn web.config.wsgi:application --bind 127.0.0.1:8000 --timeout 240
```

The existing Django environment settings are still required. Results live in browser memory and disappear on reload.

## Live Gemini mode

Set `GEMINI_API_KEY` in the server environment or local ignored `.env`, restart the server. Add this line to the project-root `.env` (preserving its existing Django/database settings):

```dotenv
GEMINI_API_KEY=your-key-here
```

On Codesphere, set `GEMINI_API_KEY` in the workspace environment and restart the app. `GOOGLE_API_KEY` is also accepted. Never expose either key in browser code. The key must have access to `gemini-4-hydrogen` and `gemini-decision-1` on the `v1beta` API. `GEMINI_DISCOVERY_MODEL` optionally overrides the discovery model.

1. **Discovery:** Gemini Interactions with Google Search returns cited supplier-site summaries. Only text spans with provider citation URLs become evidence. Candidate IDs are stable hashes of source hostnames; duplicate excerpts are removed. Names currently display source hostnames.
2. **Eval:** Gemini Decisions evaluates each criterion against each evidence excerpt with a `choice` question: pass / fail / unknown. Decisions below the provisional 0.85 confidence threshold abstain. Conflicting explicit evidence also becomes unknown. Malformed or missing answers create a supplier-specific issue, never a fake compliance failure.
3. **UI / shortlist:** deterministic code enforces mandatory gates and ranks eligible suppliers by weighted preference attainment, evidence coverage, then supplier ID. At most three are shortlisted. Pass preferences earn 100 points; failed or unknown preferences earn zero; all preference weights remain in the denominator. With no mandatory criteria, the UI explicitly labels the shortlist as preference-only.

The integration uses the documented REST APIs directly, avoiding an additional SDK dependency:
[Decisions API](https://aistudio.google.com/docs/decisions-api),
[Google Search grounding](https://aistudio.google.com/docs/google-search).

## Try a scenario

Change a criterion or its mandatory/preference type, then click **Re-evaluate suppliers** to assess the existing source evidence again.

Expand a supplier to inspect assessments, source excerpts, links, and clarification drafts for unknown criteria. Drafts are deterministic text for review/copy; nothing is sent.

## API and boundaries

- `GET /` — workspace; sets a CSRF cookie.
- `GET /health/` — process health (`{"status":"ok"}`).
- `POST /api/discover/` — `{requirements, options?}`.
- `POST /api/evaluate/` — `{requirements, suppliers, options?}`.

POST endpoints require Django's CSRF token. They accept the shared Pydantic contracts and reject invalid inputs. The product API limits a stage to six suppliers, five evidence excerpts each, and twelve criteria; requests are capped at 500 KB. Evaluation runs at most three supplier API calls concurrently. Stages have a 180-second deadline; the deployment worker timeout is 240 seconds.

**Current limitations:** citation excerpts are AI-generated summaries, not independently fetched or verified quotations. Supplier identity and source authenticity require human review. Quantity and destination are discovery context unless explicitly included as criteria. No price arithmetic, order-specific delivery guarantees, quotation uploads, storage, authentication, or public-service rate limiting are implemented. Deploy this hackathon prototype behind workspace access controls, not as an unrestricted public API. API failure never silently switches to fictional data. The confidence threshold has not been calibrated on customer examples.

## Checks

The UI uses locally served **Bootstrap 5.3.9** components with one dark workspace theme (charcoal, off-white, and blue). Forms, buttons, status badges, alerts, tables, and evidence accordions share the same component system. See [DESIGN.md](DESIGN.md) for conventions. To update/rebuild frontend dependencies (Node is only needed for development):

```sh
npm ci --ignore-scripts
npm run build
npm run check
```

Pinned compiled Bootstrap assets and its license are included in `web/static/vendor/bootstrap/`, so Codesphere only needs the existing Python/static-files pipeline.

```sh
uv run python -m unittest backend.tests backend.test_evaluation
uv run python -m web.manage test web
node --check web/static/web/app.js
bash scripts/check.sh  # Also checks PostgreSQL migrations.
```

The tests cover mandatory failures, unknowns, conflicting evidence, confidence abstention, malformed provider responses, source deduplication, preference weights, scenario changes, CSRF, and the mocked provider HTTP workflow. Live provider access must be verified separately with a configured key.

## Team and deployment

See [backend interfaces](backend/README.md) for module ownership. Existing Codesphere configuration is in `ci.yml` and `scripts/`. Configure database, Gemini, and production Django environment variables, then run Prepare → Test → Run. Health checks now use `/health/`; `/` serves the app. This implementation does not push, merge, or deploy automatically.
