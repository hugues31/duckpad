# DuckDB extensions without Internet access

Duckpad can use extensions in an air-gapped environment. Prepare a matching,
signed extension cache on a connected machine, transfer it into the instance's
`extensions` directory, and restart Duckpad. No product change is needed for this
workflow. The procedure below was verified with DuckDB **2.0.0**, Linux
`linux_amd64`, and the signed **H3** community extension, including Duckpad's
isolated SQL worker with networking disabled.

This guide assumes Duckpad, its Python dependencies, Git and required system
libraries are already installed. For a completely disconnected installation,
prepare wheels and system packages on a compatible connected machine first;
install Python packages with `pip install --no-index --find-links /path/to/wheels
duckpad==<release>`. A Duckpad wheel does not bundle every DuckDB extension or
third-party client library.

## Identify the target runtime

Run this with the Python interpreter that runs the **backend**, inside its
container if applicable:

```sh
python - <<'PY'
import duckdb
with duckdb.connect() as db:
    print(db.execute("PRAGMA version").fetchall())
    print(db.execute("PRAGMA platform").fetchall())
    print(db.execute("""
        SELECT extension_name, installed, loaded, install_mode
        FROM duckdb_extensions() ORDER BY extension_name
    """).fetchall())
PY
```

Use the same DuckDB version, platform and compatible CPU/system libraries when
staging extensions. Match the reported platform, including libc variants, rather
than assuming that any Linux or x86-64 binary will work. Nightly/custom builds can
use a commit identifier in place of a release directory. Rebuild the bundle after
a DuckDB upgrade. Extensions marked `STATICALLY_LINKED` already belong to that
runtime and need no download. A feature working with a built-in extension is not
proof that an external extension can be installed offline.

The instance directory is the value passed to `duckpad start --home`. Without
that argument it is `$XDG_DATA_HOME/duckpad` or `~/.local/share/duckpad`. Duckpad
uses **`<instance>/extensions`**, not the unrelated `~/.duckdb/extensions` cache.
For example, a transferred cache has this layout:

```text
<instance>/extensions/
└── v2.0.0/
    └── linux_amd64/
        ├── h3.duckdb_extension
        └── h3.duckdb_extension.info
```

