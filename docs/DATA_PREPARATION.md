# Prepare columns and values

Select, rename, reorder and cast columns, then clean text, dates and missing
values with guided forms.

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
The **SQL** tab shows the generated query. **Edit code** (or **Edit template** for a linked node) remains available
for custom SQL, including replacing a structured parameter with `expressions`
when a free-form projection is needed.

Use [SQL nodes](SQL.md) for custom transformations and [data tests](TESTS.md)
to check the result.
