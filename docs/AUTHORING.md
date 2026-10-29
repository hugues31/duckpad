# Authoring projects

The **Code** tab, between **Flow** and **Documentation**, displays the worktree's declarative files in a folder tree beside the Monaco editor. Select a file to edit its SQL, JSON, Markdown or TOML, then choose **Save changes**. Drafts are retained when switching files or workspace tabs. Editing files in an external editor is also supported. Every completed save is versioned, including invalid content. Corrections create later commits. Inspect errors and fix the current files; Duckpad never runs an earlier valid graph silently.

Choose **Download project ZIP** in the Code tab to export the selected branch's saved `README.md`, `pyproject.toml`, `flow.json`, `documentation.json`, SQL templates and component definitions, preserving their relative paths. Save or discard pending edits before downloading. The archive excludes Git history, datasets, execution results, virtual environments and instance connection settings. Project readers can browse and download these files; editing requires an editor or administrator role.

To recreate a project from such an archive, choose **New project**, then **Import a project ZIP**, and select the file. Leave the name empty to keep the name stored in `flow.json`. Archives whose files sit in a single top-level folder, such as a repository download from a Git host, are accepted. Only the declarative files above are read; Git metadata, data and other entries are ignored. The imported project starts its own Git history, makes you its administrator and can use only the **Local files** connection until an instance administrator grants others. Because the archive contains no connection settings or data, Duckpad then lists the connections the pipeline references that are unavailable to the new project, and the nodes that read uploaded files or other absolute paths, including Windows and network paths. Grant or create those connections, and upload the files again. Archives over 16 MiB (64 MiB once extracted), without `flow.json`, or with invalid JSON or non-UTF-8 files are rejected without creating a project.

After running **Export CSV**, **Export XLSX**, or another export template whose single `COPY ... TO` statement writes CSV or XLSX to a `destination` parameter, select the export node and choose **Download exported data** in its inspector. The file contains the entire executed export, including its delimiter, headers and worksheet name. The inspector identifies the execution and environment. Changing inputs or settings, rerunning upstream nodes, or a failed execution requires another successful export before downloading. Missing files also require a rerun. Downloads are private to project members, survive a backend restart, and use a saved copy of the exported bytes so later writes to the destination cannot replace that execution's result. Oracle and remote-storage destinations do not offer this action.

## Project layout and Python dependencies

```text
README.md              Project documentation in Markdown
pyproject.toml         Python version and project dependencies
flow.json              Pipeline graph
documentation.json     Node, output and column documentation
templates/*.sql        SQL definitions
components/*.json      Reusable sub-flows
```

The **Documentation** tab edits the same `README.md` shown in **Code**. Project
text is not duplicated in `documentation.json`. Older projects with a `project`
entry in that JSON file remain readable; the next bundle save moves that text
to `README.md` and adds the dependency manifest. When both sources exist,
`README.md` takes precedence, including when it is empty.

New projects include a standard `[project]` table in `pyproject.toml`, with a
normalized name, Python `>=3.11`, and `duckpad` pinned to the creating instance's
version. Edit `project.dependencies` in **Code** to add Python packages, for
example `"pandas>=2"`. Comments and custom TOML tables survive other UI saves.
The file is versioned, compared and exported with the rest of the project.
Malformed TOML produces a file diagnostic and remains editable.

