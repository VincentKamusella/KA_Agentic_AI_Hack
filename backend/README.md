# Backend

Shared models: [`contracts.py`](domain/contracts.py). Service interfaces: [`interfaces.py`](domain/interfaces.py).

| Owner | Responsibility |
| --- | --- |
| Person 1 | Supplier discovery and source evidence |
| Person 2 | Gemini evaluation and scoring |
| Person 3 | Orchestration, Django API, and UI |

Agree on shared contract changes together. Use [`example_pipeline.json`](../fixtures/example_pipeline.json) to build independently.

Run checks with `uv run python -m web.manage test backend web --noinput`.
