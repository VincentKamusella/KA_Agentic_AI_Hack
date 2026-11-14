#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nix-profile/bin:$PATH"
export UV_PYTHON_INSTALL_DIR="$PWD/.codesphere/python"
export UV_CACHE_DIR="$PWD/.codesphere/uv-cache"
uv run --locked --no-dev python -m web.manage check
uv run --locked --no-dev python -m web.manage makemigrations --check --dry-run
uv run --locked --no-dev python -m web.manage migrate --check
uv run --locked --no-dev python -m web.manage test backend web --noinput
uv run --locked --no-dev python -m unittest discover -s tests -p 'test_*.py'
