#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nix-profile/bin:$PATH"
export UV_PYTHON_INSTALL_DIR="$PWD/.codesphere/python"
export UV_CACHE_DIR="$PWD/.codesphere/uv-cache"
exec uv run --locked --no-dev gunicorn web.config.wsgi:application \
    --bind 0.0.0.0:3000 \
    --workers "${WEB_CONCURRENCY:-2}" \
    --timeout 240 \
    --access-logfile - \
    --error-logfile -
