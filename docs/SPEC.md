# Product specification

This document records the original MVP requirements. The code and the other guides describe the current behavior; where they differ, this specification may lag behind.

Duckpad lets technical users create reusable SQL nodes and non-technical users compose pipelines through drag and drop. The MVP is built on DuckDB, FastAPI, React Flow, and Monaco. Documentation and table-, column-, and cell-level lineage are central to the product; cell-level lineage is its differentiating feature.

Duckpad helps users generate, inspect, and execute DuckDB SQL. DuckDB and the selected extensions define statement behavior and default options. UI settings map to explicit generated SQL; unspecified SQL options retain their native defaults. Duckpad manages the graph, execution contexts, materialized results, versioning, and lineage while preserving the semantics of the SQL it executes. Any instrumentation for lineage must preserve query values, types, row multiplicities, and SQL evaluation semantics.

# Installation and access

Install with `pip install duckpad`, then launch with `duckpad start`. Required compatibility: **DuckDB >= 2.0**, with the Python dependency `duckdb>=2.0`. Git integration must fit this installation workflow. The package includes the compiled frontend; no JavaScript tooling is required for installation. The application opens in a browser and listens on localhost by default.

The single `admin` account receives a generated password on the first launch of the Duckpad instance. That password is displayed in the terminal when created and remains valid across subsequent backend restarts. Authentication state is stored at the instance level, outside project repositories and Git, using a persistent salted password hash rather than stored plaintext. Normal restarts do not generate or display a new password. Opening another project, branch, worktree, or environment does not change this instance account. Both the UI and API require authentication; there is no permissions system.

# Projects and graph

- Each project is a local Git repository with a `main` branch. It stores the DAG, graphical layout, node instances, their parameters, and references to connections and resources. Project definitions, templates, components, and documentation are saved separately from DuckDB results.

- Nodes connect directly: source nodes are square; transformations and exports are round. No intermediate square nodes are created automatically.

- Each node has 0 to N named tabular inputs and 0 to N named tabular outputs. An input receives one output; an output can feed multiple inputs across multiple nodes.

- Each output represents a distinct dataset, identified by its node and port. Renaming its label does not break its connections.

- Dependencies correspond to graph edges. Selecting a source in a form creates or updates the same edge as drag and drop. Cycles are validation errors and cannot execute; a saved cyclic definition is still versioned under the invalid-save rules.

# Connections and environments

- A **connection** is a named, reusable instance of a SQL connector definition, declared and managed at the Duckpad instance level in a catalog shared by all projects. Connections and all their environment-specific settings are not versioned. They provide access to data through native DuckDB SQL or compatible extensions. A logical connection has separate access configuration and secrets for each environment: for example, `sales` points to a test database in `dev` and the production database in `prod`, without changing the flow. Source and export nodes select a connection and a resource without requiring credentials to be entered again.

- Secrets are stored separately, outside Git; displayed SQL, errors, and logs mask them. SQL connector definitions and connection settings, including non-secret values, are instance configuration outside project repositories and Git, with no configuration-version history. Creating or editing either a connector definition or a connection does not create a Git commit. Projects version only their references to connections and environments. Connector SQL stores placeholders for secret values, never resolved credentials.

- Opening a project branch or an older project revision leaves the instance's connector definitions and connections unchanged. Each manual execution resolves the referenced connections using the current connector definitions and the current settings and secrets for the selected environment, then freezes them for that execution. Missing or invalid connector definitions, missing connections, or missing environment configurations produce explicit validation errors; Duckpad does not restore earlier catalog entries or silently substitute another connector or connection. The connector definitions and non-secret resolved settings actually used are recorded with the execution for explanation and traceability; these read-only snapshots are execution metadata, not a versioned catalog or a configuration rollback mechanism.

- Duckpad provides named **environments**, with `dev` and `prod` by default. A UI selector changes the active environment without changing the project, branch, or flow; this selection triggers neither a commit nor a computation. All branches can use all environments, including `prod`, without branch-based protection. Previews and lineage show results for the selected worktree and environment.

# SQL connectors

A **connector** is a declarative definition containing a name, description, typed connection parameters, secret-field declarations, extension requirements and compatibility information, and optional DuckDB initialization SQL. Connector definitions are managed in the instance catalog shared by all projects and are not versioned. This setup definition is distinct from source and export SQL templates, which remain project-owned and versioned. Its parameter declarations generate the connection configuration form. Technical users can create and edit connector definitions through the UI or declarative files. Adding a connector supported by DuckDB or an existing DuckDB extension must require only a connector definition and the appropriate source or export SQL templates, without changes to Duckpad's Python or frontend code.

The initialization SQL prepares a connection for use. It can load declared extensions, create temporary DuckDB secrets, and attach an external database with `ATTACH` when appropriate. `ATTACH` is optional: file readers can operate directly on a declared path, and some export extensions use a secret and `COPY` without attaching a catalog. A connector may have no initialization SQL when native DuckDB access needs no setup. Duckpad manages installation and loading of declared extensions and reports missing prerequisites or incompatible versions.

A connection supplies environment-specific values to this definition. Parameters and secrets are inserted through type-aware binding or SQL escaping appropriate to the statement; raw text concatenation is not the parameter contract. Duckpad assigns runtime aliases and secret names for each prepared connection to avoid collisions between logical connections. Preparation happens in the target worktree–environment execution context before a dependent source or export uses the connection. Reusing an already prepared connection must not fail because its aliases or secrets already exist. Active executions use the connector definition and connection configuration captured at launch.

Source and export templates contain the SQL that actually reads or writes data, such as a `SELECT` from an attached table, a file-reading function, or an export statement. They declare the connection and resources they access. Initialization is reserved for connection setup; data loading and writes remain explicit source and export operations in the flow. Transformation queries read only declared tabular inputs and outputs computed by earlier blocks of the same node execution; connection setup SQL cannot bypass that contract. A connector declares its supported read and write capabilities; the UI does not offer unsupported operations. Read and write behavior follows the generated statements and native extension options. Duckpad must not introduce hidden truncation, append, upsert, filename changes, or extra write statements; any such behavior explicitly requested through a template must be represented in its compiled SQL.

Built-in and user-created connectors use the same definition format. The required MVP presets are:

| Preset | Required scope |
| - | - |
| Server folder | Read CSV and Parquet; export CSV. |
| S3 | Read CSV and Parquet; export CSV through DuckDB-compatible S3 access. |
| PostgreSQL | Read tables and insert into existing tables through the `postgres` extension, with Additional options passed to libpq. |
| Oracle | Read Oracle resources and export tabular results to Oracle using `oraduck`. |

Other databases, such as MySQL or SQLite, use the same definition format without code changes; the connector guide publishes examples. Every supplied preset must document its tested DuckDB versions, platforms, extension dependencies, and external prerequisites. A preset is considered supported only after validation against the required DuckDB version and its advertised capabilities.

