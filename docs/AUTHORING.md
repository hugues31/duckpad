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
