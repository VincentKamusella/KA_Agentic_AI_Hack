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
