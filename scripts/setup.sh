#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/share/duckpad-tools/node/bin:$HOME/.local/bin:$PATH"
command -v uv >/dev/null || { echo "Install uv before running setup." >&2; exit 1; }
command -v npm >/dev/null || { echo "Install Node.js and npm before running setup." >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Node.js 20 or later is required for development checks."); process.exit(1); }'
portable=false
if [[ "$(uname -m)" == x86_64 && -r /proc/cpuinfo ]] && { ! grep -qw avx2 /proc/cpuinfo || ! grep -qw bmi2 /proc/cpuinfo; }; then
    portable=true
    wheelhouse="${DUCKPAD_WHEELHOUSE:-$HOME/.local/share/duckpad-tools/wheels/2.0.0}"
    [[ -f "$wheelhouse/SHA256SUMS" ]] || {
        echo "Run bash scripts/provision-runtime.sh once on this server before setting up worktrees." >&2
        exit 1
    }
    (cd "$wheelhouse" && sha256sum --check SHA256SUMS)
fi
uv sync --locked --python 3.12 --no-build-package duckdb
if "$portable"; then
    # Install by package name so subsequent locked uv sync/run calls retain it.
    uv pip install --python .venv/bin/python --reinstall-package duckdb \
        --no-index --find-links "$wheelhouse" duckdb==2.0.0
fi
uv run python -c "import duckdb; print('DuckDB', duckdb.__version__)"
npm ci --prefix frontend
npm run build --prefix frontend
