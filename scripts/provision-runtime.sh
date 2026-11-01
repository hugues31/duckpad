#!/usr/bin/env bash
# One-time provisioning for the preview server; ordinary tickets use setup.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/bin:$PATH"
wheelhouse="${DUCKPAD_WHEELHOUSE:-$HOME/.local/share/duckpad-tools/wheels/2.0.0}"
cache="$HOME/.cache/duckpad-build"
mkdir -p "$wheelhouse" "$cache"
if [[ ! -f "$wheelhouse/SHA256SUMS" ]]; then
    for tool in c++ git make perl bison flex; do
        command -v "$tool" >/dev/null || { echo "Initial provisioning requires $tool." >&2; exit 1; }
    done
    # Builds DuckDB with excel and postgres linked statically, for CPUs without AVX2 or BMI2.
    uv venv --python 3.12 --allow-existing "$cache/toolchain"
    uv pip install --python "$cache/toolchain/bin/python" \
        scikit-build-core==1.1.1 nanobind==3.1.0 numpy==2.5.4 cmake==4.4.4 ninja==1.13.2
    "$cache/toolchain/bin/python" scripts/build_runtime.py "$wheelhouse"
    uv venv --python 3.12 --allow-existing "$cache/validation-venv"
    uv pip install --python "$cache/validation-venv/bin/python" --reinstall-package duckdb \
        --no-index --find-links "$wheelhouse" duckdb==2.0.0
    "$cache/validation-venv/bin/python" -c "import duckdb; assert duckdb.__version__ == '2.0.0'; assert duckdb.sql('select 42').fetchall() == [(42,)]; duckdb.sql('LOAD excel; LOAD postgres')"
    (cd "$wheelhouse" && sha256sum -- *.whl > SHA256SUMS)
fi
(cd "$wheelhouse" && sha256sum --check SHA256SUMS)
docker build -f Dockerfile.duckdb -t duckpad-python:3.12-duckdb2.0.0 "$wheelhouse"
docker run --rm --network none duckpad-python:3.12-duckdb2.0.0 \
    /app/.venv/bin/python -c "import duckdb; duckdb.sql('LOAD excel; LOAD postgres'); print('Portable DuckDB', duckdb.__version__, duckdb.sql('select 42').fetchall())"
