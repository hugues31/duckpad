# Authoring projects

The **Code** tab, between **Flow** and **Documentation**, displays the worktree's declarative files in a folder tree beside the Monaco editor. Select a file to edit its SQL or JSON, then choose **Save changes**. Drafts are retained when switching files or workspace tabs. Editing files in an external editor is also supported. Every completed save is versioned, including invalid SQL or JSON. Corrections create later commits. Inspect errors and fix the current files; Duckpad never runs an earlier valid graph silently.

Choose **Download ZIP** in the Code tab to export the selected branch's saved `flow.json`, `documentation.json`, SQL templates and component definitions, preserving their relative paths. Save or discard pending edits before downloading. The archive excludes Git history, datasets, execution results and instance connection settings. Project readers can browse and download these files; editing requires an editor or administrator role.

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

Transformations may read only declared inputs, earlier outputs, local CTEs and subqueries. External table functions and undeclared tables are rejected. A source uses `-- @kind source` and explicitly declared resource parameters. Exports use `-- @kind export`, declared tabular inputs and explicit `COPY ... TO` or `INSERT` statements. They have no tabular output. Connector setup is separate from those data operations.

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
when a free-form projection is needed. Existing project templates are not
rewritten automatically; copy these template definitions from a new project
through Code to add them to an older project.
