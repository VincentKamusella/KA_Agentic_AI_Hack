# Backend interfaces

Shared Pydantic models: [`contracts.py`](contracts.py).
Async service interfaces: [`interfaces.py`](interfaces.py).

| Owner | Responsibility |
| --- | --- |
| Person 1 | Supplier discovery and source evidence |
| Person 2 | Gemini evaluation and scoring |
| Person 3 | Orchestration, Django API, and UI |

Agree on shared contract changes together. Contract behavior belongs in Python
docstrings; implementations satisfy the protocols without needing inheritance.

Use [`example_pipeline.json`](../fixtures/example_pipeline.json) to build independently.
Run checks with `uv run python -m unittest backend.tests`.

## First implementation

- `discovery.py`: Gemini Search citation adapter; supplier names are source hostnames.
- `evaluation.py`: evidence-level Gemini Decisions and deterministic aggregation.
- `gemini.py`: server-only REST transport with safe error messages.
- `pipeline.py`: protocol-compatible orchestrator, stable shortlist ordering, with synthetic adapters isolated in test helpers.
- `web/views.py`: bounded, CSRF-protected discovery/evaluation HTTP stages.

Shared contracts remain unchanged. The UI calls the stages separately so users can
inspect discovery evidence before paying for evaluation. Demo adapters implement
the same async protocols. The local fixture is never a fallback for live failures.

Run `uv run python -m unittest backend.tests backend.test_evaluation` for domain tests.
