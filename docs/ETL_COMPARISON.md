# Duckpad, Alteryx and Dataiku: ETL and data engineering

Reviewed on **2026-10-26**, against Duckpad **0.2.0**, source commit
`717796e7311af752564b334472b51d36b49f8154`.

Duckpad already provides a useful interactive SQL pipeline workbench: visual
composition, reusable components, Git history, project permissions and detailed
cell provenance. Its largest gaps for recurring ETL are **operational automation,
connector coverage, reliable incremental writes and data quality controls**.
For an analyst moving from Alteryx, **Excel support and guided preparation tools**
would be the most immediate obstacles. For a team moving from Dataiku, **production
deployment, managed datasets and operational governance** would become obstacles
as workflows grow.

These priorities are an assessment of the evidence below, not a claim of complete
feature parity or a committed implementation roadmap.

## Scope and method

- Include ingestion, preparation, transformation, delivery, orchestration,
  observability, collaboration and operation of data pipelines. Exclude data
  science, machine learning, model serving, AI assistants and BI/report design.
- Duckpad findings come from implementation, tests and documentation. Planned
  features in the specification are not counted as delivered. **Built-in** means
  a shipped user workflow; **partial** means a narrower implementation or custom
  SQL/configuration is required; **missing** means no product capability was found
  in the reviewed source. Missing does not mean impossible to implement using
  DuckDB or an external system.
- Compare **Alteryx Designer Desktop**, adding **Server** explicitly for scheduling,
  sharing and operational deployment. Alteryx One cloud offerings are not treated
  as features automatically included with Designer. Tool access, drivers,
  connectors and Server depend on edition, role and installation.
- Compare **Dataiku DSS**, including its Automation Node and Project Deployer
  where named. The official `latest` documentation consulted identifies itself as
  DSS 15; this is the documentation baseline, not a claim about the version or
  license available in every installation. Alteryx links use its rolling
  `current` documentation. Both vendors' entitlements require separate checking.
- Vendor capabilities are documentation-verified, not tested in live vendor
  installations. This review makes no comparative throughput, cost or universal
  connector-compatibility claims.

## What Duckpad already covers

| Area | Delivered capability | Evidence and boundary |
| --- | --- | --- |
| Visual SQL authoring | Connected nodes, typed parameters, SQL editor, guided filter/join/aggregate forms and multiple outputs | [Built-in templates](../src/duckpad/builtin_templates.py), [query builder](../frontend/src/QueryBuilder.tsx), [authoring](AUTHORING.md). Nine default templates; SQL remains the extension mechanism. |
| Relational transformation | Joins, grouping, expressions, distinct values, set operations, window calculations and reusable SQL | [Native-equivalence tests](../tests/test_native_semantics.py), [example](EXAMPLE.md). SQL capability is broader than the palette of guided tools. |
| Reuse | Nested components, exposed parameters and cross-project imports | [Components](../src/duckpad/components.py), [authoring](AUTHORING.md). Imports are independent copies, not centrally managed package dependencies. |
| Data access | CSV/Parquet readers, CSV export, local/S3/Oracle presets, declarative custom connectors and separate environment settings | [Catalog](../src/duckpad/catalog.py), [connector validation](CONNECTORS.md). Oracle exports target existing tables. Recorded S3 validation uses an emulator; remote connectors still need validation in the isolated HTTP execution mode. |
| Inspection and provenance | Sortable/filterable previews, schemas, counts and cell-level explanations over retained execution data | [Lineage coverage](LINEAGE.md), [lineage tests](../tests/test_lineage.py). Unsupported constructs report incomplete provenance; results and lineage do not survive restart. |
| Versioning and collaboration | Autosave commits, branches, visual comparisons, reviewed merges, remote synchronization and conflict handling | [Git guide](GIT.md), [Git tests](../tests/test_git_workspace.py). Git versions project definitions, not source data or instance connection configuration. |
| Access control | Individual accounts, instance roles, reader/editor/admin project roles, connection grants and isolated SQL workers | [Access implementation](../src/duckpad/access.py), [permission tests](../tests/test_access.py), [architecture](ARCHITECTURE.md). This is already a multiuser foundation. |
| Execution control | Manual UI/API runs, node scope, cancellation, durable run history, SQL/timings/errors and resource monitoring | [Engine](../src/duckpad/engine.py), [API](../src/duckpad/app.py), [execution tests](../tests/test_execution.py). One active run per worktree; busy requests are rejected, not queued. |

