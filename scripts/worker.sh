#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nix-profile/bin:$PATH"
export UV_PYTHON_INSTALL_DIR="$PWD/.codesphere/python"
export UV_CACHE_DIR="$PWD/.codesphere/uv-cache"
exec uv run --locked --no-dev python -m web.manage research_worker --health-port 3000
