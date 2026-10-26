#!/usr/bin/env bash
# One-time provisioning for the preview server; ordinary tickets use setup.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/bin:$PATH"
wheelhouse="${DUCKPAD_WHEELHOUSE:-$HOME/.local/share/duckpad-tools/wheels/2.0.0}"
cache="$HOME/.cache/duckpad-build"
mkdir -p "$wheelhouse" "$cache"
if [[ ! -f "$wheelhouse/SHA256SUMS" ]]; then
    command -v c++ >/dev/null || { echo "A C++ compiler is required for initial provisioning." >&2; exit 1; }
    python3 - "$cache" <<'PY'
import hashlib
import pathlib
import sys
import tomllib
import urllib.request

lock = tomllib.loads(pathlib.Path("uv.lock").read_text())
package = next(p for p in lock["package"] if p["name"] == "duckdb")
assert package["version"] == "2.0.0", "Update the runtime image and provisioning version together."
source = package["sdist"]
target = pathlib.Path(sys.argv[1]) / "duckdb-2.0.0.tar.gz"
if not target.exists():
    with urllib.request.urlopen(source["url"], timeout=60) as response:
        target.write_bytes(response.read())
assert hashlib.sha256(target.read_bytes()).hexdigest() == source["hash"].removeprefix("sha256:")
PY
    export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
    export CFLAGS="-march=x86-64 -mtune=generic" CXXFLAGS="-march=x86-64 -mtune=generic"
    uv build "$cache/duckdb-2.0.0.tar.gz" --wheel --python 3.12 --out-dir "$wheelhouse" \
        --config-setting cmake.define.DUCKDB_OPTIMIZATION_PROFILE=NONE
    uv venv --python 3.12 "$cache/validation-venv"
    uv pip install --python "$cache/validation-venv/bin/python" \
        --no-index --find-links "$wheelhouse" duckdb==2.0.0
    "$cache/validation-venv/bin/python" -c "import duckdb; assert duckdb.__version__ == '2.0.0'; assert duckdb.sql('select 42').fetchall() == [(42,)]"
    (cd "$wheelhouse" && sha256sum *.whl > SHA256SUMS)
fi
(cd "$wheelhouse" && sha256sum --check SHA256SUMS)
docker build -f Dockerfile.duckdb -t duckpad-python:3.12-duckdb2.0.0 "$wheelhouse"
docker run --rm duckpad-python:3.12-duckdb2.0.0 \
    /app/.venv/bin/python -c "import duckdb; print('Portable DuckDB', duckdb.__version__, duckdb.sql('select 42').fetchall())"
