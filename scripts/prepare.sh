#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
    nix-env -iA nixpkgs.uv
    export PATH="$HOME/.nix-profile/bin:$PATH"
fi
# Keep downloaded Python and dependency caches on the workspace's persistent disk.
export UV_PYTHON_INSTALL_DIR="$PWD/.codesphere/python"
export UV_CACHE_DIR="$PWD/.codesphere/uv-cache"
uv sync --locked --python 3.12 --no-dev
.venv/bin/python -m web.manage check
.venv/bin/python -m web.manage collectstatic --noinput
# Run smoke tests before touching the deployment database.
.venv/bin/python -m web.manage test web
.venv/bin/python -m web.manage migrate --noinput
