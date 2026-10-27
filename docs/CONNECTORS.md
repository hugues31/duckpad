# Connections and connector compatibility

A connector is a declarative setup definition. A connection is a named reusable instance with independent environment values. Both live in the instance catalog, outside Git. Projects store only references. Instance admins configure them from **Instance settings → Connections**; connector definitions have a JSON editor, and their typed parameters generate connection forms.

The instance-admin-only `PUT /api/catalog/connector` and `PUT /api/catalog/connection` endpoints accept those same JSON objects, so an administrator can submit declarative files without changing application code. Secret fields are masked in public catalog responses and execution records. Definition snapshots and non-secret settings used by each run remain in its history. Instance admins grant each project access to connections in **Project settings**. Members see only the names and capabilities of granted connections, not the global catalog.

## Environments

Instance admins manage environments in **Instance settings → Environments**.
Each has a stable identifier, an editable label, a color, and a **Confirm every
run** option. Existing installations retain their identifiers and connection
values; `dev` defaults to no confirmation and `prod` defaults to confirmation.
Labels and colors appear in the workspace selector and connection settings.
Changing them does not change project Git history or invalidate results.

New environments start with empty connection values. Configure them in
**Connections** before running. Deleting an environment requires confirmation,
removes its connection values and clears cached results, but preserves execution
history. Active runs must finish or be stopped first. At least one environment
must remain.

The confirmation option applies to workspace pipeline and node launches. The
dialog identifies the environment, project, branch and execution target;
canceling it starts nothing. The server also checks the current option on every
`entry_point: "ui"` launch and requires `confirmed: true` when enabled.
Programmatic API launches remain non-interactive. This is an execution safeguard,
not a replacement for project permissions.

Administrators can create an environment with `POST /api/environments`
(`id`, `label`, `color` as a six-digit hex color, `confirm_before_run` as a boolean),
edit its settings with `PUT /api/environments/{id}`, or delete it with
`DELETE /api/environments/{id}`. `/api/workspace` exposes `catalog.environment_details`
alongside the existing identifier list. The legacy bulk `PUT /api/environments`
endpoint continues to accept identifiers without replacing their metadata.

## Validated scope

| Preset | Required operations | Recorded validation |
| --- | --- | --- |
| Local files | CSV and Parquet read; CSV export | DuckDB 2.0.0, Python 3.13.12, Linux x86_64; unit/native-equivalence tests, browser example and million-row benchmark |
| S3 | CSV and Parquet read; CSV export | DuckDB 2.0.0 with matching `httpfs`, Linux x86_64; Moto S3 emulator on localhost; repeated native destination replacement |
| Oracle | Read attached tables; export to an existing table with OraDuck | DuckDB 2.0.0, signed community OraDuck 0.4.0, Oracle 19.3, Oracle Instant Client 19.32, Linux x86_64 |

The table records connector validation of the embedded engine. The isolated HTTP worker additionally requires Linux Landlock; local CSV/Parquet execution, exports and lineage are covered by the account/permission tests. Remote S3/Oracle deployments need validation with their extension and network policy in this execution mode.

These are the tested combinations, not claims that every newer DuckDB or operating-system build has been validated. A matching extension build is required for the installed DuckDB version. Other platforms and live AWS deployments need validation in their own environment. Raw results are in `docs/validation/`.

## Local files

The `local` connection is available in `dev` and `prod` and supports an optional root directory. CSV exposes header, delimiter and a JSON type-override map; `{}` retains native inference. Parquet uses native types. Absolute paths must fall within the project's resources/exports or an explicitly granted local connection root. Roots must exclude instance metadata and other projects. Uploads are scoped to the active project. Relative default exports resolve under `exports/<worktree>/<environment>/` when no connection root is set.

Single-file CSV `COPY` follows DuckDB's native replacement behavior on a second run. Duckpad does not add an overwrite option, rename files, or ask for an existence-based confirmation.

## S3

Configure access key ID, secret access key, region and endpoint per environment. The preset loads `httpfs` and creates a temporary S3 secret. Use `s3://bucket/key.csv` or a Parquet object URI in the ordinary file nodes. `use_ssl` defaults to true and `url_style` to `vhost`; a local S3-compatible endpoint can use false and `path` respectively.

The local integration test validates both read formats, a join, CSV export, connection reuse, lineage and replacement of the same destination. It does not validate real AWS credentials, IAM policies, TLS configuration or every provider's object-storage behavior.

```sh
uv sync --group integration
uv run python scripts/integration.py s3 --output docs/validation/s3.json
```

## Oracle / OraDuck

Install Oracle Instant Client 19 or newer, Basic or Basic Light, compatible with the extension and platform. On Linux, make its shared libraries discoverable and install the platform's `libaio`/`libnsl` prerequisites. The extension build must match the exact DuckDB ABI. The application uses a private extension directory, so an unrelated unsigned developer extension in the user's global DuckDB cache cannot be loaded accidentally.

The preset creates a temporary secret with `TYPE oraduck`, `USER`, `PASSWORD` and `DSN`, then uses `ATTACH` for read-only access. Source nodes select a connection, schema and resource. Export nodes emit `COPY (SELECT ...) TO ... (FORMAT oraduck, CONNECTION ...)` targeting an existing Oracle table; the columns expression supports explicit mapping. The destination table must already exist and be compatible with the selected columns.

Before each manual run, relevant attachments are recreated to refresh schema metadata. Materialized Duckpad results remain independent of those attachments. Export behavior is native OraDuck behavior: there is no hidden truncate, table recreation or extra write. The integration test compares native and generated exports, checks repeated appends, adds a source column and row between launches, then verifies refresh and cell lineage through the same logical connection.

```sh
# Supply credentials through the environment; do not put them in project files.
export ORADUCK_ORACLE_USER=...
export ORADUCK_ORACLE_PASSWORD=...
export ORADUCK_ORACLE_DSN=host:1521/service
uv run python scripts/integration.py oracle --output docs/validation/oracle.json
```

The script creates uniquely named disposable test tables and drops only those tables in its cleanup. Credentials are never included in its report. See the [OraDuck documentation](https://raw.githubusercontent.com/hugues31/oraduck/main/README.md) for deployment prerequisites.

## Add another connector

```json
{
  "id": "warehouse",
  "name": "Attached DuckDB warehouse",
  "description": "An existing DuckDB file",
  "parameters": [{"name": "database", "type": "file"}],
  "extensions": [],
  "capabilities": ["read", "write"],
  "init_sql": "ATTACH {{ database }} AS {{ alias }};",
  "compatibility": "Validate with the installed DuckDB version"
}
```

Create a named connection pointing to different database files in `dev` and `prod`. A source template can read `{{ connection }}.{{ resource }}`; an export template can explicitly `INSERT INTO` a declared attached destination from its input. This exact extension-free scenario is covered by `tests/test_catalog.py`, including reuse and historical project code using current catalog settings.

Connection parameter types are text, file, number, boolean and choice. Secret parameters add `"secret": true`. Setup placeholders use type-aware SQL escaping; `alias` and `secret_name` are reserved runtime identifiers. Setup permits declared extension loading, `CREATE OR REPLACE TEMPORARY SECRET {{ secret_name }}` and `ATTACH ... AS {{ alias }}`. Data queries and writes belong in source/export nodes and are rejected in initialization. Extensions are installed and loaded from the declared repository when needed.
