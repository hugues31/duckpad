# Execution messages

Report business information, warnings and errors directly from node SQL.
For persistent quality checks with pass/fail counts, use [data tests](TESTS.md).

## Write a message

Add `-- @message` in a normal node's code to report information about that node,
or in a template to apply it to every linked node. There is no separate Message
node or inspector field. Each block contains one read-only query:

```sql
-- @input source
-- @param status: text = "paid"
-- @output orders
SELECT * FROM {{ source }} WHERE status = {{ status }};
-- @message
SELECT 'warning' AS level, count(*) || ' orders without an amount' AS message
FROM {{ orders }} WHERE amount IS NULL HAVING count(*) > 0;
```

## Result contract

The query must return unique `level` and `message` columns. Every row emits one
message; zero rows emit none. Levels are exactly `info`, `warning`, or `error`;
messages must be non-null text. Missing columns, unknown levels and invalid
messages fail the node with an explicit error. Additional columns are ignored.

## Execution and failure

All output blocks run first. Message blocks then run in declaration order and
can reference declared inputs, parameters and any of the newly computed outputs,
even if that output is declared later in the file. They obey the node's declared
data access contract and cannot write data or introduce side effects. A source
can use its declared connections and resources. On an export, message queries
read its inputs and run **before any external write**, even though the `COPY` or
`INSERT` statement is written before `-- @message` in the file.

An `error` result prevents publication of every new output, retains the previous
successful outputs as stale, and blocks descendants. All message blocks are
checked before publication or export; warnings alone leave the run in `success`.
Changing a message block invalidates results just like changing other SQL.

## Read messages

The **Log** tab of the [results panel](RESULTS.md) lists the messages of the
run behind the displayed result; a stale retained result keeps its original
messages alongside the latest failure. The canvas shows a warning badge and
count; selecting the badge opens the Log. History retains messages and warning totals for
each run, including failures and exports, after a restart. A node outside the
scope of a later launch keeps its previous result's messages.

## Limits and server logs

Each node execution retains the first **100 messages**, followed by “... and N
more”. All additional rows are still validated and counted: an error beyond the
limit still fails the node. Server logs emit one JSON line per actual message,
including run, project, branch, environment, node, level, message and origin.
Multiline text is escaped within that line. Connection secrets are redacted in
messages, errors, saved history and logs. User-authored message text is displayed
as written; interface labels are translated into English, French and Portuguese.

See [SQL syntax](SQL.md) for declarations and [results and logs](RESULTS.md#log)
for the execution timeline.