Do not classify SQL windows, components, authentication, Git, environment settings,
an execution API or run history as absent. Their remaining gaps are in breadth and
operational guarantees.

## Capability comparison

Priorities assume the aim is a practical batch ETL product for small teams.
**P0** blocks dependable unattended pipelines; **P1** materially limits adoption or
production use; **P2** depends on workload and organization size. These are product
priorities, not defect severities.

| Capability | Duckpad today | Alteryx | Dataiku DSS | Gap priority |
| --- | --- | --- | --- | --- |
| Files, databases and business applications | **Partial:** three presets; no shipped Excel, JSON, PostgreSQL, SQL Server, Snowflake, BigQuery or SaaS onboarding workflows | Designer documents many [file/database sources](https://help.alteryx.com/current/en/designer/data-sources.html) and [connector tools](https://help.alteryx.com/current/en/designer/tools/designer-tools-list.html), with source-specific read/write support | Broad [connection catalog](https://doc.dataiku.com/dss/latest/connecting/index.html), including SQL, object stores, HTTP/SFTP and business applications; some require plugins | **P1**, first for analyst adoption |
| Guided data preparation | **Partial:** filter, join and aggregate forms; most other transformations require SQL | [Preparation/transform tools](https://help.alteryx.com/current/en/designer/tools/designer-tools-list.html), [parsing](https://help.alteryx.com/current/en/designer/tools/parse.html), [fuzzy matching and unions](https://help.alteryx.com/current/en/designer/tools/join.html) | [Visual recipes](https://doc.dataiku.com/dss/latest/visual-recipes/index.html) and interactive [Prepare recipes](https://doc.dataiku.com/dss/latest/preparation/index.html) | **P1** |
| Profiling and quality gates | **Partial:** previews/counts/types and custom SQL; **missing:** reusable quality rules, profiling UI, quality history and schema-drift policies | Designer [Browse](https://help.alteryx.com/current/en/designer/tools/in-out-tools/browse-tool.html) profiles data; [Test](https://help.alteryx.com/current/en/designer/tools/developer/test-tool.html) checks counts and expressions | [Data Quality rules](https://doc.dataiku.com/dss/latest/metrics-check-data-quality/data-quality-rules.html) include uniqueness, emptiness, value ranges and schema expectations, with monitoring views | **P0** for production delivery |
| Scheduling and triggers | **Missing:** schedules, authenticated event/webhook triggers and missed-run handling; manual launch API exists | **Server** [schedules workflows](https://help.alteryx.com/current/en/server/use-alteryx-server-ui/schedules--server-user-interface/schedule-a-workflow.html); [API](https://help.alteryx.com/current/en/server/api-overview.html) submits jobs | [Scenarios](https://doc.dataiku.com/dss/latest/scenarios/index.html) and [triggers](https://doc.dataiku.com/dss/latest/scenarios/triggers.html) automate builds and dependencies | **P0** |
| Operational monitoring and recovery | **Partial:** persisted history, cancellation and interrupted-run reporting; **missing:** alert delivery, retry policies, queue/admission policies for automation and recovery checkpoints | **Server** has [job APIs](https://help.alteryx.com/current/en/server/api-overview.html), [logs](https://help.alteryx.com/current/en/server/configure/configure-and-use-server-logs.html) and worker/priority selection in [schedules](https://help.alteryx.com/current/en/server/use-alteryx-server-ui/schedules--server-user-interface/schedule-a-workflow.html) | [Scenario reporters and conditional steps](https://doc.dataiku.com/dss/latest/scenarios/index.html) support operational workflows | **P0**; retry safety must precede automatic replay |
| Incremental processing and destinations | **Partial:** explicit CSV replacement, Oracle append and custom `COPY`/`INSERT`; **missing:** managed watermarks, partition rebuilds, idempotent loads, upsert/SCD workflows and CDC ingestion | [Output tools](https://help.alteryx.com/current/en/designer/tools/in-out-tools/output-data-tool.html) and [Write In-DB](https://help.alteryx.com/current/en/designer/tools/in-database/write-data-in-db-tool.html) provide destination-specific write modes | [Partitioned datasets](https://doc.dataiku.com/dss/latest/partitions/index.html), [Sync](https://doc.dataiku.com/dss/latest/visual-recipes/sync.html) and [SQL recipes/pipelines](https://doc.dataiku.com/dss/latest/sql/pipelines/index.html) provide building blocks | **P0** for repeatable writes; incremental volume optimization **P1** |
| Persistent datasets and compute placement | **Partial:** local DuckDB and isolated workers; intermediate datasets are in memory, every requested ancestor is rerun | Designer [In-DB](https://help.alteryx.com/current/en/designer/tools/in-database-overview.html) runs supported transformations in the database | [SQL execution](https://doc.dataiku.com/dss/latest/sql/index.html), [SQL pipelines](https://doc.dataiku.com/dss/latest/sql/pipelines/index.html) and [Sync engines](https://doc.dataiku.com/dss/latest/visual-recipes/sync.html), including Spark, support different placements | **P1** for retention/pushdown; distributed execution **P2** |
| Development-to-production promotion | **Partial:** branches, ZIP definition export and dev/prod connection values; **missing:** versioned deployment bundles, promotion checks and runtime rollback | **Server** supports [workflow migration between environments](https://help.alteryx.com/current/en/server/administer-alteryx-server/workflows--admin-interface/enable-workflows-for-migration.html) | **Automation Node/Project Deployer** supports [project bundles](https://doc.dataiku.com/dss/latest/deployment/index.html), deployment health and [connection remapping](https://doc.dataiku.com/dss/latest/deployment/deploying-bundles.html) | **P1** |
| Enterprise identity and audit | **Partial:** local accounts, project roles and connection grants; **missing:** SSO/directory integration, scoped machine credentials and a consolidated administrative audit trail | **Server** [authentication](https://help.alteryx.com/current/en/server/configure/configure-alteryx-server-authentication.html) and [audit API](https://help.alteryx.com/current/en/server/api-overview/alteryx-server-api-v1/auditlog-endpoint.html); Designer [DCM](https://help.alteryx.com/current/en/designer/tools/in-out-tools/output-data-tool.html) manages connections | [Identity integration](https://doc.dataiku.com/dss/latest/security/authentication/index.html) and [audit trail](https://doc.dataiku.com/dss/latest/operations/audit-trail/index.html) | **P1** for shared enterprise use; scoped automation identity belongs with P0 automation |
| Asset discovery and reuse at scale | **Partial:** project documentation, component/template library and execution cell lineage; **missing:** organization-wide dataset catalog and governed published data products | Designer [macros](https://help.alteryx.com/designer/current/en/apps-and-macros/macros.html) package reusable workflows; this alone is not an enterprise data catalog | [Catalog](https://doc.dataiku.com/dss/latest/catalog/index.html) and [Assets](https://doc.dataiku.com/dss/latest/catalog/assets.html) find and reuse datasets and indexed external tables | **P2** |
| Loops and non-SQL extensions | **Partial:** nested parameterized SQL components; **missing:** batch/iterative control-flow nodes and Python/custom-code recipe runtime | Designer has standard, batch and iterative [macros](https://help.alteryx.com/designer/current/en/apps-and-macros/macros.html) | [Code recipes](https://doc.dataiku.com/dss/latest/visual-recipes/index.html) and reusable [plugin recipes](https://doc.dataiku.com/dss/latest/plugins/reference/recipes.html) extend transformations | **P2**, earlier if APIs or complex parsing require it |

The incremental row does **not** imply that either competitor supplies universal
log-based CDC, exactly-once delivery or automatic slowly changing dimensions
(SCD). Those need separate source/destination-specific verification. Alteryx's
documented In-DB update/delete modes are limited to SQL Server ODBC, and its merge
mode to Databricks Unity Catalog; Dataiku partition builds are not equivalent to
database-log CDC. These distinctions matter when selecting a target behavior.

Cell-level execution provenance is also different from a dataset catalog or a
workflow dependency graph. Duckpad's [documented lineage](LINEAGE.md) is a strength
to preserve, with explicit SQL coverage limits. This review does not establish
that competitors lack equivalent cell explanations in every edition or extension.

## Recommended delivery sequence

The sequence below separates changes that extend the existing SQL workbench from
changes that introduce new operational contracts. Scope a small first release of
each capability before expanding connector or engine coverage.

### 1. Make repeated exports safe, then automate them

**Current evidence:** [Engine launch and execution](../src/duckpad/engine.py)
records a manual trigger, rejects concurrent runs for a worktree, reruns requested
ancestors and does not replay interrupted runs. [Export validation](../src/duckpad/templates.py)
accepts explicit `COPY` or `INSERT`, not arbitrary `UPDATE`, `DELETE` or `MERGE`
statements. [Connector behavior](CONNECTORS.md) preserves native writes: repeated
Oracle exports append, while a single CSV destination is replaced. Staging node
outputs atomically does not make external exports transactional.

**First useful slice:** define destination modes and a run/delivery identity for
one supported sink; record checkpoints and ambiguous outcomes. Then add persistent
schedules, authenticated triggers, bounded retries, failure notifications and
explicit busy/missed-run policies through the existing execution service. Add a
headless run/wait interface or scoped API credential for an external orchestrator.
The current CLI only starts the server; the existing session-authenticated run API
is a useful integration base. See the [execution-service decision](EXECUTION_SERVICE.md).

**Acceptance example:** deliver a daily batch twice and show no duplicate rows;
interrupt it during writing and demonstrate reconciliation before retry. Restart
the scheduler and demonstrate the specified missed-occurrence policy. Show who
triggered each run and notify its owner after failure. A timer alone does not meet
this requirement.

### 2. Cover common inputs and outputs as supported workflows

**Current evidence:** [Nine built-in templates](../src/duckpad/builtin_templates.py)
and [three catalog presets](../src/duckpad/catalog.py) cover a narrow, coherent
path. Custom connectors can expand it, but an underlying DuckDB extension does
not establish a supported Duckpad workflow.

**First useful slice:** Excel sheet/range input and output, JSON/nested-data input,
Parquet export, and one database selected from actual user demand, such as
PostgreSQL or SQL Server. Follow with warehouse/object-store choices and an HTTP
connector with authentication, pagination and rate-limit handling. Provide schema
discovery, connection tests, type mapping and documented read/write modes.

**Acceptance example:** import several Excel sheets, reconcile them with a database
table and publish a typed result without writing connector initialization SQL.
Test each connector through the same isolated worker and permissions used in the
application. Keep DuckDB 2.0 compatibility explicit.

### 3. Make data quality part of pipeline execution

**Current evidence:** [Preview](../frontend/src/Preview.tsx) and
[engine results](../src/duckpad/engine.py) expose types, counts and values. SQL can
compute validation results, but there is no reusable rule model with severity,
quality history, quarantine outputs or export gating. Tests of Duckpad itself are
not tests configured by a user for their own datasets.

**First useful slice:** profiles for nulls, distinct counts and ranges; assertions
for required columns/types, uniqueness, non-null fields, row counts and reference
integrity. Persist rule outcomes per run, distinguish warnings from failures and
make failed checks block dependent exports. Offer a rejected-row output where
appropriate.

**Acceptance example:** a missing source column or duplicate business key fails a
named check before publication, exposes offending rows and preserves the last
successful output. Clearly identify sampled profiles versus whole-dataset checks.

### 4. Reduce the amount of SQL needed for ordinary preparation

**Current evidence:** [Query builder](../frontend/src/QueryBuilder.tsx) has guided
filter, join and aggregation editing. Other relational operations can be expressed
in [SQL templates](AUTHORING.md), so the gap is primarily accessible authoring.

**First useful slice:** select/rename/cast, derive a column, trim/replace/fill nulls,
date parsing, split/extract, deduplicate, union, pivot/unpivot, sort and window
forms. Fuzzy matching and complex nested-data flattening can follow. Keep generated
SQL visible and preserve the same type and lineage contracts.

**Acceptance example:** an analyst cleans inconsistent customer/order files,
deduplicates keys, combines monthly extracts and produces a pivoted summary using
forms, with optional SQL editing at every stage.

### 5. Add managed incremental datasets and retention

**Current evidence:** [Architecture](ARCHITECTURE.md) and
[materialization](../src/duckpad/materialize.py) retain intermediate datasets only
for the live context. Durable run metadata and external export files already
exist; it is the managed intermediate/result lifecycle that is missing.

**First useful slice:** named persisted datasets with retention, partition keys,
watermarks, explicit rebuild ranges and schema-evolution rules. Define treatment
of late arrivals, updates and deletes; add destination upsert/SCD behavior where
justified. Start with one batch pattern before considering log-based CDC.

**Acceptance example:** process a new day without rereading all history, backfill
an older day, handle a corrected record and inspect a retained result after server
restart. Record which inputs and partitions produced it. Retention must also
address the storage cost of provenance.

### 6. Promote a reproducible pipeline release

**Current evidence:** [Git workflows](GIT.md) already provide substantial version
control. [Instance settings](ARCHITECTURE.md#files-and-data) are separate and have
no configuration-version history; rerunning old project code uses today's catalog.
Changing an environment selector is therefore not a controlled production release.

**First useful slice:** a release manifest identifying the project commit, required
connector/extension versions and non-secret configuration references; target
environment remapping, validation gates, authorized promotion and rollback.
Secrets should remain outside project Git. Application release automation and
developer preview deployment are separate from deploying users' ETL projects.

**Acceptance example:** promote a reviewed flow from test to production, verify its
connections and schemas without copying credentials, then roll back the deployed
definition. Document that rolling back code does not undo external data writes.

### 7. Extend shared-instance identity and governance

**Current evidence:** [Authentication](../src/duckpad/auth.py),
[authorization](../src/duckpad/access.py) and permission tests are real foundations.
Git history and execution records do not constitute a complete audit trail for
account, permission and connection changes.

**First useful slice:** SSO/directory groups, service identities and scoped tokens,
an administrative audit stream, and managed secret-provider integration. Add
owners, dataset documentation and a shared asset catalog as cross-project usage
grows. Fine-grained data policies need an explicit design beyond project roles.

**Acceptance example:** revoke a service identity and show subsequent triggers
fail; identify who changed a connection grant and when; let a user discover only
the published datasets they are authorized to access.

### 8. Scale from measured workloads

**Current evidence:** the [engine](../src/duckpad/engine.py) materializes outputs
between nodes; the [SQL worker](../src/duckpad/sql_worker.py) is local and configures
two DuckDB threads and a 512 MB memory limit. Other worktrees may run concurrently,
and DuckDB executes SQL internally; this is not a distributed workflow engine.

**First useful slice:** benchmark representative flows, expose safe resource
configuration and retention controls, and evaluate database pushdown or combining
compatible SQL stages. Source extensions may already push down parts of a read;
that does not provide end-to-end warehouse execution of the graph. Any optimization
must preserve observable results and state its effect on cell lineage.

**Acceptance example:** demonstrate a warehouse transformation that avoids moving
the complete source into the application, or a measured local workload improvement
under a declared resource budget. Add remote workers or Spark only if measured
requirements justify the operational complexity.

## Product decisions implied by the comparison

For **interactive analyst ETL**, prioritize Excel, preparation forms and profiles,
while preserving SQL transparency, Git and cell explanations. For **recurring
production ETL**, prioritize safe writes, automation, quality gates and retained
datasets; promote SSO and deployment controls earlier when enterprise adoption
requires them. Warehouse pushdown and distributed execution should follow evidence
about actual data volume and placement.

Do not make generic streaming, a CDC platform, a general Python runtime or a large
plugin marketplace prerequisites for improving the current batch product. Those
are separate investments. A focused first milestone is a supported source-to-sink
pipeline that an analyst can build, validate, schedule and recover without manually
editing connector SQL or risking duplicate delivery.
