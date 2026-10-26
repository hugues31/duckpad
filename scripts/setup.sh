#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/share/duckpad-tools/node/bin:$HOME/.local/bin:$PATH"
command -v uv >/dev/null || { echo "Install uv before running setup." >&2; exit 1; }
command -v npm >/dev/null || { echo "Install Node.js and npm before running setup." >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Node.js 20 or later is required for development checks."); process.exit(1); }'
native_options=()
if [[ "$(uname -m)" == x86_64 && -r /proc/cpuinfo ]] && ! grep -qw avx2 /proc/cpuinfo; then
    command -v c++ >/dev/null || { echo "Install a C++ compiler to build DuckDB on this CPU." >&2; exit 1; }
    export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-2}"
    export CFLAGS="${CFLAGS:--march=x86-64 -mtune=generic}"
    export CXXFLAGS="${CXXFLAGS:--march=x86-64 -mtune=generic}"
    native_options=(--no-binary-package duckdb)
fi
uv sync --locked --extra dev --python 3.12 "${native_options[@]}"
npm ci --prefix frontend
npm run build --prefix frontend
