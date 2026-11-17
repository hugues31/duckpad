# Prepare data with the default palette

The defaults are ordinary, editable SQL templates. Each declares an `@icon`,
including the existing loaders, selection, cleaning and export nodes. The same
icons and parameter types work in your own SQL files; a template identifier
never unlocks a special execution capability. **Edit code**, generated **SQL**,
previews and data tests remain available.

## Join, filter and aggregate with forms

Run upstream nodes to populate the column choices and types.

- **Join** accepts multiple equality key pairs and `inner`, `left`, `right` or
  `full` joins. Every pair must match. Types must be identical or both numeric;
  convert other types explicitly with Select columns. Repeated keys multiply
  matches; null keys never match. Outer joins retain unmatched rows with nulls
  on the other side. Conflicting right column names receive `right_`, then a
  numeric suffix if needed. Choose all or left columns, or edit the projection
  in Advanced SQL. The two SQL aliases are `l` and `r`.
- **Filter** accepts comparisons and nested **All (AND)** / **Any (OR)** groups.
  A filter without conditions keeps every row, and empty groups are ignored.
  VARCHAR values remain text (`001` and `NULL` are literal text). Use IS NULL /
  IS NOT NULL for null checks. Numeric and Boolean values are validated; LIKE
  requires VARCHAR. In the root flow, **Value source** compares with a
  [variable](VARIABLES.md#variables-in-expressions) instead of a fixed value.
- **Aggregate** accepts grouping columns and named measures. SUM/AVG require
  numeric columns. COUNT(*) counts rows; COUNT(column) and COUNT DISTINCT ignore
  nulls. Without grouping columns, empty input still produces one total row
  (COUNT=0, SUM=NULL). Grouped empty input produces no rows. Choose unique measure
  names distinct from the grouping columns.

Settings are stored in `flow.json` and restored on reload. **Advanced SQL**
converts a valid setting to editable SQL. **Reset to an empty form** explicitly
clears that parameter; other parameters keep their settings.

New nodes start without column choices: pick them once the upstream node has
run. Column lists use checkboxes and keep the order in which you check them.

For a complete walkthrough, upload these CSVs to two Load CSV nodes:

```csv
order_id,customer_id,amount,status
1,1,10,paid
2,1,20,paid
3,2,5,refunded
4,3,7,paid
```

```csv
customer_id,region
1,North
2,South
3,West
```

Run the sources, join on customer_id, filter status equal to paid, and aggregate
by region with SUM(amount) named revenue and COUNT(*) named orders. Expect
North / 30 / 2 and West / 7 / 1. Connect Export CSV or Export Parquet, run it,
and download the complete file from **Log**. No SQL entry is required.

## More transformations

| Node | Settings and representative result |
| --- | --- |
| Union | `ALL BY NAME` aligns names, fills missing columns with nulls and keeps duplicates: [1,2] plus [2,3] gives four rows. `BY NAME` removes duplicates; `ALL` and `DISTINCT` align by position. DuckDB coerces compatible types and rejects incompatible ones. Order is unspecified. |
| Sort | Ordered column list with ASC/DESC and nulls first/last. Amount DESC, nulls last puts the largest amount first. Add a unique final key to decide ties; downstream SQL must specify its own ordering when needed. |
| Deduplicate | Key columns and retention order. Key customer_id with order_id DESC keeps the latest order per customer. Null keys form one group. Add a unique final sort key to make row retention deterministic. |
| Calculated columns | SQL expressions with unique aliases; empty passes the input through. `amount * 1.2 AS gross_amount` appends 12 for amount 10. Existing columns remain; nulls follow SQL expression semantics. |
| Pivot | Group columns, category, value, explicit category values and aggregate function. Without group columns, one row aggregates the whole input. Region/channel/SUM(amount) turns Web and Retail into columns. Repeated pairs aggregate; absent SUM cells are null. Unlisted categories do not contribute. Explicit values keep the schema stable. |
| Unpivot | Selected columns, name and value output names. Web=10, Retail=NULL becomes (Web,10) and (Retail,NULL), retaining other columns. Selected columns need compatible types. Null values are retained. |
| Sample | Key, percentage (0–100), seed. MD5 of the typed key and seed selects an approximate percentage independent of input order. Same keys and seed reproduce the selection. Duplicate and null keys are selected together; use a unique nonnull key for independent rows. Zero keeps none; 100 keeps all. |
| Rank | Partition columns, order, output name. Amount DESC ranks the largest value first in each group. Ties share ranks and leave gaps; null keys share a group. Without partition columns, the whole input is ranked. |
| Running total | Partition columns, order, numeric value, output name. Amounts 10,20 produce 10,30 in a group. The frame ends at the current row; null values are ignored. Use a unique final order key for reproducible ties. Without partition columns, the total runs over the whole input. |
| Export Parquet | Destination and ZSTD/SNAPPY/UNCOMPRESSED compression. Writes column types and nulls to export.parquet, replacing the destination on each run. The completed file is downloadable like CSV/XLSX. |

All accept empty input once required settings are configured. Conversion or
aggregation errors fail normally, retaining prior results as stale.

In Northstar, drag **Preparation tour** from the palette onto the canvas. This
self-contained component loads its own sample inputs and demonstrates every new template: 120 orders
are appended twice and deduplicated to 120, calculated, sampled at 100%, ranked,
accumulated, sorted and exported as Parquet. Its pivot has four region rows and
its unpivot has twelve region/channel rows, including nulls. Its regional summary
uses grouping and measure forms. Change the sample percentage to experiment.

Lineage keeps the existing SQL coverage for projections, joins, filters,
aggregates, supported set operations and windows. **Pivot, Unpivot, Deduplicate (QUALIFY) and Union BY NAME report
incomplete cell lineage**; their results and previews work. Custom SQL may also
leave the supported subset. See [Lineage](LINEAGE.md).

## Reusable forms

New projects include these templates. A project created with an earlier version
keeps the templates it was created with.

Use the public parameter types in any custom template:

```sql
-- @label My customer filter
-- @icon filter
-- @input customers
-- @param rules: conditions(customers) = {"mode":"and","conditions":[]}
-- @output accepted
SELECT * FROM {{ customers }} WHERE {{ rules }};
```

| Type | JSON form value and SQL fragment |
| --- | --- |
| `conditions(input)` | `{ "mode": "and", "conditions": [...] }`, with nested groups or `{ "column": "amount", "operator": ">", "value": "10" }`; a predicate. A value of exactly `{{ var.name }}` compares with a variable. |
| `join_keys(left,right)` | `[{ "left": "id", "right": "customer_id" }]`; equality predicates joined by AND, using SQL aliases `l` and `r`. |
| `joined_columns(left,right)` | `"all"` or `"left"`; a projection with unique right aliases, using SQL aliases `l` and `r`. |
| `group_columns(input)` | `["region"]`; quoted columns **with a trailing comma**, or empty text for `[]`. Use `SELECT {{ groups }}{{ measures }} ... GROUP BY ALL`, or `PARTITION BY {{ groups }}NULL` so that no group means the whole input. |
| `measures(input)` | `[{ "function": "SUM", "column": "amount", "alias": "revenue" }]`; SUM, AVG, MIN, MAX, COUNT or COUNT DISTINCT. Only COUNT accepts `*`. |
| `ordering(input)` | `[{ "column": "id", "direction": "asc", "nulls": "last" }]`; ordered SQL list. Defaults are asc and nulls last. |
| `columns(input)` | A nonempty list of names, quoted as a SQL list. |

Each type also accepts a SQL string for Advanced SQL. The forms quote names
containing spaces, dots or quotes as single identifiers. The compiler validates
declared ports, selected columns and applicable types, using the same access
restrictions for built-in and custom code. No special node registration is needed.
Column impact can inspect the generated SQL; automatic renames of structured
form settings currently require manual review. Advanced SQL strings retain the
existing expression rename support.

## Select columns and clean values

New projects include **Select columns** and **Clean values** templates. Connect their
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

The forms store structured `columns` parameters in `flow.json`, so selections and operations survive reloads and replacement input
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