**Oracle via oraduck**: both reading and writing are required. Initialization uses a temporary `oraduck` secret with `USER`, `PASSWORD`, and `DSN`. Source nodes read through `ATTACH` and `SELECT`; the attached catalog is read-only. Export nodes use `COPY` with `FORMAT oraduck` and the same secret to load an existing Oracle table. The preset must document Oracle Instant Client prerequisites and validate its extension build against the exact DuckDB version used. See the [OraDuck documentation](https://raw.githubusercontent.com/hugues31/oraduck/main/README.md).

Before each manual execution that reads Oracle, Duckpad recreates the relevant attachments to refresh cached schema metadata. Connections can be reused within that execution. This preparation must preserve previously materialized Duckpad results. Oracle source outputs are materialized in the execution context and follow the same preview, validity, and lineage rules as other sources.

# Code and Git versioning

- The UI and code edit the same declarative project files. UI changes are written to files; file changes are reflected in the UI. The format remains readable, stable, and lossless. Validation errors and concurrent changes are reported.

- UI edits carry the revision of the project content from which they were made. Before writing, Duckpad compares that base with the current file contents, including external changes still waiting for their batch to close. If the UI proposal and an external edit give different values to the same logical field, Duckpad reports a conflict and does not silently choose the latest writer. Changes to distinct fields can be combined when both can be preserved unambiguously; identical proposed values do not conflict. If safe field-level comparison is impossible, such as with malformed content, the conflict is handled at file level.

- A conflict preserves the common base, the current file version, and the UI proposal. The current file version continues through normal automatic versioning; the unresolved UI proposal is retained as recoverable conflict state outside executable project definitions, surviving browser reloads and backend restarts. It is not executed or silently discarded. The UI lets the user choose either version or edit a combined result. Resolution rechecks the current revision before writing; further concurrent edits refresh the conflict rather than being overwritten. An accepted resolution is one UI save unit and creates an automatic commit if it changes versioned content. Choosing the already current value clears the conflict without an empty commit.

- New executions whose computation depends on an unresolved edit conflict are blocked until it is resolved. If the affected scope cannot be determined, new executions in that worktree are blocked. Conflicts limited to layout, display labels, or documentation do not invalidate results or block computation. Existing runs keep their captured configuration. Actual changes saved by either editor follow the usual validation and invalidation rules; resolving a conflict does not trigger automatic computation.

- Every save unit affecting versioned project content, from the UI or code, automatically triggers a commit with an author, date, and diff when it changes that content. Instance-level connector definitions and connection settings are outside this automatic project-commit workflow. A completed UI action is one save unit, even if it writes several files. Closely spaced external file saves are grouped into a single save unit as defined below. The final content of each save unit is versioned even when invalid: this includes SQL errors, malformed declarative files, missing references, invalid interfaces, and graph or component-reference cycles. Validation does not postpone the automatic commit until correction. There is no separate draft mechanism. The user's Git identity (name and email) is configurable independently of the `admin` access account. External commits retain their authors. History and diffs are available in the UI.

- External changes to versioned project files are grouped per worktree after 500 ms without a new relevant file change. Each file creation, edit, rename, or deletion restarts that delay. The batch captures the latest complete state of its affected files and creates one automatic commit; batches never mix different worktrees or projects. A batch with no net change creates no empty commit. File events caused by an already committed UI action do not create a second commit. Graph validation, UI synchronization, and result invalidation use the captured batch state rather than incomplete intermediate file writes. A final invalid batch is committed and diagnosed normally; an invalid intermediate state corrected before the batch closes does not require a separate commit.

- Before a manual execution captures its launch configuration, any pending external batch in that worktree must be finalized and committed from a stable file state. Validation then determines which execution scopes can start. The execution's recorded commit must correspond to the files and local definitions actually captured; it must never point to an earlier commit while executing uncommitted changes. Changes arriving after capture belong to a later save unit and follow the normal concurrent-edit rules.

- Invalid saved project content remains the editable, versioned source of truth. Duckpad preserves it without silently reverting it, dropping invalid entries, or rewriting it from a previously valid graph. Diagnostics identify the affected files and locations, and nodes or definitions when they can be resolved. The UI must clearly expose the invalid state; any retained prior graph rendering is marked as out of date and cannot be used to overwrite the saved files or as an execution fallback.

- Validation blocks new execution of the affected nodes, usages of invalid definitions, and their descendants. Their retained results become stale under the normal computation-change rules. Independent execution scopes may still run when their validity and lack of dependency on the invalid content can be established. If malformed content prevents reconstruction of the graph or reliable determination of its impact, the whole worktree is treated as affected across its environments and new executions there are blocked. Other worktrees remain independent. Already running executions retain their launch configuration and follow the concurrent-edit invalidation rules. A correction saved after the invalid state was committed creates another automatic commit when its save unit completes and clears resolved validation errors; stale results still require manual recomputation. Versioning an invalid state does not waive the existing validation requirements for merges.

- Users can create and open a branch in a separate [Git worktree](https://git-scm.com/docs/git-worktree) to work in isolation. The UI indicates the active project and branch; each worktree has its own execution contexts and results, separated by environment.

- Merging into `main` is explicit, after comparing changes, resolving conflicts in the UI by choosing or editing versions, and validating the DAG and interfaces. The merge preserves author history and marks affected results as stale; recomputation remains manual.

- Git versions project definitions, SQL, parameters, layout, local template and component definitions, instance references to their stable local identifiers, references to connections and environments, and documentation. A project's Git revision determines the definitions used by all its instances; templates and components have no separate version or branch lifecycle. Source data, exports, and computed results are managed separately. Instance connector definitions and connection configurations, including non-secret settings and secrets, are excluded from Git; project references to connections and environments remain versioned.

# User interface

A palette exposes available templates. Each instance provides a form generated from its typed parameters; Monaco allows editing the template SQL. Clicking an operation opens two panels. The inspector on the right describes the node: its parameters, its compiled SQL in read-only mode with bound parameter values and secrets masked, and its documentation. An **Info** tab shows who created the node and who changed it last, from Git history, with its identifiers, and opens its element history. A one-line result summary under the node kind gives the result status, the number of outputs, warning badges for messages and failing tests, and the run time, each opening the matching tab of the results panel. The results panel below the canvas shows what the node produced in the selected environment, in four tabs: **Data**, **Columns**, **Tests** and **Log**. A single output is displayed directly; multiple outputs and the node's inputs, for comparison, are offered by a selector. The displayed rows follow a sample chosen by the user: all, first or seeded random rows, a validated SQL filter on the dataset's columns, a multi-column sort and a search across columns, remembered per user in the browser or shared with the project as views in `views.json`. A sample never changes what runs compute. Selecting a cell in a valid result gives access to its lineage; a missing or stale result requires manual recomputation. The **Columns** tab lists names, types and documentation at once and computes column statistics of the whole result only on request; the **Tests** tab recomputes a test's failing rows on demand without storing them; the **Log** tab shows the run behind the result, its messages and the SQL actually executed to produce it. Compilation does not trigger flow execution.

After a failed recomputation, the results panel keeps the node's last successful result available as a read-only preview, explicitly marked as stale, alongside the latest execution error. The executed SQL shown for that preview belongs to the retained successful result. Cell-level lineage is disabled for that result until a successful recomputation produces a valid replacement. If the node has never produced a successful result, the results panel shows the error and no result.

- **Internationalization**: the UI is available in English, French and Portuguese, with an EN/FR/PT selector. Application text and labels for built-in nodes are translated through dedicated localization resource files. French and Portuguese localized UI values are an explicit exception to the repository's English writing rule; translation keys, file names, source code, comments, and repository documentation remain in English. User-authored names, SQL, and documentation are preserved as entered.

- **Theme**: a light/dark toggle applies throughout the UI, including the graph, Monaco, and previews. Language and theme preferences are stored locally, independently of the project.

# Built-in nodes

| Node | Main configuration | Inputs → outputs |
| - | - | - |
| Load CSV | Connection, file, delimiter, header, detected or overridden types | 0 → 1 |
| Load Parquet | Connection, file | 0 → 1 |
| Load table | Database connection, schema, table | 0 → 1 |
| Join | Two sources, keys, join type, selected columns | 2 → 1 |
| Filter | Column, operator, value; SQL expression in advanced mode | 1 → 1 |
| Aggregate | Grouping columns, functions, columns, and aliases | 1 → 1 |
| Export CSV | Connection, destination, delimiter, header | 1 → 0 |
| Export table | Database connection, schema, existing table; columns matched by name | 1 → 0 |
| Export Oracle | Oracle connection, existing destination table, column mapping | 1 → 0 |
| SQL transform | Independent SQL with named ports and typed parameters; optionally linked to a project template | 1 → 1 |

Reads and writes use native DuckDB features or extensions through the selected SQL connector. The CSV and Parquet nodes work with local-file and S3 connections. The Oracle source and export nodes are supplied SQL templates using the `oraduck` connector through the same generic node and connector contracts.

For a single CSV output, `COPY tbl TO 'output.csv' (HEADER, DELIMITER ',');` overwrites an existing destination according to DuckDB's native behavior. Duckpad adds no existence-based rejection, overwrite confirmation, or automatically renamed output. Other export modes follow the semantics of their generated SQL and selected extension; the single-file behavior is not generalized into a separate Duckpad overwrite policy. See the [DuckDB COPY reference](https://duckdb.org/docs/2.0/sql/statements/copy).

# SQL templates

A normal node owns its SQL. Adding a built-in node or a project template from the palette, creating a connected node, or duplicating a SQL node copies the current code into an independent node by default. Its parameters, connections, label and form belong to that node. **New SQL node** creates a minimal input/output transform without asking for a template name. **New SQL template** remains available for reusable definitions.

A linked node explicitly references a project template. **Add linked** in the palette creates one. Its parameters and connections remain independent, while editing the template updates all linked usages in the branch. Existing projects keep their linked nodes. The canvas and inspector show a link badge and the template name. The node offers read-only code, **Edit template (N nodes)** and **Detach from template**.

Detaching copies the current code and keeps the origin as information. **Convert to template** asks for a name, creates a project template and links that node to it. **Link to original template** is available while the origin exists and requires confirmation before discarding local code. Parameters and connections survive conversions. Detaching and converting preserve execution fingerprints; relinking invalidates results only when executable code changes. Incompatible parameters or interfaces follow normal validation and block affected executions until corrected.

Normal code lives in `nodes/<node-id>.sql`, or `components/<component-id>/<node-id>.sql` inside a component. A normal node in `flow.json` has no `template`; an optional `origin` is informational. These SQL files use the same editor, Git, comparison, conflict, archive, validation and execution contracts as templates. Deleting a node removes its code file. Grouping moves its code into the component; importing a component copies it with the other definitions.

Templates describe their label, description, inputs, parameters, outputs and SQL. They follow the same project-local ownership, branching and independent-copy import rules as components. Importing a template from another project creates an autonomous local definition. There are no partial code overrides on a linked node.

Ports are declared with `-- @input name` and `-- @output name`; their table type is implicit. Parameters use `-- @param name: type = default_value`. Types include text, number, boolean, date, choice, file, connection reference, input column, SQL expression, and typed lists. Suggested columns depend on input schemas. All references use `{{ name }}` directly, without a prefix. Inputs, outputs, and parameters share a single namespace within the node; duplicates and undeclared references are rejected.

```sql
-- @label Validated entries
-- @description Keep validated entries with a positive amount.
-- @input source
-- @param filter: expression(source) = "amount > 0 AND status = 'VALIDATED'"

-- @output result
SELECT *
FROM {{ source }}
WHERE {{ filter }};

-- @output summary
SELECT COUNT(*) AS entry_count, SUM(amount) AS total_amount
FROM {{ result }};
```

Each `@output name` associates the next tabular query, terminated by `;`, with an output. Multiple outputs use multiple `@output` + query blocks executed in their declaration order. A block can read the node's declared inputs and any output declared and computed by an earlier block, using the same `{{ name }}` syntax. A reference to the block's own output or to a later output is a validation error. In the example above, `summary` reads the newly computed `result` from the same node execution. These are dependencies between output blocks within one node, not self-edges in the project DAG.

The compiled SQL lists each block's query in execution order. Duckpad assigns physical names and generates the `CREATE TABLE … AS` statements that materialize them in memory only during manual execution; the executed SQL of a result shows those statements. Input references resolve to connected tables, and earlier-output references resolve to the tables newly computed during the current node execution, never to a previous successful output. Parameters resolve according to their types. Identifiers are escaped, scalar values are bound to DuckDB, and SQL expressions are parsed and validated in context. Scalar values are used without quotes around `{{ name }}`. An export uses `COPY` without a tabular output.

Newly computed outputs are available to later blocks inside the same node execution but are published to previews and downstream nodes only after all output blocks succeed. If any block fails, none of the new outputs is published and the node's previous successful output set is retained as stale. Lineage records and traverses dependencies between these output datasets within the same execution.

A transformation reads only its declared inputs and its earlier outputs from the same execution, and produces only its declared outputs. Local CTEs and subqueries remain allowed; access to data outside this contract and undeclared side effects are rejected before execution. External reads and writes go through source or export nodes with declared connections and resources. Duckpad prepares those connections using their SQL connector definitions and manages the required extension installation and loading.

## Execution messages

Normal node code and shared templates support unnamed `-- @message` blocks.
Each contains one read-only query with unique `level` and `message` columns.
Every returned row produces a structured result; zero rows produce none.
`level` is exactly `info`, `warning` or `error`, and `message` is non-null text.
Missing columns or invalid values fail the node explicitly.

Messages run in declaration order after all output blocks and before atomic
publication. They can read declared inputs, parameters and newly computed
outputs, using the same `{{ name }}` references. They follow the node's access
contract without side effects. Export messages read inputs and run before any
external write. An `error` prevents output publication or export, retains prior
outputs as stale, and blocks descendants. Warnings alone preserve `success` and
increment a warning counter. Editing messages invalidates results.

Node execution records hold a shared `results` list. Each result has `level`,
`message`, `origin` (kind and block, or a test name), `output`
when a single output is known, and an optional `observed` value. No separate
message or test storage is required. The list retains 100 message results per node and
run, followed by a structured omission summary with counts by level. Every row
is still checked, so truncation never hides an execution failure. Badge and
warning totals derive from this list, including the summary counts.

The results panel and canvas use the messages of the displayed result generation;
nodes outside a later launch's scope retain their original messages. The latest
failure remains visible beside a stale preview. Run history shows each node's
results and the run warning count, including failed runs, and survives restart.
The server emits one JSON log line per actual message with run, project, branch,
environment, node, level, message and origin. Secrets use the same redaction as
execution errors. UI labels are localized into English, French and Portuguese.
There is no dedicated Message node or separate inspector input. Scheduled runs,
headless execution and journal export are outside this contract.

## Data tests

Normal node code and shared templates support `-- @test <name>: <severity>`.
Names follow port identifier syntax and are unique among the node's tests.
Severity is `warning` or `error`, with `error` as the default when omitted.
An empty block, duplicate name or unknown severity is invalid. Each block holds
one read-only query returning failing rows. Zero rows passes; otherwise the test
fails with its declared severity. No specific columns are required.

```sql
-- @input source
-- @output orders
SELECT * FROM {{ source }};
-- @test amount_present
SELECT * FROM {{ orders }} WHERE amount IS NULL;
-- @test customer_known: warning
SELECT * FROM {{ orders }} WHERE customer_id IS NULL;
```

Tests and messages execute together in declaration order, after all outputs and
before their atomic publication or any export write, under the same access
contract. An error test failure fails the node, publishes no new outputs and
blocks descendants. A warning failure adds one to the warning count and preserves
run success. All checks run even after an earlier test reports failure. Test
edits invalidate results for normal nodes and all nodes linked to a template.

Every executed test appends to the shared node `results` list: `origin.kind` is
`test`, `origin.name` identifies the test, `output` is the single referenced output
or null, and `observed` counts failing rows. `status` is `ok`, `warning` or `error`;
`level` is `info` for passing tests and otherwise matches the severity. Unlike a
message query, a passing test still records a result. Every named test is retained
even beyond the message display limit. No failing row samples are fetched or
stored. Logs emit one structured result per failed test, using message context
and redaction. Results persist with runs and survive a restart.

For a node whose code declares tests, the results panel shows the latest test attempt
and the previous nine test executions for the selected environment, including
failures alongside a stale preview. Runs that do not execute that node's tests do not replace its history.
Run details include passing and failing tests and their observed counts. Canvas
warning badges include tests; error tests appear as node failures. Labels are
localized into English, French and Portuguese. Predefined tests and a project
quality overview are outside this contract.

# Reusable components

- A **component** is a reusable visual function owned by one project. It encapsulates multiple nodes in a sub-DAG, represented by a single node, and is created from a selection of nodes. Its definition is stored in the same Git repository as the project's flows.

- It exposes named inputs and outputs connected to internal ports, and typed parameters connected to internal settings. Grouping preserves external connections.

- Within a project branch, multiple instances reference the same local definition through its stable identifier. Editing that definition updates all its direct and nested usages in that branch. Connections, exposed parameter values, and results remain instance-specific. Editing an instance's parameter values does not change the definition or other instances.

- Components use the project's ordinary Git workflow. A definition change on a working branch remains isolated until merged into another branch of that same project. Merging into `main` updates usages in that project's `main` only. Editing a component never requires selecting a branch or worktree in another project.

- The active project's palette exposes its local component definitions for drag and drop. A catalog shared by the Duckpad instance exposes components from projects' `main` branches for explicit import into another project. Importing copies the selected definition into the destination project's active branch, together with node-owned SQL files and all nested component and SQL template definitions it needs. Imported definitions receive distinct local identities, and their internal references are remapped consistently so that the imported component has no executable definition dependency on its source project.

- Each import creates an independent local copy and does not overwrite existing definitions. Subsequent changes in the source or destination project affect only that project's instances and do not update or invalidate copies in other projects. The source project and commit may be retained as informational origin metadata, with no role in resolving executable definitions. Adopting later improvements requires explicit changes in the destination project, such as importing a new copy; the MVP has no automatic cross-project update or coordinated publication mechanism. Imports copy definitions and documentation, not results, external source data, or secrets; declared connection and resource references retain their normal meaning.

- Double-clicking opens the sub-flow; a breadcrumb allows returning to the parent level. Previews correspond to the instance being inspected. The editor indicates the active project and branch and makes clear that definition edits affect all instances of that definition in the current project branch.

- Components can contain other local components. Direct or indirect recursive references and DAG cycles are validation errors that block affected executions; saved invalid definitions remain versioned.

- Ports and parameters retain stable identifiers. An incompatible definition change flags the affected local instances requiring correction and blocks their execution until corrected.

# Project variables

- A project variable is a named, typed and documented value declared in the versioned `variables.json`, with a default and optional values per environment. A root flow parameter, including an exposed parameter of a component instance, can be bound to it with `{"$var": "name"}`, and a root flow `expression` or `expressions` parameter can reference text, number, boolean, date and choice variables as `{{ var.name }}`. The compiler turns each reference into a named DuckDB parameter bound with its type, never into SQL text. Templates and component definitions cannot reference variables.

- A launch resolves each variable used by its scope from the captured commit and the selected environment, binds the value like any parameter, and records its type, value and source in the run. Computation fingerprints include the resolved values, so changing a value invalidates only the results that use it in that environment. Lineage explanations label each bound value with its variable. See [Project variables](VARIABLES.md) and the [design proposal](design/PROJECT_VARIABLES.md).

# Documentation and data lineage

Documentation and traceability are core MVP requirements. Projects, components, nodes, datasets, and columns can be documented with business meaning, sources, transformation rules, and assumptions. This information is accessible from the graph and previews.

Column documentation follows the column's lifecycle: deleting a column deletes its documentation from the current project state. Renaming a column removes the old column's documentation; the renamed column starts without documentation. There is no detached-documentation store or reassociation workflow, and lineage does not automatically transfer documentation. These deletions follow normal project versioning; earlier Git revisions retain their original documentation. Cleanup requires a confirmed column removal or rename from a successfully resolved schema or an explicit deletion of its owning object. Invalid SQL, unavailable schemas, failed computation, and loss of in-memory results alone do not imply column deletion.

- **Table**: sources and transformations traversed.

- **Column**: source columns, expressions, and calculation rules.

- **Cell**: contributing source rows and cells, with the steps explaining the value. Joins and aggregations identify all relevant contributions; large sets are presented as explorable summaries. Selection conditions are distinguished from calculations. For `MAX`, first display the cells containing the maximum value, including ties, with access to the full group examined. For example, for `10, 20, 20`, both `20` cells appear first; the full three-row group remains accessible. The display rule of five contributions per group applies.

**`COUNT(DISTINCT ...)` presentation**: first show one group for each distinct value counted by the executed aggregate, with the number of contributing input rows in that group. For input values `A, A, B`, the result is `2`; the explanation shows `A` linked to its two input rows and `B` linked to its one input row. Expanding a group exposes every corresponding source cell with its dataset, row, and column identity, including separate cells with identical values. Clicking a source cell continues its lineage normally. Grouping is a presentation rule and does not change DuckDB's distinctness or counting semantics. Inputs excluded by the executed aggregate remain distinguishable as evaluation context and are not presented as counted value groups.

Cell-level lineage is Duckpad's differentiating feature. The engine parses the DuckDB SQL actually executed, after template compilation, with bound parameters and resolved schemas. From a cell selected in the preview, the **Explain this value** action dynamically constructs and executes targeted queries to trace back to source data. The path and transformations can be inspected. Preview limits and filters do not limit the provenance search. Lineage traverses nested components, identifying each instance.

Provenance is attached to the current execution, dataset, column, and a stable row identity, independently of its position in the preview. The executed SQL, non-secret parameter values, project commit, local template and component definitions used from that commit, environment, resolved SQL connector definitions, connection references, and non-secret connection settings actually used are associated with that execution. Connector definitions and connection settings are recorded as execution metadata rather than references to nonexistent historical catalog versions. Secrets are not included in this metadata. Lineage is available only for valid results with consistent computation dependencies.

Lineage explains the data materialized for the displayed result's execution. Its queries use the associated source and intermediate datasets retained in the execution context, without rereading current external resources. Changes to external data after execution do not change that result's values or lineage. Opening a preview or exploring lineage does not refresh sources. If required computation dependencies are no longer consistent, the result is stale and lineage is unavailable under the normal invalidation rules.

**Recalculation takes priority over lineage.** When a manual run is accepted, Duckpad cancels pending or running lineage queries whose target results or computation dependencies will be invalidated or replaced by that run, including affected descendants outside the requested run scope. New lineage requests against those old result generations are rejected. Cancellation must stop access to the affected datasets before they are replaced; the run does not wait for a successful lineage explanation. Unrelated queries and other execution contexts are not canceled solely because of this run.

Each lineage request and response is tied to the identities of its execution, result generation, dataset, row, and column. Results from a canceled request or an invalidated generation are discarded, including late responses, so the UI cannot mix contributions from different computations. The UI reports that the exploration was interrupted by recalculation and disables navigation into the affected old results. The user can explicitly explore a cell in a newly published valid result; Duckpad does not automatically replay the request against an old row identity. If recalculation fails, retained stale results remain available as previews without lineage.

**Required MVP SQL coverage: extended baseline.** The following cell-level lineage coverage is a mandatory MVP acceptance criterion, rather than a future target:

| SQL operation | Required coverage |
| - | - |
| Projections | Trace selected and computed output values to their contributing inputs. |
| Filters | Trace retained values and distinguish selection conditions from value calculations. |
| Joins | Trace contributions from the joined inputs. |
| Aggregations | Cover grouping and `SUM`, `AVG`, `MIN`, `MAX`, and `COUNT`, including `COUNT(DISTINCT ...)`. |
| `DISTINCT` | Trace provenance through duplicate elimination. |
| Set operations | Cover `UNION`, `INTERSECT`, and `EXCEPT`. |
| Window functions | Trace values produced by window functions. |

All built-in nodes and compositions of these operations must be covered from the MVP. SQL coverage should continue expanding toward **100% as a progression target**. An explicit coverage matrix must document supported, partially supported, and unsupported SQL constructs; the required extended baseline cannot be deferred by marking it unsupported. SQL outside lineage coverage remains executable if it satisfies the node contract. When a user explores an affected value or cell, a warning identifies the limitations and unsupported steps; partial provenance is never presented as complete.

**Numerous contributions**: display the first 5 values by default, in an order stable for the execution, with the total count and access to subsequent values. Each value remains linked to its dataset, row, and column; identical values from different rows remain distinct. Clicking a contribution starts cell-level lineage again from that cell. The limit applies to display, not to the complete set of contributions searched. For `COUNT(DISTINCT ...)`, the top level displays the first 5 distinct-value groups, their input-row counts, and the total number of counted distinct groups. Expanding a group displays its source contributions in pages of 5, with that group's total input-row count. The UI distinguishes the number of distinct groups from the number of underlying row contributions. Both levels use an order stable for the execution and remain fully navigable.

**Returning to an earlier version**: open the desired Git revision of the project, including its local template and component definitions and instance references, manually rerun computation, then explore lineage for the new results. No other project's revision is needed to restore imported definitions. Git restores the project's code, parameters, definitions, and connection references; it does not restore instance-level connector definitions or connections. Execution uses the current connector definitions and the current connection settings and secrets of the selected environment, without changing the shared catalog. Source data, connector definitions, and connection settings can differ from those used previously, so this operation does not guarantee recovering earlier values.

# Execution and storage

- Manually run the project or a node with all its ancestors, in topological order, in the active branch and environment. Every launch recomputes the entire requested scope, even when existing results are valid: all nodes for a project run, or the selected node and all its ancestors for a node run. Source nodes in that scope reread their declared external resources. Results from previous launches are not reused to skip computation. Within a single launch, each node executes once, and shared ancestors supply the same newly computed outputs to all their dependents. Only one execution can run at a time per worktree.

- A new execution request for an occupied worktree is explicitly rejected, never queued or used to replace the active execution. This applies to both project and node runs, including requests for another environment in the same worktree. Admission is atomic: once a request is accepted, the worktree remains occupied during preparation, execution, cancellation, and cleanup until that run has finished. The UI disables execution actions with an explanation and access to the active run; the API independently enforces the same rule, including simultaneous requests. A rejected request does not invalidate results or cancel lineage queries. It never starts later automatically: the user must wait or stop the current run, then explicitly request a new execution. Other worktrees are admitted independently.

- Each execution uses an immutable configuration captured at launch: the project commit, DAG, node instances, SQL, parameter values, local template and component definitions from that commit, environment, and resolved SQL connector definitions and connection configurations. All nodes in the execution use that same configuration. Changing the environment selector or saving later changes does not alter the active execution.

- Editing through the UI or project files remains available during execution, with the usual automatic versioning. The active execution continues with its launch configuration. Changes invalidate affected results according to the normal dependency rules, including results that the active execution has not yet published. Publishing an affected result must preserve its stale status; successful computation must not make it appear valid for the edited flow. Unaffected results can remain valid. Dependencies needed by the active execution remain available until it finishes. The results panel associates produced results with the SQL and revisions actually used, independently of the current configuration. Stale results do not provide lineage, and no new execution starts automatically.

- The MVP uses an **in-memory** DuckDB database for each project worktree–environment pair, with a connection maintained between queries for the lifetime of the backend. Each node retains only its most recently published successful output set as its current stored result, without a history of earlier versions. A new successful publication replaces that set; a failed recomputation does not erase it. The retained set remains available until successful replacement, deletion of its node or execution context, or backend shutdown. After a restart, manual recomputation is required for previews and cell-level lineage. File-backed DuckDB storage will be evaluated in V2.

- Execution history is persistent instance metadata stored outside project Git repositories. Each accepted run has a stable identifier and records its project, worktree, branch and commit, environment, requested scope, run and node statuses, timestamps, durations when known, errors, and SQL actually executed. It includes the non-secret parameter values, resolved connector definitions, connection references, and non-secret connection settings used by that run. SQL and diagnostics are sanitized before persistence; secret values are never stored in execution history. Run and node state changes are recorded durably as execution proceeds, rather than only on successful completion. History remains available through the UI and API after backend restarts and subsequent executions; it is distinct from Git history and from the job system's transient task results.

- Historical execution records are read-only metadata. They do not persist source datasets, intermediate or output tables, preview rows, or cell-lineage contributions. Inspecting a historical run neither restores its datasets nor changes current project definitions, connector definitions, or connection settings. Preview and lineage remain subject to the availability and validity of the current in-memory results; retaining a successful history record does not make an old result available. A manual rerun creates a new execution record under the normal launch rules and does not overwrite the previous record.

- After a backend restart, unfinished runs from the previous backend lifetime are recorded as interrupted, retaining their last known node outcomes and diagnostics. Duckpad does not invent a successful completion, an exact completion time that was not observed, or an external rollback. An external write whose final outcome was not recorded remains explicitly unknown. Interrupted runs are not resumed or retried automatically, including by a persistent job queue; recomputation requires a new manual launch. Previously completed execution records remain unchanged.

- A node's tabular outputs are published together after success. Its last successful output set is retained throughout recomputation, including while its ancestors are being recomputed. An error publishes no partial outputs, preserves the entire last successful output set as stale, and blocks descendants. The retained outputs are available for read-only previews, with the failure displayed separately; they provide no lineage and must not be used as fallback inputs to continue the failed execution. If no successful output set exists, the result remains absent. A subsequent successful recomputation replaces the retained set atomically, subject to the normal validity rules.

- In the absence of manual cancellation, a node-level failure does not stop independent branches in the requested execution scope. Nodes whose dependencies have succeeded in the same execution continue, including computations and exports that have not yet started. All descendants of a failed node are blocked for that execution, including nodes that also depend on a successful branch. Successfully published outputs and completed exports are not rolled back because another branch fails. The execution waits for all remaining runnable nodes to finish and reports partial failure when successful nodes coexist with failed or blocked nodes; it reports failure if no node succeeds. The UI distinguishes failed nodes from descendants blocked by an upstream error and identifies the blocking cause. An execution with any failed or blocked nodes must not be reported as successful.

- The UI provides a Stop action, also available through the API, for an active execution. Once accepted, cancellation prevents any further node from starting in that execution, including independent branches, and requests interruption of its active SQL through the owning DuckDB connections. The UI shows cancellation in progress until active operations have actually ended and cleanup is complete; the worktree remains occupied until then. If an extension takes time to respond to interruption, Duckpad keeps this pending status instead of claiming the operation has stopped. Repeated stop requests are harmless, and stopping an already finished execution does not change its recorded outcome. Other worktrees and unrelated queries are unaffected.

- A manually canceled execution ends with a canceled status and is not retried automatically. Nodes not started are marked as canceled without execution; earlier failures and completed nodes retain their actual outcomes. An unfinished node publishes no replacement outputs after cancellation is accepted: staged outputs are discarded and its last successful output set, if any, remains available as a stale preview without lineage. Previously published outputs retain their normal validity status. Cancellation does not undo completed exports or promise rollback of an in-progress external write; DuckDB and the extension determine the actual effects. The UI reports the export's observed outcome, including partial or unknown effects when applicable, even if the statement finishes after cancellation was requested.

- Only changes that can affect computation invalidate the affected node's results and its descendants in the branch's environments. These include executable SQL, parameter values, graph connections, source or export resources, schemas, and execution-relevant template or component definitions. Changes to a shared local definition invalidate its direct or nested usages in the same project branch. Merging such changes into another branch of the same project invalidates affected usages there; other branches and independent copies in other projects remain unchanged. Editing the execution-relevant configuration of a shared connection in an environment invalidates dependent results across all projects and worktrees for that environment. Editing a SQL connector definition's execution-relevant setup or parameter contract invalidates results that depend on connections using that definition, across all dependent projects and worktrees in the affected environments, without creating Git commits; active executions keep their captured definition. No automatic recomputation occurs. Invalidation marks the retained result as stale without deleting the node's last successful output set; stale results provide no lineage. Recomputing a node also invalidates descendant results that depend on its previous state, in the same environment.

- Changes limited to graphical layout, display labels, descriptions, or documentation are saved and versioned without invalidating results or disabling lineage. This applies to projects, node instances, local templates, and components, including changes merged into another branch of the same project and edits made during an active execution. A new Git commit containing only these changes does not by itself invalidate a result. Execution provenance retains the commit and local definitions actually used. Display labels are distinct from identifiers or schema changes that affect SQL or data interfaces.

- The MVP does not monitor external source data changes or automatically invalidate results because of them. A valid result represents the data read during its recorded execution and remains valid when those external resources change, provided its computation configuration and retained dependencies remain consistent. Validity does not guarantee that a result reflects the latest external data; the UI makes this distinction clear and displays the result's execution time. Refreshing data requires a manual run, which rereads all sources in its requested scope. Changes to connection configurations or declared source settings still follow the normal invalidation rules.

- The UI displays statuses, SQL errors, and execution duration. An export is reported as successful only after its DuckDB statement completes successfully. File visibility, replacement, temporary-file handling, and failure cleanup follow DuckDB or the selected extension and its explicit SQL options. Duckpad does not add a separate file publication protocol or stronger atomicity guarantee. Export side effects are separate from the transaction used to publish a node's tabular outputs. Default export paths are resolved within the worktree–environment directory and shown in compiled SQL. An explicitly configured destination remains unchanged on repeated runs. External database exports retain their connector's transaction guarantees; a reported partial external write is an export failure with that outcome visible.

FastAPI exposes management of projects, templates, components, SQL connector definitions, connections, environments, branches and worktrees, Git history and merges, documentation, validation, file access, previews, on-demand lineage queries, persistent execution history, and execution launch, tracking, and cancellation.

**Job management.** The MVP uses the embedded execution service. The completed scheduler comparison and the future integration boundary are recorded in the [architecture guide](ARCHITECTURE.md#scheduling-decision). Scheduling libraries must not replace worktree admission, cancellation, live result contexts or execution history; no distributed workers or custom calendar scheduler are required.

# Future automation (post-MVP)

A future version must support recurring execution schedules, such as running a flow every day at a configured time or at a regular interval, and execution triggered by an authenticated HTTP webhook. These are future capabilities, not additional MVP delivery requirements. Scheduling configuration must survive instance restarts independently of the in-memory datasets.

The MVP must expose a common application execution service used by both UI and API launch requests. It accepts an explicit project/worktree, environment, and project-or-node execution scope; it owns validation, atomic admission, launch-time configuration capture, run identity, status tracking, and cancellation. Future schedule and webhook handlers submit requests through this same service rather than implementing another DAG runner. Admission is shared across entry points: a manual run, two schedules, and a webhook targeting the same worktree cannot bypass the single-execution rule by being different triggers. A scheduler's per-job concurrency setting alone is not sufficient to enforce this worktree-wide rule.

Execution metadata must distinguish the origin of a request. The MVP records a manual origin and the UI or API entry point; future automation adds the schedule or webhook trigger identity and its occurrence or delivery identifier. Trigger payloads identify the requested execution and use the normal validation rules; they do not serialize live DuckDB connections or bypass connection-secret handling. Duckpad remains responsible for the durable execution history regardless of the scheduling library.

Before delivering automation, its specification must define time zones and daylight-saving behavior, handling of missed schedule occurrences while the instance is stopped, duplicate webhook deliveries, and the recorded outcome of triggers rejected because a worktree is occupied. These future policies must be explicit and must not silently introduce queued runs, automatic retries, or replay of exports into the MVP behavior. Executions interrupted by a restart and future scheduled occurrences are distinct events.

# Performance reference

The MVP performance reference is an input dataset containing **1,000,000 rows and 50 columns**. This is the scale used for representative performance validation, not an application-enforced size limit. Larger datasets remain subject to DuckDB's native behavior, the selected extensions, and available resources.

Performance is a continuous optimization objective: reduce computation and response times as much as practical while preserving SQL semantics and complete, accurate lineage. There is no fixed response-time threshold or latency-based pass/fail gate for the MVP. The reference workload must run correctly, and its measured timings and resource use must be reported. Performance goals do not introduce an implicit query timeout or override explicitly configured DuckDB or extension behavior.

Reference benchmarks must specify the dataset's column types, value widths, key cardinalities and duplicate distribution, the flow being executed, the hardware, and the DuckDB and extension versions. Measure full pipeline execution, result previews, and on-demand cell lineage separately. Pipeline measurements include source reads; lineage measurements use the already materialized execution datasets. Record the time to display the first page of 5 contributions and its total contribution count, as well as peak memory use. Reference flows must include joins and aggregations, with at least one case requiring contribution pagination.

Long-running computation and lineage requests must leave the UI responsive and show their pending state. Improving perceived speed must not silently omit contributions, present an incomplete count as exact, or label partial provenance as complete. Recalculation retains priority over conflicting lineage requests under the existing cancellation rules.

# MVP acceptance

A user must be able to load data, join, filter, and aggregate it, then export it as CSV; reuse an output across multiple graph branches; create a template with multiple distinct outputs; reopen a project after a restart, then recompute results and their cell-level lineage. They must also be able to document objects and explain a cell resulting from a join or aggregation back to its sources, independently of the displayed sample. They must be able to group nodes into a component, expose its parameters, nest it, instantiate it several times in one project, and import an independent copy into another project. A computation-affecting definition change updates its instances in the current project branch and marks affected results as stale without automatic recomputation; other branches and copies in other projects remain unchanged until explicitly edited or merged within their own project. The same change must be visible in the UI and code, automatically versioned and attributed to its author, testable in an isolated worktree, and then mergeable into `main`, with conflict resolution in the UI. Lineage is constructed automatically from executed SQL; numerous contributions can be explored in groups of 5 values with cell-by-cell navigation. Returning to a Git revision and recomputing allows exploration of that pipeline version against available sources, without retaining old data. A SQL template follows the same local sharing and independent-copy import rules as components. Undeclared access is rejected; a lineage coverage limitation allows computation and is reported when exploring the cell. A configured connection can be reused across all projects without re-entering secrets; the `dev`/`prod` selector resolves its configuration and displays the corresponding results and lineage, without changing the project or flow. All branches can execute the flow in every environment.

Cell-level lineage acceptance must additionally verify the entire required extended baseline: projections, filters, joins, grouping with `SUM`, `AVG`, `MIN`, `MAX`, and `COUNT`, `DISTINCT`, `UNION`, `INTERSECT`, `EXCEPT`, and window functions, including compositions of these operations. Coverage of this baseline is required for the MVP; the broader goal of 100% SQL coverage remains incremental.

Execution acceptance must verify that running a node twice recomputes that node and all its ancestors both times, even without a flow change and with valid existing results. If a source resource changes between launches, the second launch must reload it and compute from the newly read data. A shared ancestor must execute only once within a launch, even when multiple paths depend on it.

Concurrent editing acceptance must verify that changing a filter while a run is in progress saves and versions the edit without changing the active run's SQL or parameters. That run continues using the original filter; its affected results, including descendants computed after the edit, are stale when published and offer no lineage. A subsequent manual run uses the new filter. Switching the environment selector during a run must not change that run's environment or resolved connection configurations.

Failure retention acceptance must verify that a node with successful outputs keeps that entire output set if a subsequent recomputation fails, including when one of several new outputs was computed before another failed. No partial replacement is published. The previous outputs remain inspectable as stale, the new error is displayed, and cell-level lineage is unavailable. Descendants cannot continue using those stale outputs. A first execution that fails leaves no result; a later successful recomputation replaces the retained set without keeping an older version history.

Independent branch acceptance must verify a run in which a successful source feeds two branches and one branch fails. The other branch must continue through its calculations and export, even if they had not started when the failure occurred. Descendants of the failed node, including a node that joins the two branches, must remain blocked. Successful outputs and exports remain published, and the execution reports partial failure with separate failed and blocked node statuses.

Invalidation acceptance must verify that moving a node, changing a display label, or editing documentation creates the usual versioned change while preserving valid results and their lineage. This must also hold when a documentation-only template or component change is merged into another branch of the project or made during an active execution. Changing executable SQL, a calculation parameter, or an input connection must invalidate affected results and descendants without starting a new computation.

Source freshness acceptance must verify that modifying an external source after a successful run leaves existing result values, validity, and lineage unchanged while their computation dependencies remain consistent. Preview and lineage requests must explain the materialized data from that execution without rereading the modified source. A subsequent manual run must reload the source and compute new results, applying the usual invalidation and replacement rules.

Component ownership acceptance must verify that two instances in project A share one local definition while keeping separate parameters and results. Importing that component into project B must copy all required nested components and SQL templates, with their internal references pointing to definitions owned by B. Editing the copy in B updates its local instances without changing A; editing or merging changes in A does not change B, create commits there, or invalidate B's results. B must remain able to edit and execute the imported component when A is unavailable, provided its declared external resources and connections are available. Restoring a Git revision of B restores its local definitions without resolving code from A. The same rules must be verified for imported SQL templates.

Connector extensibility acceptance must verify that a technical user can add a SQL connector definition, declare its typed parameters and secret fields, configure a named connection in `dev` and `prod`, and use it from a source or export template without changing Duckpad application code. Initialization must support both attached-database and attachment-free access. Reusing the connection must not create alias collisions, and secrets must remain absent from Git and masked in displayed SQL, errors, and logs. The shipped local-file and S3 presets must support CSV/Parquet reads and CSV exports; Oracle acceptance must verify both source reads and exports through `oraduck`, with the extension validated against the exact DuckDB version used. An Oracle source must feed a transformation and an Oracle export through the same named connection without re-entering credentials. Repeated manual runs must refresh source metadata and data, preserve execution isolation, and expose lineage from transformed results back to the materialized Oracle source.

Native SQL semantics acceptance must use deterministic fixtures to compare a generated operation with the same SQL executed directly in DuckDB using the same version, extensions, options, and input data. Results and external effects must match. In particular, exporting CSV twice to the same existing file must replace its contents as native single-file `COPY` does, without an extra overwrite flag, confirmation, refusal, or filename change imposed by Duckpad. Oracle exports must preserve the behavior of the emitted `oraduck` statement without hidden destination-table truncation or recreation.

Ordered output acceptance must verify a template whose second output reads its first through `{{ result }}`. The generated statements must follow declaration order, and both outputs must use data from the current node execution. After source data changes, a manual rerun must compute the second output from the newly computed first output rather than the retained previous result. Both outputs become available together after success; a failure in the second block publishes neither replacement. Lineage from the second output must traverse the first output back to the declared inputs. Self-references and references to later output blocks must fail validation.

Invalid-save acceptance must cover malformed declarative syntax, a missing reference, and a graph or component-reference cycle. An invalid state that remains at the end of a save unit must appear in Git history without waiting for correction, remain available for editing, and display actionable validation errors. Duckpad must not execute a previously valid graph as a fallback or erase the invalid content. A localized error blocks its affected dependency scope; an unreadable project graph blocks new executions in the whole worktree. Previously successful affected results remain available as stale previews without lineage. A correction made after the invalid save unit was committed is committed in a later save unit and enables valid execution scopes again without automatic recomputation. A run already in progress keeps its launch configuration.

External-save batching acceptance must verify that two relevant file saves 300 ms apart in the same worktree produce a single commit after 500 ms of inactivity following the second save. The commit must contain the final contents of both files, including an invalid final state when applicable. A later save after that batch closes creates a new commit. An invalid state corrected within one batch does not create an intermediate commit. Separate worktrees have separate batches, and UI-generated file events do not duplicate UI commits. A manual run requested while a batch is pending must capture the committed batch state and record that commit before executing.

Concurrent edit acceptance must start with the same parameter value loaded in the UI and an external editor, then save different values through both paths. Duckpad must detect the conflict even if the external save is still inside its batching interval, retain both proposals and their base, and avoid silently overwriting the file. The conflict must survive a reload and backend restart. The user can choose either proposal or supply a combined value, which is saved under the normal commit and validation rules. A further external edit before resolution must refresh the conflict. Non-conflicting field changes must both be preserved, and affected new executions remain blocked until computation-affecting conflicts are resolved.

Instance connector and connection acceptance must verify that creating or editing either a SQL connector definition or a connection changes no project files and creates no Git commit, including when only non-secret settings change. After updating both, opening an older project revision and running it must use the current connector definition and current connection configuration for the selected environment. The run must record the definition and non-secret settings actually used while keeping secrets outside Git and execution metadata. The historical checkout must not restore or alter the instance catalog. Earlier execution history must still show its original captured definition and settings rather than the updated catalog values. A missing or invalid connector definition, deleted connection, or missing environment configuration must produce an explicit error. A run already in progress must keep the definition and settings captured at its launch.

Distinct-count lineage acceptance must verify that `COUNT(DISTINCT value)` over rows containing `A, A, B` yields `2` and initially displays two groups: `A` with two input rows and `B` with one. Both `A` cells must remain individually identifiable and navigable, rather than being replaced by an arbitrary representative. With more than 5 distinct groups or more than 5 input rows for one value, both levels must support pagination without limiting the provenance search. Counts and excluded inputs must agree with the executed DuckDB aggregate, independently of preview filters and limits.

Recalculation priority acceptance must start a lineage query and then accept a manual run that replaces one of its dependencies. Duckpad must cancel the affected query before replacing those datasets, reject new requests for the old result generation, and discard any late response from the canceled query. Unrelated lineage queries must not be canceled merely because a different dataset is recomputed. After a valid replacement is published, explicitly selecting a new result cell must allow lineage again; failed recomputation must leave the old result without lineage. At no point may one explanation combine contributions from old and new result generations.

Authentication persistence acceptance must verify that a new instance generates and displays its initial `admin` password, and that this same password authenticates against both UI and API after restarting the backend. A normal restart must not rotate the password. Project, branch, worktree, and environment changes must not create separate accounts or passwords. Persisted authentication state must remain outside project Git history and must not store the password in plaintext.

Internationalization acceptance must verify that switching between English, French and Portuguese updates application text and built-in node labels without changing user-authored content, creating a project commit, or invalidating results. The preference must survive a UI reload independently of the selected project. French and Portuguese translations must reside in dedicated localization resources; the rest of the repository remains in English.

Column documentation acceptance must verify that removing a documented column removes its documentation, and renaming `amount` to `total` leaves `total` undocumented. Other columns keep their documentation. The removal is versioned, with the previous documentation still present in earlier Git revisions. Recreating a deleted column does not automatically restore its documentation. A temporarily invalid query or unavailable schema must not delete column documentation merely because the schema cannot be resolved.

Manual cancellation acceptance must stop a run during a long SQL operation and verify that no further node starts, including an otherwise runnable independent branch. The UI must remain responsive and show cancellation in progress until the active operation and cleanup actually finish; another execution cannot overlap in that worktree. The canceled node must publish no staged outputs and must retain any earlier successful output set as a stale preview without lineage. Completed exports must not be undone or repeated automatically. An external write that finishes or reports partial effects after the stop request must have its actual outcome displayed. Repeated stop requests and a late request against a finished run must not corrupt statuses or affect another worktree.

Execution admission acceptance must verify that simultaneous launch requests for the same worktree admit only one run. Further requests are rejected throughout preparation, execution, and cancellation, including a request for another environment. Rejection must not invalidate results, cancel lineage, replace the active run, or leave a deferred execution. Once the active run has fully ended, nothing starts until a new explicit request is made; that request captures the configuration current at its own launch. A run in another worktree must not be rejected solely because the first worktree is occupied.

Persistent execution history acceptance must cover successful, failed, and canceled runs, then restart the backend and verify that their metadata remains readable through the UI and API with the original execution identifiers, SQL, revisions, timings, and outcomes. Subsequent runs must create separate records. Historical previews and cell lineage must remain unavailable when the corresponding in-memory data is gone. Persisted history must contain no secret values or stored result datasets. Interrupting the backend during a run must leave an interrupted record after restart, preserve already recorded node outcomes, and clearly identify any unconfirmed external-write outcome. Startup must not automatically resume or retry that run or repeat its exports.

# AI assistant

The instance administrator enables the assistant (off by default), configures
providers and allowed models, selects the instance default, and controls data
reading and the maximum rows per tool call (50 by default, 1–500). Supported
providers are OpenAI, Anthropic, Google, Mistral, DeepSeek, Ollama and custom
OpenAI-compatible servers. Keys are write-only, optional for Ollama/custom,
retained only for an unchanged provider type and base URL, and excluded from
project files, archives, model instructions, responses and error logs. Model
discovery and the connection test accept unsaved provider settings and reuse a
saved key only under that same rule.

A floating chat on every authenticated page streams safe Markdown and collapsible
tool cards. The expanded view lists author-private conversations in recent-first
order and supports resume, rename and deletion. Each conversation belongs to its
initial project/branch and stores full Pydantic AI message history in SQLite.
Deletion of a project or account cascades to its conversations. Administrators
cannot read other users’ conversations. All tools recheck session and project
permissions; data and compilation tools recheck project connection grants.
The validated page context contains only page/tab/section, project/worktree/branch,
selected node, open Code file, selected environment, optional debug run ID and their names. Saved
content is fetched on demand, in bounded pages. The frontend saves pending local
drafts before sending a message; failed saves prevent the turn. Unsaved drafts
are never included directly in provider payloads.

The exact provider payload consists of the assistant instructions and tool
schemas, the current question, the validated context, previous conversation
messages (including tool exchanges), and whichever tool results are requested:

| Content | Data reading disabled | Data reading enabled |
| --- | --- | --- |
| Flow nodes, edges, parameters, component interfaces, template links | Yes | Yes |
| Saved project definition files: SQL, README, descriptions, variables, extension requirements and manifest | Yes, including literal/variable values in these definitions | Yes |
| Compiled SQL and bound project parameters | Yes, resolved connection secrets redacted | Yes, resolved connection secrets redacted |
| Materialized output schemas, counts, generation IDs and statuses | Yes | Yes |
| Run IDs, environment, timestamps, statuses, durations, commits and per-node status | Yes | Yes |
| Run error text and node message text | Withheld; only error presence | Yes, bounded |
| Historical executed SQL and data-test results | SQL tool absent; result text withheld | Yes, bounded; connection secrets redacted |
| Run proposals, approval/refusal and launched run metadata | For project editors/admins; always explicitly approved | Same |
| Output preview values and filters | Tool absent | Bounded existing output rows |
| Value lineage: selected value, SQL/expression, contributing values, source/schema metadata and limitations | Tool absent | Bounded contribution pages |
| Search excerpts from saved project definitions | Yes | Yes |
| Current-branch Git commit metadata (including authors, messages and hashes) | Yes | Yes |
| Requested write arguments and resulting change summaries, SQL diffs and commit IDs | For project editors/admins | For project editors/admins |
| Provider keys, resolved connection secrets, instance users, sessions, other projects and unsaved editor drafts | Never | Never |

Provider model discovery sends the saved key to the configured endpoint; the
connection test sends only a short verification prompt. User-authored questions,
code, documentation and commit messages are not treated as secret-free simply
because data reading is disabled. If data reading is turned off, previous
conversations that allowed it cannot resume; a new conversation prevents their
old values or responses from being resent. Provider redirects are disabled.

Read tools are `read_flow`, `read_file`, `read_sql`, `read_documentation`,
`read_schemas`, `read_runs`, `search_project`, `read_history`, and optionally
`preview_output` and `explain_value`. Project editors and administrators also
receive `edit_flow`, `write_sql`, `write_documentation`, `edit_variable` and
`group_nodes`. Readers receive no writing tools; forced writes and undo requests
still recheck editing permission. Writes cannot target another worktree or
branch, change instance configuration or launch execution. There is no arbitrary
SQL execution, unrestricted file write or network tool. Editors/admins additionally
receive `launch_run` and `cancel_run`; launch is always deferred for approval.
Read tools include `inspect_run`, `compare_run` and `wait_for_run` (at most 15
seconds per call), plus `read_run_sql` when data reading is enabled. Run diagnostics
include node errors, messages and data tests. Comparison selects the preceding
successful run with the same branch, environment and scope. Historical reads
recheck the run's connection grants. Value explanations combine bounded previews,
lineage contributions and upstream node SQL.

`launch_run` uses Pydantic AI `requires_approval` and `DeferredToolRequests`.
The server persists tool calls and confirmation cards with the conversation, and
resumes the original model history through `DeferredToolResults` after the author
accepts or refuses. A reload preserves pending decisions. A batch waits for every
decision; consumed requests cannot be replayed. If a server restart or disconnect
interrupts the resumed response, the next message closes that turn as stopped
without replaying its decisions. Permission is checked again at launch, using
the same editor role and connection grants as the execution API.
Approval is bound to the proposed definitions, environment and connection
configuration; a changed plan requires a new confirmation. Cards show environment,
scope, used variables, protected-environment confirmation and irreversible exports
or external writes. The run card follows status and allows cancellation. Completed
external writes cannot be undone. Execution history records `entry_point=assistant`
and the requesting user.

Instance administrators manage ordered label/prompt pairs in the assistant
settings. New conversations show them as buttons that send the complete prompt.
Before customization (or after restoring defaults), built-ins follow the UI
language and include flow optimization, debugging and value explanation. An empty
custom list hides all buttons. Quick prompts live only in instance settings;
project-level quick prompts are not supported.

All tools run sequentially. Reads start from a captured committed snapshot;
successful writes advance it. Writes use `projects.write` with that base revision,
three-way merging and bundle validation. Flow edits can batch nodes and edges to
produce a valid graph in one action. Grouping and variable renaming reuse the
same transformations as the UI. Template edits report linked instance counts.
Each changed action produces one commit with the authenticated user's Git
identity and a `Duckpad-Assistant: <conversation>` trailer, displayed in History
as the user **via the assistant**. No-op calls create no commit or undo card.

Action receipts in the conversation store the actual before/after commit pair,
change summary, bounded SQL diff and status before returning to the provider.
They remain available after an interrupted response or conversation resumption.
Undo is an authenticated UI action, not a model tool: base = action's after
files, current = branch's current files, proposal = action's before files. The
same writer creates the inverse commit. Independent later edits survive.
Conflict proposals are durable, preserve independent changes and use the normal
resolution UI; choosing the proposal never silently reverts unrelated edits.
Resolution updates the card; keeping current leaves it undoable. Whole-turn undo
works newest-first, skips already undone actions and stops at a conflict.
Commit-backed bases remain usable after cache eviction or server restart.
The workspace refreshes after actions and retains concurrent editor drafts for
their normal optimistic save. Cards link to Compare versions for each commit.

Each turn has `UsageLimits` of 12 requests
and 30 tool calls, a 120-second deadline and a Stop action that cancels the
provider stream. Errors identify rejected credentials, quota, unavailable models
or connection failures without exposing provider response bodies.

See the [assistant guide](ASSISTANT.md) for setup and usage.
