# Connections, file storage and extensions (design proposal)

**Status: proposal awaiting review. Nothing is implemented.**

## Summary

**Instance settings → Connections** offers four connectors: Local files, Excel (XLSX), Amazon S3 and Oracle · OraDuck. Every new project also receives a default Local workspace connection. Now that projects can enable DuckDB extensions themselves, should Local files and Excel stay there? Should connections only store credentials such as a host, a user and a password?

This proposal answers from the user's point of view, with Postgres, Snowflake and other databases in mind:

1. **Remove Excel (XLSX) from connections.** XLSX is a file format, like CSV and Parquet. Which formats a project reads is a node and extension concern; where the file lives is a connection concern.
2. **Keep server folders as connections, but stop requiring one for project files.** A folder with different paths in dev and prod, granted to some projects by an administrator, is a real connection even without a password. The default Local workspace connection is not: it grants access the project already has.
3. **Define a connection as "where data lives and how to reach it in each environment".** Credentials follow from that definition but do not make it. Connections then fall into two families, databases and file storage, and every file format node works with every file storage connection.

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

Every file node (Load or Export CSV, Parquet, XLSX and later JSON) labels its connection field **Location**. It defaults to **Project files** and lists the file storage connections granted to the project. Relative paths resolve against the chosen location. Absolute paths remain restricted to project files and granted roots, as today.

The template language needs no new syntax: an empty `connection` parameter means project files. Templates already versioned in projects keep their `local` default, which keeps working.

When a format needs an extension that is neither built into the runtime nor enabled in the project, the node error names the extension to enable in the **Extensions** tab.

### Database nodes

A database connection attaches the remote database with a temporary secret (`ATTACH ... AS {{ alias }}`), as OraDuck does today. Generic Load table and Export table templates select a connection, a schema and a table; the inspector can list them from the attachment. Writes stay explicit, with no hidden truncation or table creation.

### Connections page

The page groups connections into **Databases and warehouses** and **File storage**. A fresh instance lists no connection, instead of a Local workspace entry nobody configures. The connector catalog drops Excel (XLSX), renames Local files to **Server folder** ("A folder on the Duckpad server, with a path for each environment") and describes S3 without naming formats.

## User journeys

1. **Read an uploaded workbook.** A member uploads `budget.xlsx`, adds Load XLSX and runs it. No connection and no administrator are involved. Today, this is blocked until an administrator creates and grants an `xlsx` connection.
2. **Read a shared folder in dev and prod.** An administrator creates *Finance share*, a Server folder with `/srv/finance-dev` in dev and `/srv/finance` in prod, and grants it to the Finance project. The member selects *Finance share* as the location of Load CSV or Load XLSX and enters `inbox/budget.xlsx`. A production run reads the production folder without any project change.
3. **Query a warehouse.** An administrator creates *Warehouse*, a Snowflake connection with a development database and role in dev and production ones in prod. The member adds Load table and selects *Warehouse*, a schema and a table. Credentials never reach the project or its Git history.
4. **Read a workbook from object storage.** The member selects the *Landing bucket* location in Load XLSX; no "Excel on S3" connector is needed. Remote XLSX is outside today's validated scope and needs its own validation.

## What other tools do

- **Dataiku DSS**: administrators manage connections to SQL databases, cloud storage and the server filesystem, the latter with a root path that contains its datasets, and decide which groups may use each one. Excel is a file format available on any file-based connection or upload, never a connection.
- **KNIME**: standard file systems (local, relative to the workflow, mountpoints) need no connector node. Connected file systems such as S3 or SMB come from a connector node plugged into the same CSV or Excel reader. Format and location are independent.
- **dbt**: `profiles.yml` holds one connection per warehouse, with one target per environment, the same shape as a Duckpad connection with environment values.

## Migration

Projects store connection references in Git, so existing references keep working:

- Fresh catalogs stop seeding Excel (XLSX). Existing `xlsx` connector definitions, connections and grants stay valid, and nodes that reference them keep running.
- Local files keeps the identifier `local`; only its display name and description change, so existing connections and node parameters are unaffected.
- New projects stop receiving the Local workspace grant once file nodes no longer need it. Existing grants remain.
- New built-in templates default to project files. Existing projects keep their versioned templates until someone updates them, as for any template change.

## Alternatives considered

- **Keep Excel as a connection, created and granted automatically.** This removes the administrator step but keeps the duplicated roots and the coupling of format and location; each new format would still need a connector.
- **Remove Local files and accept any absolute path.** Simple for a single-user installation, but on a shared server every editor would reach the whole filesystem, which the isolated mode exists to prevent.
- **Connections for credentials only, folders in project settings.** Server paths would land in project Git and editors could choose them, losing administrator control and the per-environment paths.
- **A separate Storage page.** Folders, buckets and databases share the same shape (a location and optional credentials per environment, granted per project); grouping them on one page is enough.

## Delivery plan

1. **Project files without a connection.** An empty connection on a file node means project files. Built-in CSV, Parquet and XLSX templates default to it, the inspector labels the field **Location**, and new projects no longer receive the Local workspace grant.
2. **Retire the Excel connector.** Stop seeding it in fresh catalogs, report an actionable error when `excel` is neither built in nor enabled, and update the connector guide and its screenshots.
3. **Server folder and a grouped Connections page.** Rename and describe Local files, describe S3 without naming formats, and group the page by family.
4. **A first credential-based database connector.** Postgres, a core DuckDB extension, with generic Load table and Export table templates, validates the database family before Snowflake or BigQuery.

## Open questions

- A relative source path currently resolves under the environment's exports directory, while uploads land in the project's resources. Should Project files resolve relative source paths under resources instead?
- On runtimes that do not link `excel` statically, should built-in templates declare the extensions they need, or should the **Extensions** tab remain the only mechanism?

## Sources

- [Dataiku DSS: connections](https://doc.dataiku.com/dss/latest/connecting/connections.html), [server filesystem](https://doc.dataiku.com/dss/latest/connecting/filesystem.html) and [Excel format](https://doc.dataiku.com/dss/latest/formats/excel.html)
- [KNIME file handling guide](https://docs.knime.com/latest/analytics_platform_file_handling_guide/index.html)
- [dbt connection profiles](https://docs.getdbt.com/docs/core/connect-data-platform/connection-profiles)
- [DuckDB Postgres extension](https://duckdb.org/docs/stable/core_extensions/postgres.html)
- [Connections and connector compatibility](../CONNECTORS.md) and [DuckDB extensions without Internet access](../OFFLINE_EXTENSIONS.md)
