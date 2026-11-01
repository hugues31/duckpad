# SQL syntax and custom nodes

A Duckpad node contains ordinary DuckDB SQL with comment directives describing
its inputs, parameters, outputs and checks. The same contract applies to a
node's own code and a shared SQL template. Start with the
[15-minute tutorial](QUICKSTART.md) for an example you can run without files.

## Create and edit code

Choose **New SQL node**, select it and use **Edit code → Save changes**. This
changes only that node. Normal palette nodes also receive their own copy of the
SQL. To share code, use **Convert to template** or **Add linked**; editing a
shared template affects all of its linked nodes in that branch. See
[code ownership](AUTHORING.md#editing-node-code).

The inspector's **SQL** tab compiles the current configuration without running
it. After a run, **Results → Log → Executed SQL** shows what actually ran.
Saving code makes affected results stale; choose **Run pipeline** to recompute.

## Declarations

Write each directive on its own line, starting with `-- @`:

| Directive | Purpose |
| --- | --- |
| `-- @label Paid orders` | Display label for the definition |
| `-- @description Keep paid orders.` | Short explanation |
| `-- @kind source` | Read external resources, or produce initial data |
| `-- @kind transform` | Transform declared inputs; the default if omitted |
| `-- @kind export` | Write to a declared destination; no tabular output |
| `-- @input source` | Declare an input port to connect on the canvas |
| `-- @param status: text = "paid"` | Typed parameter and optional default |
| `-- @output orders` | Name the query's output port |
| `-- @test amount_present: error` | Check for failing rows; severity defaults to `error` |
| `-- @message` | Query returning `level` and `message` columns |

Inputs, parameters and outputs share one namespace: use unique identifiers made
of letters, digits and underscores, starting with a letter or underscore.
Unknown directives are errors. Each output block contains exactly one query,
ending with a semicolon. A transform cannot write data or read undeclared tables.

## Reference inputs and earlier outputs

```sql
-- @label Paid orders
-- @input source
-- @param status: text = "paid"
-- @output orders
SELECT * FROM {{ source }} WHERE status = {{ status }};
-- @output summary
SELECT COUNT(*) AS orders, SUM(amount) AS revenue FROM {{ orders }};
```

Connect a node output to the `source` input. References such as `{{ source }}`
resolve to that table; `{{ status }}` becomes a bound value. Do not write
`'{{ status }}'` or substitute a canvas label for a declared port. A CTE or
subquery can read the same declared inputs.

An output can read earlier outputs in the same file. Self references and forward
references fail validation. All outputs publish together; a failed query or an
error check keeps the previous successful outputs stale and blocks descendants.

## Read a file

Use a **Load CSV** palette node, or put this complete definition in a new node:

```sql
-- @label Read orders
-- @kind source
-- @param connection: connection = "local"
-- @param path: file(connection)
-- @output orders
SELECT * FROM read_csv({{ path }}, header = true);
```

Set `path` through the node's file parameter: upload a CSV or select an allowed
file path. The connection must be granted to the project. Relative paths resolve
against its configured root; uploads belong to the project. File readers use
one declared file parameter (or a list) as their only positional argument, with
named options such as `header = true` or `delim = ';'` afterward.

For Parquet use `read_parquet({{ path }})`. XLSX, S3 and Oracle have additional
connection or extension requirements; follow [Connections](CONNECTORS.md).
Ordinary transformations cannot bypass this contract with undeclared file reads.

## Write an export

```sql
-- @label Export report
-- @kind export
-- @input source
-- @param connection: connection = "local"
-- @param destination: destination(connection) = "report.csv"
COPY (SELECT * FROM {{ source }})
TO {{ destination }} (FORMAT CSV, HEADER TRUE);
```

Connect `source` to the table you want to export. Exports have no `@output`.
When the local connection has no root, the relative destination resolves inside
the branch and environment's export directory. Run the node and open **Log →
Download exported data** to retrieve its CSV. See [project exports](AUTHORING.md)
for download lifetime, XLSX and destination limits.

An export can also declare tests and messages. They run **before the external
write**, even when declared below `COPY`. A failing error check prevents it.

## Parameter values


Numeric and list fields preserve the text you type until you leave the field or
save. Clearing a numeric field removes its override, so the template, component,
or connector default applies. Without a default, the parameter remains required.
Comma-separated lists trim spaces around each item and preserve spaces within
items: `New York, Paris` becomes `["New York", "Paris"]`.

| Parameter declaration | Value contract |
| --- | --- |
| `text`, `number`, `boolean` | Scalar DuckDB bindings; do not quote the placeholder |
| `date` | A `YYYY-MM-DD` value bound as a DuckDB `DATE` |
| `choice(a\|b)` | Enumerated scalar binding |
| `keyword(inner\|left\|right\|full)` | Validated SQL keyword, for structural choices |
| `file(connection)`, `destination(connection)` | Explicit path or URI; relative local paths resolve against the connection root or worktree/environment export directory |
| `connection` | Logical instance connection ID; resolves to a collision-free runtime alias |
| `secret(connection)` | Runtime secret name, for extension options; never a password |
| `identifier`, `column(source)` | Quoted identifiers; input column suggestions use resolved schemas |
| `expression(source)` | Parsed scalar SQL expression; queries and side effects are rejected |
| `expressions` | Comma-separated or array expression list, for projections and aggregates |
| `list<text>`, `list<number>`, `list<boolean>`, `list<column>` | A typed list emitted as literals or identifiers |
| `schema` | JSON mapping of column names to DuckDB types, used for CSV overrides |

Transformations may read only declared inputs, earlier outputs, local CTEs and subqueries. External table functions and undeclared tables are rejected. A source uses `-- @kind source` and explicitly declared resource parameters. Each file reader such as `read_csv` takes one declared file parameter, or a list of them, as its only positional argument; its other arguments must be named options such as `delim = ';'`. Exports use `-- @kind export`, declared tabular inputs and explicit `COPY ... TO` or `INSERT` statements. They have no tabular output. Connector setup is separate from those data operations.

Compilation is available without executing the flow. The inspector's **SQL** tab shows the query compiled from the current configuration; the **Executed SQL** of the results panel's **Log** shows the actual statement sequence of the displayed result. Actual materialization statements include private storage/view setup and bound values; generated credentials are masked.


## Check data and report messages

Append checks to a node after its output queries:

```sql
-- @test amount_present
SELECT * FROM {{ orders }} WHERE amount IS NULL;
-- @message
SELECT 'info' AS level, COUNT(*) || ' orders checked' AS message
FROM {{ orders }};
```

These blocks assume the `orders` output from the transformation above. A test
returns failing rows, not a count row. Message levels are `info`, `warning` and
`error`; a zero-row message query emits nothing. Outputs compute first, then
checks run in declaration order before publication or export. Read the dedicated
[data tests](TESTS.md) and [execution messages](MESSAGES.md) guides for failure
behavior, history and limits.

## Reuse values across nodes

Declare a typed [project variable](VARIABLES.md), then bind an instance parameter
using its variable button. For a root flow's expression parameter, write a
reference such as `amount >= {{ var.minimum }}` in the parameter's value.
Variable references belong to root instances, not reusable SQL definitions or
template defaults. Expose a component parameter and bind it on the instance.

Variables are versioned values, not credentials. Keep secrets in connections;
`secret(connection)` refers to a runtime secret name, never a password.

## Diagnose a node

| Symptom | Check |
| --- | --- |
| Missing input | Connect every declared input, or remove an unused declaration |
| Undeclared, self or forward reference | Match the name and move the required output earlier |
| More than one statement | Put each tabular query in its own output block |
| Undeclared table or file read | Use a declared input or a source with resource parameters |
| Invalid expression | Expression parameters accept scalar expressions, not queries |
| A test fails with count zero | Return failing rows; `SELECT COUNT(*)` itself returns a row |
| A successful result is stale | Save, then rerun after SQL or parameter changes |

Inspect the current compiled SQL for configuration errors and the
[execution log](RESULTS.md#log) for the statements and values of a particular run.
