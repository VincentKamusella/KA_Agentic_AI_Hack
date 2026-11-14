#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="$HOME/.nix-profile/bin:$PATH"

if ! command -v uv >/dev/null 2>&1; then
    nix-env -iA nixpkgs.uv
fi
# Keep downloaded Python and dependency caches on the workspace's persistent disk.
export UV_PYTHON_INSTALL_DIR="$PWD/.codesphere/python"
export UV_CACHE_DIR="$PWD/.codesphere/uv-cache"
uv sync --locked --python 3.12 --no-dev
uv run --locked --no-dev python -m web.manage check
uv run --locked --no-dev python -m web.manage collectstatic --noinput
# Run smoke tests before touching the deployment database.
uv run --locked --no-dev python -m web.manage test backend web --noinput
uv run --locked --no-dev python -m web.manage migrate --noinput
