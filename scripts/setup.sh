#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null || { echo "Install uv before running setup." >&2; exit 1; }
command -v npm >/dev/null || { echo "Install Node.js and npm before running setup." >&2; exit 1; }
uv sync --locked --extra dev
npm ci --prefix frontend
npm run build --prefix frontend