DuckDB's native cache layout and its `extension_directories` setting are described
in the [installation reference](https://duckdb.org/docs/2.0/extensions/installing_extensions).
Duckpad currently sets the older singular `extension_directory` internally; both
refer to the same instance cache in the tested runtime.

## Prepare a bundle on the connected machine

Use a clean staging directory and the target's DuckDB runtime.
[H3](https://duckdb.org/community_extensions/extensions/h3) is a self-contained
example; install the extensions your connectors actually need.

```sh
mkdir -p extension-bundle/extensions
python - <<'PY'
from pathlib import Path
import duckdb

cache = Path("extension-bundle/extensions").resolve()
with duckdb.connect(config={"extension_directories": [str(cache)]}) as db:
    db.execute("INSTALL h3 FROM community")
    db.execute("LOAD h3")
    print(db.execute("""
        SELECT extension_name, extension_version, installed_from, install_mode
        FROM duckdb_extensions() WHERE extension_name = 'h3'
    """).fetchall())
    print(db.execute("SELECT h3_get_resolution(h3_latlng_to_cell(48.8566, 2.3522, 9))").fetchall())
PY
(cd extension-bundle && find extensions -type f -exec sha256sum {} + > SHA256SUMS)
tar -czf extension-bundle.tar.gz extension-bundle
```

The query should return `9`. To prepare other connectors, use their declared
extensions, for example `INSTALL httpfs` for S3, `INSTALL excel` for XLSX when it
is not built in, or `INSTALL oraduck FROM community` for Oracle. Load and exercise
each one on compatible hardware before transferring it. Include any dependencies
it installs and provision required native libraries separately; OraDuck needs
Oracle Instant Client. See [connector prerequisites](CONNECTORS.md).

**Keep the `.info` files.** In the tested DuckDB 2.0 runtime, H3 loaded with its
community installation metadata, while `INSTALL '/path/to/h3.duckdb_extension'`
and direct-path `LOAD` of the bare binary failed signature verification. A copied
cache preserves the repository provenance needed by this installation. Do not
disable signature checking to work around missing metadata. Custom repositories
with organization-specific signing keys also require their trust configuration;
this guide validates the built-in community repository, not custom signing keys.

Transfer the archive and its checksum manifest through your approved offline
channel. Checksums detect a changed transfer; DuckDB signature verification
remains enabled and validates the extension code.

## Install in the disconnected Duckpad instance

Stop Duckpad before changing the cache. Extract the archive, check it, and copy
the **contents** of `extensions` into the instance cache as the backend's service
user:

```sh
tar --no-same-owner -xzf extension-bundle.tar.gz
(cd extension-bundle && sha256sum --check SHA256SUMS)
export DUCKPAD_INSTANCE=/path/to/instance
mkdir -p "$DUCKPAD_INSTANCE/extensions"
cp -a extension-bundle/extensions/. "$DUCKPAD_INSTANCE/extensions/"
```

For an existing cache, back it up first and review any files the bundle would
replace. Preserve the version/platform subdirectories. In containers, copy into
the persistent volume mounted at the instance directory, or provision that
volume before startup. A cache in a disposable container layer disappears when
the container is replaced. Ensure the backend can read the files and traverse
their directories; the SQL worker receives read-only access to this cache.

Verify offline with the backend's interpreter and service account:

```sh
python - <<'PY'
import os
from pathlib import Path
import duckdb

cache = Path(os.environ["DUCKPAD_INSTANCE"]) / "extensions"
with duckdb.connect(config={
    "extension_directories": [str(cache)],
    "autoinstall_known_extensions": False,
    "autoload_known_extensions": False,
}) as db:
    db.execute("LOAD h3")
    print(db.execute("SELECT current_setting('allow_unsigned_extensions')").fetchall())
    print(db.execute("SELECT h3_get_resolution(h3_latlng_to_cell(48.8566, 2.3522, 9))").fetchall())
PY
duckpad start --home "$DUCKPAD_INSTANCE" --no-browser
```

Expected results are `False` (unsigned extensions remain disabled) and `9`.
Restart after replacing binaries: loaded extensions cannot be unloaded/replaced
inside an existing DuckDB instance.

An instance admin then configures the ordinary connector and connection in
**Instance settings → Connections**, and grants that connection under
**Project settings**. Existing S3, XLSX and Oracle definitions need no change.
For the H3 example, use a connector with `"id": "h3"`, `"name": "H3"`,
`"parameters": []`, `"extensions": [{"name": "h3", "repository": "community"}]`,
`"capabilities": ["read"]`, and `"init_sql": ""`. Create a connection named `h3`
using it with `"environments": {"dev": {}}`, grant it to a project, and run this
source template:

```sql
-- @kind source
-- @param connection: connection = "h3"
-- @output result
SELECT h3_get_resolution(h3_latlng_to_cell(48.8566, 2.3522, 9)) AS resolution;
```

Duckpad first tries `LOAD` from the instance cache. If loading fails, connector
setup tries `INSTALL` from its declared repository. A missing or incompatible
extension can therefore still trigger a network attempt. Disabling DuckDB's
automatic installation does not disable Duckpad's explicit installer. Enforce
egress restrictions outside Duckpad when required. The isolated worker disables
automatic installation/loading, but administrator setup runs before that worker.
Project SQL cannot provision extensions; uploaded data files are not an extension
installer.

## Other distribution methods

For core-signed binaries, DuckDB also supports local-file installation:

```sql
SET extension_directories = ['/path/to/instance/extensions'];
INSTALL '/path/to/httpfs.duckdb_extension';
LOAD httpfs;
```

This runs outside Duckpad as an administrator. Decompress `.duckdb_extension.gz`
files first. Direct-path `LOAD` alone does not populate the cache that Duckpad
loads by extension name. See [advanced installation methods](https://duckdb.org/docs/2.0/extensions/advanced_installation_methods).
Local installation of the core `httpfs` binary passed here, but loading that
binary failed on this test CPU; it is not included in the successful runtime
validation below.

An internal mirror can serve a version/platform repository tree through local
files or an internal HTTP server. Connector definitions already support a
`repository` value for the fallback installer. A mirror is useful when many
instances need the same approved extensions, but it must preserve the correct
signing/trust policy. Simply pointing H3 at an arbitrary local directory also
failed signature validation in this test. Follow DuckDB's
[repository configuration](https://duckdb.org/docs/2.0/extensions/extension_repositories)
for custom keys; mirror deployment is outside this guide's validated scope.

## Reproduce the verification

After preparing the H3 cache and running repository setup, run this from the
checkout on Linux with user/network namespaces and Landlock support:

```sh
unshare --user --map-root-user --net \
  .venv/bin/python scripts/verify_offline_extensions.py extension-bundle/extensions \
  --output offline-extensions.json
```

The script requires a network namespace containing only loopback. It uses fresh
temporary caches and instances, never your running instance. No binary download
is hidden in the check. If unprivileged namespaces are disabled, an operator must
provide an equivalent network-isolated Linux environment; a failed namespace
setup is not a passing offline test.

The [recorded report](../docs/validation/offline-extensions.json) covers:

- An uncached community `INSTALL` fails without network access.
- The transferred H3 binary **and metadata** allow `INSTALL`, `LOAD` and real H3
  queries with unsigned extensions disabled, including a fresh database.
- Changing a signature byte is rejected, even with the installation metadata.
- Installing the bare community binary is rejected, documenting why metadata is
  part of the bundle.
- Duckpad's embedded engine and isolated worker both execute an H3 pipeline after
  reopening their instances twice.

These results validate extension distribution and local execution, not remote S3
or Oracle access. Those connectors still need access to their data services on
the permitted internal network. No disconnected Oracle integration was run.

The test machine's older x86-64 CPU could run the provisioned DuckDB 2.0 runtime
and H3, but published `httpfs`, `tpch` and `inet` binaries terminated on `LOAD`
with `SIGILL`. A matching version/platform and valid signature do not guarantee
compatible CPU instructions. Validate the actual binary on the target hardware;
an offline cache or a Duckpad UI cannot repair a native CPU incompatibility.

## Is a Duckpad feature needed?

The existing cache, connector declarations and project grants cover the verified
workflow. An upload screen would add a second installation path without removing
the need to match binaries, preserve trust metadata and provision system
libraries, so this change adds documentation and a reproducible check only.

If repeated deployments show a need, a small administrator command that reports
the runtime/platform, cache location and failed `LOAD` reason would be useful.
An explicit offline mode could suppress Duckpad's download fallback. Neither is
required to use the tested procedure, and neither is implemented here.
