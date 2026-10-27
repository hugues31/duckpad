# Prepare and verify an offline extension cache

This page is for the administrator preparing an archive. For the target machine,
start with the [short installation guide](OFFLINE_EXTENSIONS.md).

## Prepare a cache archive

Use a connected machine with the **same DuckDB version and platform** as the
backend. Run these commands with the Python interpreter that provides DuckDB.
`PRAGMA version` and `PRAGMA platform` report the values to match; Duckpad uses
DuckDB 2.0.0. Rebuild the cache after a DuckDB upgrade.

In a fresh working directory:

```sh
mkdir -p duckpad-extensions/extensions
python - <<'PY'
from pathlib import Path
import duckdb

cache = Path("duckpad-extensions/extensions").resolve()
with duckdb.connect(config={"extension_directory": str(cache)}) as db:
    print(db.execute("PRAGMA version").fetchall())
    print(db.execute("PRAGMA platform").fetchall())
    db.execute("INSTALL oraduck FROM community")
PY
tar -czf duckpad-extensions.tar.gz -C duckpad-extensions extensions
sha256sum duckpad-extensions.tar.gz > duckpad-extensions.tar.gz.sha256
```

Transfer both files to the target, check
`sha256sum -c duckpad-extensions.tar.gz.sha256`, then follow the
[extraction steps](OFFLINE_EXTENSIONS.md#quick-install-extract-the-cache-and-restart).
The cache includes DuckDB-generated `.info` files; preserve them alongside the
binaries so named loads use the correct signature verification context.

For other connectors, replace or extend the `INSTALL` statement: `INSTALL httpfs`
for S3, `INSTALL excel` for XLSX, or `INSTALL h3 FROM community` for the standalone
verification below. Include any installed dependencies. Installation prepares
the cache; execution and external connectivity still need checking on the target.

Duckpad, its Python packages and native client libraries must already be installed
there. A cache archive contains extensions only. In a fully disconnected setup,
prepare Python wheels and system packages separately.

## Using OraDuck's signed repository archive directly

The [signed release archive](https://github.com/hugues31/oraduck/releases/tag/v0.4.0)
contains `.duckdb_extension.gz` files and a hidden `.well-known` directory with
the community public key. It has a different layout from an installed cache.

Its [upstream instructions](https://github.com/hugues31/oraduck#offline-github-release)
require registering a local DuckDB repository and using
`LOAD oraduck FROM oraduck_offline`, including in later sessions. Duckpad's
standard connector currently uses `LOAD oraduck` and a community-install fallback.
Use the prepared community cache above with that connector; do not substitute the
upstream repository archive for `duckpad-extensions.tar.gz`.

Both community installation and the explicitly named signed archive verify
signatures without enabling unsigned extensions. The older unsigned archive and
GitHub Pages builds remain separate distributions.

## Check the installed cache

Before running a connector, test its native load with the backend's interpreter
and service account, inside the container when applicable:

```sh
export DUCKPAD_INSTANCE=/path/to/instance
python - <<'PY'
import os
from pathlib import Path
import duckdb

cache = Path(os.environ["DUCKPAD_INSTANCE"]) / "extensions"
with duckdb.connect(config={
    "extension_directory": str(cache),
    "allow_unsigned_extensions": False,
    "autoinstall_known_extensions": False,
    "autoload_known_extensions": False,
}) as db:
    db.execute("LOAD oraduck")
PY
```

Then test the ordinary Duckpad connection and pipeline. Native `LOAD` alone does
not establish Oracle connectivity or verify credentials.

| Symptom | Check |
| --- | --- |
| Extension missing | Use `<instance>/extensions`, preserve version/platform subdirectories, and check backend read permissions. |
| Signature rejected | Keep `.info` metadata; use the signed distribution and its matching cache. A repository archive needs its own installation procedure. |
| Version/platform mismatch | Prepare again with the target's exact DuckDB version and platform, including libc variants. |
| Missing Oracle libraries | Install Instant Client 19+, `libaio` and `libnsl`; configure the library path before starting Duckpad. |
| `SIGILL` on load | The binary may use unsupported CPU instructions. Obtain a compatible build; signature settings do not fix this. |
| Network attempted | Duckpad tries a repository install if `LOAD` fails. Correct the cache and enforce any required egress restrictions outside Duckpad. |

Project SQL and uploaded data files cannot install extensions. The isolated worker
receives read-only access to the instance cache; administrator connector setup
runs before its configuration is locked.

## Reproduce the offline verification

Prepare an H3 cache with the recipe above, replacing the install statement with
`INSTALL h3 FROM community`. After repository setup, run on Linux with user/network
namespaces and Landlock support:

```sh
unshare --user --map-root-user --net \
  .venv/bin/python scripts/verify_offline_extensions.py duckpad-extensions/extensions \
  --output offline-extensions.json
```

The script uses temporary instances in a network namespace containing only
loopback. It downloads nothing. The [recorded report](../docs/validation/offline-extensions.json)
checks signed cache loading, rejection of damaged signatures, execution after
reopening both embedded and isolated instances, and unsigned opt-in/revocation.

H3 execution passed on the test machine. Earlier `httpfs`, `tpch`, `inet` and
OraDuck loads encountered `SIGILL` on its older CPU. The signed OraDuck archive
was subsequently verified to install offline with signature checks enabled;
this does not establish a successful Oracle connection on that machine.

For native DuckDB details, see [extension installation](https://duckdb.org/docs/2.0/extensions/installing_extensions)
and [repository configuration](https://duckdb.org/docs/2.0/extensions/extension_repositories).
