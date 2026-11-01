# Extension downloads and import details

The [short guide](OFFLINE_EXTENSIONS.md) covers browser downloads and imports.
This works across operating systems: only the binary must match the server.

## Download without a matching local runtime

Read the server version and platform in **Instance settings → Extensions**,
or through authenticated `GET /api/extensions/runtime`. Download
the file on any computer with Internet access. No extension is installed or
executed on that computer.

![Choose a core extension for the displayed server version and platform before downloading and importing it](images/extensions.png)

Official download addresses use these patterns:

```text
https://extensions.duckdb.org/<version>/<platform>/<name>.duckdb_extension.gz
https://community-extensions.duckdb.org/<version>/<platform>/<name>.duckdb_extension.gz
```

For example, `v2.0.0/linux_amd64/httpfs.duckdb_extension.gz` selects the Linux
x86-64 core binary, even when downloaded with a Windows browser. The interface
constructs this URL from the backend runtime. A missing download means that
name/version/platform combination is unavailable in the selected repository;
check its catalog or obtain a compatible build from its publisher. When the
browser can reach the repository, the interface reports a missing download
before you click the link.

The same import accepts matching files extracted from release archives. Select
the inner `.duckdb_extension` or `.duckdb_extension.gz`; do not upload the entire
`.tar.gz` or `.zip`. Keep its original extension name in the filename.

## What import checks

The authenticated administrator endpoint `POST /api/extensions/import` accepts
multipart fields `file` and `source` (`core`, `community`, or `unsigned`).
`GET /api/extensions/runtime` lists imports alongside the server version/platform,
and `core_extensions`: the core extensions known to the server's DuckDB build, with
their description, aliases and whether they are built in. Reading this list
needs no network access.

Duckpad validates the file in a temporary cache with DuckDB's native `INSTALL`.
Core and community imports always verify signatures, even when the separate
unsigned option is enabled. The pinned public keys come from
[DuckDB 2.0's trust roots](https://github.com/duckdb/duckdb/blob/v2.0.0/src/main/extension/extension_helper.cpp);
uploaded files cannot introduce additional trusted keys. Other signing keys
require the explicit unsigned policy and source selection.

Wrong-platform, wrong-version, malformed, oversized and invalid-signature files
are rejected before replacing an existing import. An active execution returns
HTTP 409. After validation, Duckpad closes existing databases and registers the
new import outside project Git. No network download or native `LOAD` is part of
importing: activate it from a project's **Extensions** tab or test the actual
connection/pipeline afterward to verify execution,
CPU support, system libraries and credentials.

Imports persist across restarts and apply to both embedded and isolated execution.
An imported extension that fails to load does not fall back to downloading a
replacement. Disabling unsigned extensions closes existing databases and prevents
unsigned imports from loading again.

The instance directory is selected by `duckpad start --home`; the default is
`$XDG_DATA_HOME/duckpad` or `~/.local/share/duckpad`. Back up the whole instance,
including its `extensions` directory and instance metadata. In containers, keep
that directory on a persistent volume. Replacement imports retain previous
binary versions in the cache.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Wrong version or platform | Use the server's displayed values, including libc variants, and download again. |
| Signature rejected | Select the correct core/community source and obtain the official signed file again. |
| Archive rejected | Extract the release archive on any computer and import the matching inner binary. |
| Missing dependency or library | Import dependent extensions and provision the connector's server libraries. |
| `SIGILL` on execution | The binary may require CPU instructions the server lacks; obtain a compatible build. |
| Import is disabled or forbidden | Use an instance administrator account; project permissions do not grant installation rights. |
| Existing results disappear | Imports recreate database contexts. Run the pipeline again. |

Project SQL and data uploads cannot install extensions. SQL workers receive
read-only access to the cache and a locked configuration. Connections without an
import still use Duckpad's existing repository-install fallback; enforce any
instance-wide egress restrictions outside Duckpad.

Project editors can activate only a local binary matching the declared source.
The project-scoped `GET /api/worktrees/{id}/extensions` endpoint reports
availability without loading native code. Editors can use
`POST /api/worktrees/{id}/extensions/check` with a `name` and `source` to check
loading in a disposable process. Requirements are saved through the normal
versioned project save, so the same authorization and conflict handling apply.
Missing or incompatible requirements stop execution with import guidance; there
is no automatic installation fallback for project activations. Disabled unsigned
policy continues to block unsigned project requirements.

## Reproduce the offline verification

For project activation, download `duckfn_statrs.duckdb_extension.gz` from the
community repository for the server runtime, then run:

```sh
unshare --user --map-root-user --net \
  .venv/bin/python scripts/verify_project_extensions.py \
  downloads/duckfn_statrs.duckdb_extension.gz --output project-extensions.json
```

This check verifies normal CDF, density and quantile results without a connection,
restarts, execution through the scheduler entry point, isolation between projects,
deactivation, connector regression and sharing to an instance without the binary.
It runs in both embedded and isolated modes, with only a loopback interface and
an uncached repository installation as a failing network control.

Set `DUCKPAD_TEST_STATRS_BINARY` to the absolute path of that binary when running
the Playwright `project-extensions.spec.ts` scenario to also exercise the real
browser import, project activation and SQL result. Without it, the suite runs the
portable built-in and missing-extension UI checks and skips the binary integration.

Download H3 and httpfs for the Linux test runtime, plus H3 for Windows as a negative
test. After repository setup, run on Linux with user/network namespaces and Landlock:

```sh
unshare --user --map-root-user --net \
  .venv/bin/python scripts/verify_extension_imports.py \
  downloads/h3.duckdb_extension.gz downloads/httpfs.duckdb_extension.gz \
  downloads/h3-windows.duckdb_extension.gz --output extension-imports.json
```

The [import report](../docs/validation/extension-imports.json) records real signed
core/community imports with networking disabled, invalid-file rejection,
unsigned opt-in, and H3 execution after reopening both execution modes. The core
binary is installed but not executed on the older test CPU. External service
connectivity is outside this validation.

The earlier [cache verification report](../docs/validation/offline-extensions.json)
also covers transferring installed caches with their `.info` files. Such a cache
remains usable, but preparing one on a matching computer is no longer necessary
for the import workflow.
