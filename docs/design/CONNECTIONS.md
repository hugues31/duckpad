# Connections, file storage and extensions (design proposal)

**Status: accepted on 1 November 2026 (see [Decisions](#decisions)). Steps 1 to 3 are implemented: project files without a connection, the removal of the Excel connector, and Server folder with connector families and customizable built-ins. Step 4, the database family, has its own ticket.**

## Summary

**Instance settings → Connections** offers four connectors: Local files, Excel (XLSX), Amazon S3 and Oracle · OraDuck. Every new project also receives a default Local workspace connection. Now that projects can enable DuckDB extensions themselves, should Local files and Excel stay there? Should connections only store credentials such as a host, a user and a password?

This proposal answers from the user's point of view, with Postgres, Snowflake and other databases in mind:

1. **Remove Excel (XLSX) from connections.** XLSX is a file format, like CSV and Parquet. Which formats a project reads is a node and extension concern; where the file lives is a connection concern.
2. **Keep server folders as connections, but stop requiring one for project files.** A folder with different paths in dev and prod, granted to some projects by an administrator, is a real connection even without a password. The default Local workspace connection is not: it grants access the project already has.
3. **Define a connection as "where data lives and how to reach it in each environment".** Credentials follow from that definition but do not make it. Connections then fall into two families, databases and file storage, and every file format node works with every file storage connection.
4. **Keep connector types open to administrators.** Duckpad will not ship a connector for every database. Administrators already declare and edit connector types as JSON; the plan makes custom types work like built-in ones and keeps customized built-ins across upgrades.
5. **Break compatibility where it simplifies the model.** Duckpad has no earlier version to support, so the steps remove obsolete connectors, connections and template defaults instead of keeping them working. See [Compatibility](#compatibility).

## What users experience today

Checked on DuckDB 2.0.0, the runtime Duckpad ships, in both the embedded and the isolated execution modes.

- **Reading an uploaded workbook needs an administrator.** New projects include the Load XLSX and Export XLSX templates, but a fresh instance has no `xlsx` connection and never grants one automatically. A member who uploads a workbook into their own project cannot read it until an instance administrator creates the connection and grants it to the project; `tests/test_xlsx.py` asserts the 403 response. The same upload as CSV works immediately. Nothing tells the member why one format needs an administrator.
- **The Excel connector duplicates Local files.** Both declare the same single `root` parameter. The only difference is `extensions: [excel]`, and Duckpad's runtime links `excel` statically, so that declaration loads nothing new. Load XLSX and Export XLSX already succeed with `connection: local`. An administrator who shares one folder for CSV and XLSX files must configure its path twice in each environment.
- **Format and location are tied together.** Reading a workbook from S3 would need an "Excel on S3" connector, and each new format multiplies connectors by locations. The S3 connector is described as "CSV and Parquet in S3-compatible object storage" for the same reason.
- **Every file node asks for a connection.** Load CSV, Load Parquet and Export CSV show a **connection** field set to Local workspace. Project uploads and default exports never need it: the isolated worker always grants access to the project's resources and to its exports directory, whatever the connections. The default grant only adds a way to break CSV: if an administrator revokes it, the project can no longer read its own uploads, and a file node cannot be left without a connection.
- **"Local" is ambiguous on a server.** The connector reads "CSV and Parquet on this computer". In a shared deployment, "this computer" is the server, not the member's laptop: a path such as `C:\Users\...` fails with a file-not-found error.

## Principles

- **A connection says where data lives and how to reach it, per environment.** Host, bucket, folder, account, warehouse, role and credentials. Switching environments changes connection values, never the project.
- **An extension says what DuckDB can read or compute.** Formats (XLSX, spatial files) and functions (statistics) are project extensions, enabled in the project's **Extensions** tab and versioned with the project.
- **A node says what to read or write, and with which options.** Sheet, header, delimiter, schema, table.
- **Project files need no configuration.** Uploading a file and reading it works for every supported format, without an administrator.
- **Administrators govern access to external systems, not formats.** Granting a project a database or a server folder remains an administrator decision.

Extensions needed to *reach* a system (`postgres`, `httpfs`, `oraduck`) stay declared by its connector and load automatically. A member who is granted a Postgres connection should not also have to enable `postgres` in every project.

## Target model

| | Examples | Values per environment | Used by |
| --- | --- | --- | --- |
| **Databases and warehouses** | Postgres, MySQL, Oracle, Snowflake, BigQuery | Host, port, database, user, password; account, warehouse, role | Table nodes: Load table and Export table, with schema and table selection |
| **File storage** | Server folder, S3; later GCS, Azure Blob, SFTP | Root path; bucket, prefix, region, credentials | Every file format node, through its **Location** field |
| **Project files** (not a connection) | Uploads and default exports | None | Every file format node, by default |

### File nodes

Every file node (Load or Export CSV, Parquet, XLSX and later JSON) labels its connection field **Location**. It defaults to **Project files** and lists the file storage connections granted to the project. Relative paths resolve against the chosen location. With **Project files**, a relative source path resolves under the project's resources, where uploads land, and a relative destination under the exports directory of the worktree in the selected environment. Absolute paths remain restricted to project files and granted roots, as today.

The template language needs no new syntax: an empty `connection` parameter means project files. Built-in templates drop their `local` and `xlsx` defaults, and the default Local workspace connection is removed with its grants.

When a format needs an extension that is neither built into the runtime nor enabled in the project, the node error names the extension to enable in the **Extensions** tab.

### Database nodes

A database connection attaches the remote database with a temporary secret (`ATTACH ... AS {{ alias }}`), as OraDuck does today. Generic Load table and Export table templates select a connection, a schema and a table; the inspector can list them from the attachment. Writes stay explicit, with no hidden truncation or table creation.

### Connections page

The page groups connections into **Databases and warehouses** and **File storage**. A fresh instance lists no connection, instead of a Local workspace entry nobody configures. The connector catalog drops Excel (XLSX), replaces Local files with **Server folder** (identifier `folder`, "A folder on the Duckpad server, with a path for each environment") and describes S3 without naming formats.

## Custom connector types

Duckpad cannot ship and validate a connector for every database or storage service. A system that a DuckDB extension can reach must be usable without changing Duckpad's code, and a built-in connector that lacks a setting must not wait for a release.

### What already works

- **Administrators declare connector types.** In **Instance settings → Connections**, **New connector** opens a JSON editor, and `PUT /api/catalog/connector` accepts the same object. Typed parameters (text, number, boolean, file and choice, with defaults and secrets) generate the connection form for each environment. Setup may load declared extensions from the core or community repository, create a temporary secret and attach a database as `{{ alias }}`.
- **Built-in connectors are editable.** They are ordinary catalog entries, seeded once, and each has an **Edit** button. An administrator can add a `session_token` parameter to S3 and pass it to the secret, and upgrades do not overwrite the change. Saving under a new identifier creates a copy.
- **An attached database already works in nodes.** Any source template that reads `{{ connection }}.{{ schema }}.{{ resource }}` accepts every granted connection with the read capability. `tests/test_catalog.py` covers an administrator-declared connector that attaches a different DuckDB file in each environment. A Postgres definition written the same way passes today's validation.

### What is missing

- **Custom types have no family.** The grouped Connections page cannot place them, file nodes cannot offer a custom storage as a location, and a custom database is read through the template labeled Load Oracle.
- **Storage roots must be local paths.** Relative paths are joined to the root as filesystem paths, so the root `s3://bucket/landing` and the file `a.csv` become `s3:/bucket/landing/a.csv`.
- **A customized built-in cannot be reset.** Built-ins are copied into the catalog once, when the database is created. Nothing distinguishes an edited built-in from the shipped definition, a later release cannot fix a built-in without overwriting edits, and an administrator has no way back to the shipped version. Copies exist only as a side effect of changing the identifier.
- **Every missing setting needs a definition change.** Built-in connectors expose a fixed list of parameters.
- **Nothing tests a definition before a project uses it.** Extensions are native code. On a processor without AVX2, the published `postgres` extension for DuckDB 2.0.0 installs, then stops the Python process with an illegal instruction when it loads. In embedded execution, that crash would stop the Duckpad server.

### Proposal

- **Families.** Every definition declares `family: database` or `family: storage`; validation rejects a definition without it. Custom types are grouped, listed and offered exactly like built-in ones.
- **Storage roots.** A storage connector declares a `root` parameter, either a folder or a URI prefix such as `gs://bucket/landing/`. File nodes offer every granted storage connection as a location. Relative paths are appended to the root without altering a URI.
- **Generic table nodes.** Load table reads `{{ connection }}.{{ schema }}.{{ table }}` and Export table inserts into it, for every database connection. A connector whose write path is not `INSERT`, such as OraDuck, keeps its own export template.
- **Built-in and customized definitions.** Built-in definitions come with each release instead of being copied into the catalog, and show a **Built-in** badge. Editing one stores the administrator's version as an override: the definition is marked **Customized**, keeps the edit across upgrades, and **Reset to built-in** deletes the override. An unedited built-in always matches the running release. **Duplicate** creates an editable copy under a new identifier.
- **Additional options.** Built-in database connectors expose an optional **Additional options** parameter, passed to the driver as is: libpq keywords such as `sslmode=require application_name=duckpad` for Postgres. Most missing settings then need no definition change.
- **Test connection.** The connection form runs the setup of one environment in a separate process and reports the error. An incompatible extension, a wrong password or an unreachable host shows up before any project run.
- **Shared definitions.** Definitions remain JSON. The connector guide publishes examples beyond the built-ins, such as MySQL and SQLite. A community contribution is a definition plus a validation record, the same evidence the built-ins have.

Two boundaries stay in place:

- **Only instance administrators define connector types.** A definition loads native extensions and runs setup on the server, and allowing unsigned extensions remains an instance setting. Members still see only the connections granted to their projects.
- **Duckpad reaches what DuckDB extensions reach.** A system without an extension needs one, whether core, community or private, rather than connector code in Duckpad. Air-gapped instances import it like any other extension.

## User journeys

1. **Read an uploaded workbook.** A member uploads `budget.xlsx`, adds Load XLSX and runs it. No connection and no administrator are involved. Today, this is blocked until an administrator creates and grants an `xlsx` connection.
2. **Read a shared folder in dev and prod.** An administrator creates *Finance share*, a Server folder with `/srv/finance-dev` in dev and `/srv/finance` in prod, and grants it to the Finance project. The member selects *Finance share* as the location of Load CSV or Load XLSX and enters `inbox/budget.xlsx`. A production run reads the production folder without any project change.
3. **Query a warehouse.** An administrator creates *Warehouse*, a Snowflake connection with a development database and role in dev and production ones in prod. The member adds Load table and selects *Warehouse*, a schema and a table. Credentials never reach the project or its Git history.
4. **Read a workbook from object storage.** The member selects the *Landing bucket* location in Load XLSX; no "Excel on S3" connector is needed. Remote XLSX is outside today's validated scope and needs its own validation.
5. **Add a database Duckpad does not ship.** An administrator pastes the MySQL example into **New connector**, creates *CRM* with a host for dev and another for prod, tests both and grants the connection. Members read it with Load table, as they would read Postgres.
6. **Expose a missing setting.** The production Postgres server requires `sslmode=verify-full`. The administrator adds it to **Additional options** in that connection's prod values. For a setting the driver cannot take there, they edit the built-in definition; Duckpad marks it Customized and keeps it across upgrades.

## What other tools do

- **Dataiku DSS**: administrators manage connections to SQL databases, cloud storage and the server filesystem, the latter with a root path that contains its datasets, and decide which groups may use each one. Excel is a file format available on any file-based connection or upload, never a connection.
- **KNIME**: standard file systems (local, relative to the workflow, mountpoints) need no connector node. Connected file systems such as S3 or SMB come from a connector node plugged into the same CSV or Excel reader. Format and location are independent.
- **dbt**: `profiles.yml` holds one connection per warehouse, with one target per environment, the same shape as a Duckpad connection with environment values.

## Compatibility

Duckpad has no earlier version to support: no installation, project or catalog has to keep working across these steps. Breaking changes are allowed, and the steps need no migration path:

- The `xlsx` connector is deleted, with its connections and grants. Load XLSX and Export XLSX use project files or a storage location, like every other format.
- The `local` connector and the default Local workspace connection are deleted. Server folder takes the identifier `folder`.
- Built-in templates drop their `local` and `xlsx` defaults. Templates already copied into projects are not rewritten.
- `family` is mandatory, with no inference for definitions written before it existed.
- Built-in definitions are read from the release; catalog rows seeded by earlier versions are not converted into overrides.

An instance or project created before a step may need to be recreated.

## Alternatives considered

- **Keep Excel as a connection, created and granted automatically.** This removes the administrator step but keeps the duplicated roots and the coupling of format and location; each new format would still need a connector.
- **Remove Local files and accept any absolute path.** Simple for a single-user installation, but on a shared server every editor would reach the whole filesystem, which the isolated mode exists to prevent.
- **Connections for credentials only, folders in project settings.** Server paths would land in project Git and editors could choose them, losing administrator control and the per-environment paths.
- **Connectors as Python plugins.** Each connector would run arbitrary code in the server. DuckDB extensions already reach external systems, and they run inside the isolated worker.
- **Connector types defined by members.** Setup loads native code and reaches the network from the server, so it remains an administrator decision, like granting a connection.
- **Read-only built-ins, customized only by copy.** Upgrades would stay simple, but every site-specific setting would fork a built-in and miss its later fixes. Additional options and Reset to built-in cover the common case.
- **A separate Storage page.** Folders, buckets and databases share the same shape (a location and optional credentials per environment, granted per project); grouping them on one page is enough.

## Delivery plan

1. **Project files without a connection.** An empty connection on a file node means project files. Built-in CSV, Parquet and XLSX templates default to it, the inspector labels the field **Location**, and the Local workspace connection and its grants are removed.
2. **Remove the Excel connector.** Delete the `xlsx` connector, report an actionable error when `excel` is neither built in nor enabled, and update the connector guide and its screenshots.
3. **Server folder, families and customizable built-ins.** Replace Local files with Server folder, describe S3 without naming formats, make `family` mandatory and group the page by it, custom types included. Offer every storage connection as a location, with URI roots. Ship built-ins with the release, store administrator edits as overrides, and add Reset to built-in and Duplicate.
4. **The database family, validated with Postgres.** Ship Postgres as a plain JSON definition with Additional options, add generic Load table and Export table templates and Test connection, and provide a `postgres` build that runs on the server's processor. Acceptance includes an administrator-declared connector, such as the attached DuckDB file example, working through the same templates without code changes. Snowflake or BigQuery follow the same path.

## Decisions

Decided on 1 November 2026:

1. **The four-step delivery plan**, with one ticket per step.
2. **Custom connector types stay open to instance administrators**, including edits to built-ins that expose a missing parameter.
3. **Connector types are edited as JSON**, with published examples; no form-based editor.
4. **No earlier version to support.** Breaking changes are allowed; see [Compatibility](#compatibility).
5. **Project files resolve relative source paths under the project's resources**, where uploads land, and relative destinations under the environment's exports directory.
6. **The Extensions tab is the only way a project loads a format's extension.** Built-in templates do not declare extensions, and execution sessions never load or download an extension on demand, in embedded or isolated mode. On a runtime that does not link `excel` statically, a project enables it in its **Extensions** tab, guided by the node error that names it. A template declaration would only save that checkbox: an administrator still installs the binary on such runtimes, and the project's requirements would no longer all be listed in `extensions.json`. Duckpad's container image links `excel`, so its deployments need neither; a `pip install` uses DuckDB's PyPI wheel, which does not, so its administrator imports `excel` once.

## Sources

- [Dataiku DSS: connections](https://doc.dataiku.com/dss/latest/connecting/connections.html), [server filesystem](https://doc.dataiku.com/dss/latest/connecting/filesystem.html) and [Excel format](https://doc.dataiku.com/dss/latest/formats/excel.html)
- [KNIME file handling guide](https://docs.knime.com/latest/analytics_platform_file_handling_guide/index.html)
- [dbt connection profiles](https://docs.getdbt.com/docs/core/connect-data-platform/connection-profiles)
- [DuckDB Postgres extension](https://duckdb.org/docs/stable/core_extensions/postgres.html)
- [Connections and connector compatibility](../CONNECTORS.md) and [DuckDB extensions without Internet access](../OFFLINE_EXTENSIONS.md)
