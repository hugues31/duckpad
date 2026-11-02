# Data tests

Check the data before publishing a result or writing an export. Tests live with
the node SQL and follow the same Git history as the transformation.

## Write a test

Use `-- @test <name>: <severity>` in a normal node's code, or in a template for
all linked nodes. Names are identifiers (letters, numbers and underscores,
starting with a letter or underscore) and must be unique among the node's tests.
Severity is `warning` or `error`; omitting `: <severity>` defaults to `error`.

```sql
-- @input source
-- @param status: text = "paid"
-- @output orders
SELECT * FROM {{ source }} WHERE status = {{ status }};
-- @test amount_present
SELECT * FROM {{ orders }} WHERE amount IS NULL;
-- @test customer_known: warning
SELECT * FROM {{ orders }} WHERE customer_id IS NULL;
```

## Failing rows, not counts

Each query returns **failing rows**. Zero rows means OK; otherwise the test reports
Warning or Error and the observed value is the number of failing rows. Return the
rows themselves, not `count(*)`: an aggregate normally returns one row, even when
its count is zero. Unlike `@message`, a test requires no special result columns
and always records one result, including when it passes. Duckpad counts in the
query engine and never saves a sample of failing rows.

## Execution and severity

Outputs run first, then tests and messages together in declaration order, before
publication or external writes. They share the same read-only access contract:
inputs, parameters and all newly computed outputs are available; sources may use
their declared resources, and exports may read their inputs. A failing `error`
test prevents every new output from being published, keeps prior outputs stale,
and blocks descendants. On exports it prevents the write. A failing `warning`
test adds one warning, regardless of its row count, and leaves the run successful.
All checks still run after a test reports failure. Editing tests invalidates
results, just like changing other SQL.

## Inspect outcomes

When a node's code declares tests, the **Tests** tab of the
[results panel](RESULTS.md) shows each test with its latest outcome and a
strip of its last ten attempts for that node and environment, including failed
attempts with no published output. **Show the failing rows** recomputes a
failing test's rows on demand.
An out-of-scope launch does not replace this history. History also includes each
test's status, name, associated output (when the query references exactly one),
and observed count in run details. The canvas warning badge includes failed
warning tests. Every test result is retained, independently of the 100-message
limit. Server logs emit one structured `node_result` line for each failed test,
with the same context and secret redaction as messages. UI labels are available
in English, French and Portuguese.

See [SQL syntax](SQL.md) for the complete contract and
[results and failing rows](RESULTS.md#tests) to investigate an outcome.