On another machine with Python and [uv](https://docs.astral.sh/uv/), extract the
ZIP and run `uv sync` from its directory to install the declared dependencies
into `.venv`. The manifest sets `tool.uv.package = false`: this directory holds
a pipeline, rather than a Python package to build. `uv` creates its local lockfile;
Duckpad does not yet manage or export that lockfile, so transitive dependencies
are not frozen by the ZIP.

This manifest prepares project-specific Python environments. Duckpad currently
executes SQL pipelines; saving this file does not install packages, create an
environment or run Python scripts. The CLI does not yet open an extracted ZIP
as a project automatically; import the ZIP from the interface instead.
Connections, credentials and input data must also be configured separately on
another instance.

## SQL template contract

```sql
-- @label Paid orders
-- @description Keep paid orders and summarize that newly computed output.
-- @input source
-- @param status: text = "paid"
-- @output orders
SELECT * FROM {{ source }} WHERE status = {{ status }};
-- @output summary
SELECT COUNT(*) AS orders, SUM(amount) AS revenue FROM {{ orders }};
```

Inputs, parameters and outputs have one shared namespace. Identifiers must be unique. Each output names exactly one query ending with a semicolon. Later blocks may read earlier outputs; self and forward references fail validation. Both outputs above are published together, or neither replaces the previous result set.

Numeric and list fields preserve the text you type until you leave the field or
save. Clearing a numeric field removes its override, so the template, component,
or connector default applies. Without a default, the parameter remains required.
Comma-separated lists trim spaces around each item and preserve spaces within
items: `New York, Paris` becomes `["New York", "Paris"]`.

| Parameter declaration | Value contract |
| --- | --- |
| `text`, `number`, `boolean` | Scalar DuckDB bindings; do not quote the placeholder |
| `choice(a\|b)` | Enumerated scalar binding |
| `keyword(inner\|left\|right\|full)` | Validated SQL keyword, for structural choices |
| `file(connection)`, `destination(connection)` | Explicit path or URI; relative local paths resolve against the connection root or worktree/environment export directory |
| `connection` | Logical instance connection ID; resolves to a collision-free runtime alias |
| `secret(connection)` | Runtime secret name, for extension options; never a password |
| `identifier`, `column(source)` | Quoted identifiers; input column suggestions use resolved schemas |
| `expression(source)` | Parsed scalar SQL expression; queries and side effects are rejected |
| `expressions` | Comma-separated or array expression list, for projections and aggregates |
| `list<text>`, `list<number>`, `list<column>` | A typed list emitted as literals or identifiers |
| `schema` | JSON mapping of column names to DuckDB types, used for CSV overrides |

Transformations may read only declared inputs, earlier outputs, local CTEs and subqueries. External table functions and undeclared tables are rejected. A source uses `-- @kind source` and explicitly declared resource parameters. Each file reader such as `read_csv` takes one declared file parameter, or a list of them, as its only positional argument; its other arguments must be named options such as `delim = ';'`. Exports use `-- @kind export`, declared tabular inputs and explicit `COPY ... TO` or `INSERT` statements. They have no tabular output. Connector setup is separate from those data operations.

Compilation is available without executing the flow. The SQL inspector distinguishes the current compiled query from the actual statement sequence of the displayed result. Actual materialization statements include private storage/view setup and bound values; generated credentials are masked.

## Graph and components

`flow.json` holds `nodes` and `edges`. Nodes reference local `template` or `component` IDs and own their parameters and position. Edges use stable `source`, `sourceHandle`, `target` and `targetHandle` IDs. Selecting an input in the inspector edits the same edge as dragging a port connection. An input has at most one source; an output can feed many inputs.

Drag an input or output connection onto empty canvas space to open **Add a connected node**. Search the local templates and components, then choose a port to create the node at the drop position and connect it in one save. The list only offers nodes with ports in the required direction. Use the arrow keys and Enter, or click a result; Escape or a click outside cancels without changing the graph. Starting from an occupied input replaces its previous connection when the new node is added.

Select nodes using Shift, then choose **Group into component**. Incoming and outgoing edges are preserved as named boundary ports; terminal outputs remain inspectable. Double-click the resulting node to open the sub-flow. Breadcrumbs identify the instance path. Definition edits affect every usage in this project branch, while parameters belong to the selected instance.

Exposed component parameters have the following structure:

```json
{
  "minimum": {
    "type": "number",
    "default": 100,
    "targets": [{"node": "filter_node", "param": "threshold"}]
  }
}
```

The shared library reads projects' main branches. Importing creates new destination-owned IDs for the component, nested components and templates. Definitions and documentation are copied; data, results and secrets are not. Imports never resolve executable code through the original project. Subsequent edits are independent.

## Documentation and branches

Business documentation is separate from SQL and covers the project, node instances, outputs and columns. Grouping preserves the documented instance paths; imports carry component documentation. Successfully confirmed schema removals prune missing column documentation in a versioned save. Renames start undocumented. Invalid SQL, failed runs and backend restarts do not imply deletion.

Create a working branch to compare a change. Branches have isolated worktrees and memory contexts, and use the same instance connections. **Compare & merge** performs three-way merging and validates the graph/interfaces before acceptance. Git history can open a chosen revision in a new working branch. Recompute manually there to explore its code against current resources and connection settings.

## Select columns and Clean values

New projects include two form-driven transformation templates. Connect their
`source` input and run the upstream node to load column choices and types.

- **Select columns** keeps only the listed columns, in their displayed order.
  Use **Use all columns** to add any unlisted inputs, **Drop column** to exclude
  one, and **Move up / Move down** to reorder. Each row can rename its output or
  select a target type. Names must be nonempty, free of control characters, and
  unique under DuckDB's case-insensitive identifier rules. Spaces, dots and
  quotes are supported. Type changes use strict `CAST`, with DuckDB's native
  conversion semantics (including rounding when converting to integers).
- **Clean values** configures selected columns and preserves all other columns.
  Each row applies **Trim text**, then **Parse date**, then **Replace nulls**.
  Trim and date parsing require `VARCHAR`; convert another source type with
  Select columns first. Parsing uses a DuckDB date format such as `%d/%m/%Y`
  and produces `DATE`. Invalid dates and formats fail the run. Null replacement
  uses the resulting column type, so parsed dates take `YYYY-MM-DD` replacements.
  Empty replacement text is an empty string, and `NULL` is literal text.

Save changes before running. The forms store structured `columns` parameters in
`flow.json`, so selections and operations survive reloads and replacement input
files. A missing source column fails with a message asking you to update the
selection. Conversion failures retain previous results as stale and block
dependent nodes; they do not substitute nulls for invalid data.

For example, load `id,amount,day` as `VARCHAR,BIGINT,VARCHAR`. In Clean values,
trim `id`, replace null `amount` with `0`, and parse `day` with `%d/%m/%Y`. In
Select columns, keep `day`, `id`, `amount` in that order and rename them to `date`,
`key`, `total`. An input row ` 001 ,NULL,31/12/2026` produces
`2026-12-31,001,0` with types `DATE,VARCHAR,BIGINT`.

The reusable parameter types are `column_selection(input_port)` and
`value_cleaning(input_port)`. Selection rows contain `source` and optional
`name` / `type`. Cleaning rows contain `source` and optional `trim`,
`date_format`, and `replacement`; omitting a setting disables that operation.
The **SQL** tab shows the generated query. **Edit template** remains available
for custom SQL, including replacing a structured parameter with `expressions`
when a free-form projection is needed.
