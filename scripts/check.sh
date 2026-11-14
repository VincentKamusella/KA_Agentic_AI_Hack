#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
.venv/bin/python -m web.manage check
.venv/bin/python -m web.manage makemigrations --check --dry-run
.venv/bin/python -m web.manage migrate --check
.venv/bin/python -m web.manage test web
