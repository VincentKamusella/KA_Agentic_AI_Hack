#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec .venv/bin/gunicorn web.config.wsgi:application \
    --bind 0.0.0.0:3000 \
    --workers "${WEB_CONCURRENCY:-2}" \
    --timeout 240 \
    --access-logfile - \
    --error-logfile -
