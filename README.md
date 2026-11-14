# QuotePilot

**Turn a plain-language purchase brief into an evidence-backed supplier shortlist.**

QuotePilot helps procurement teams go from *"what we need to buy"* to *"who can actually supply it—and why."* Describe your purchase once, and QuotePilot interprets your requirements, searches public supplier websites and PDFs, checks each source passage against every criterion, and presents a shortlist grounded in verifiable evidence rather than opaque AI guesses.

## What it does

- **Plain-language brief to structured requirements:** Enter what you need, quantity and unit, delivery destination (by radius, countries, continents, or worldwide on the map), optional deadline, and extra notes. QuotePilot turns your brief into **Must-have** gates and **Nice-to-have** preferences.
- **Multi-source supplier discovery & page retrieval:** Searches across regions, languages, and supplier types, retrieves actual supplier pages and PDFs, extracts listed prices where published, and tracks search coverage.
- **Evidence-first evaluation (`gemini-decision-1`):** Evaluates each collected passage against every requirement independently (`Pass`, `Fail`, or `Unknown`). Low-confidence (`< 85%`) or conflicting evidence stays `Unknown`—missing facts are never invented.
- **Deterministic shortlist & full transparency:** Must-have failures disqualify a supplier; open must-haves require human confirmation; eligible suppliers are ranked by nice-to-have score and coverage. Every cell in the comparison matrix links straight to the exact source passage, decision-model confidence, and a ready-to-copy clarification email draft.
- **Fast re-evaluation:** Adjust requirements, toggle must-have/nice-to-have, or request AI-suggested requirements and click **Update shortlist** to re-score saved evidence without re-running discovery.

## How to use it

1. **Describe your purchase** on the **New supplier search** screen (product, quantity/unit, delivery destination via the map modal, and any optional deadline or requirements).
2. Click **Find my shortlist** to launch discovery and evaluation. Watch live phase progress (`Understanding your requirements` → `Finding suppliers` → `Checking suppliers against your requirements`).
3. **Review the Shortlist:** inspect the ranked summary, comparison matrix, decision-model performance breakdown, and per-supplier assessment details. Click any matrix cell to jump to its supporting source passage, or copy a generated **Clarification draft** for open requirements.
4. **Iterate without re-searching:** click **Adjust requirements** to refine, add, or request **Suggest requirements**, then click **Update shortlist** to re-evaluate the collected evidence.
5. **Inspect Sources** anytime to review every retrieved passage and candidate domain.

> QuotePilot is a research and shortlisting workspace: it never places orders or contacts suppliers. Verify supplier identity and commercial terms directly before purchasing.

## Run locally

Requires Python 3.12, [uv](https://docs.astral.sh/uv/), Docker Compose, and a Gemini API key.

```sh
uv sync --locked
cp .env.example .env  # First setup only.
```

Set `GEMINI_API_KEY` in `.env`, then start PostgreSQL, apply migrations, and launch the web server:

```sh
docker compose up -d --wait db
uv run python -m web.manage migrate
uv run python -m web.manage runserver
```

In a second terminal, start the background research worker:

```sh
uv run python -m web.manage research_worker
```

Open http://127.0.0.1:8000/.

### UI preview (no database or API key required)

```sh
uv run python scripts/preview_ui.py  # http://127.0.0.1:8001/
```

## Development

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
bash scripts/check.sh
```

Database tests require a PostgreSQL role that can create test databases.

See [DESIGN.md](DESIGN.md) for UI conventions and [backend/README.md](backend/README.md) for module ownership. Codesphere deployment configuration is in `ci.yml` and `scripts/`.
