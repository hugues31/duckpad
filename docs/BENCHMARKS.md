# Scaling and cell-lineage benchmarks

`scripts/benchmark_scaling.py` measures 10,000, 100,000, 1,000,000 and 10,000,000
synthetic fact rows. It validates results against native DuckDB and, optionally,
PostgreSQL. It measures the embedded execution service, not browser latency or
the isolated HTTP SQL worker. The older 50-column reference in
[Validation](VALIDATION.md) is a different workload and machine.

## Reproduce

After [development setup](../CONTRIBUTING.md#set-up-a-development-environment) on Linux:

```sh
uv run python scripts/benchmark_scaling.py
uv run python scripts/benchmark_scaling.py --rows 10000 --repeats 1
```

The default output is `.duckpad-dev/benchmark-scaling.json`, outside tracked
files. The full matrix uses three fresh processes per size and source, one
DuckDB thread and a 2 GiB DuckDB memory limit. Change these with `--repeats`,
`--threads` and `--memory-limit`. `--timeout` bounds each worker (600 seconds by
default). Run with assertions enabled. Use a quiet machine with sufficient free
disk for fixtures and spill; run this manually, not on every CI change.

For PostgreSQL, use a disposable database. Set `DUCKPAD_BENCHMARK_POSTGRES_DSN`
privately to a libpq connection string with permission to create schemas, then:

```sh
uv run --with 'psycopg[binary]>=3.2,<4' python scripts/benchmark_scaling.py --postgres
```

The driver is a benchmark-only dependency. DuckDB also needs its `postgres`
extension, installed using the normal extension setup for your build. The script
creates a uniquely named schema per size, generates and analyzes ordinary tables
without indexes, and drops only that schema in `finally`. A killed parent process
can leave its temporary schema behind. It does not modify existing application
tables. No DSN, password, host, schema identifier or runtime path is included in
the report. Raw failure diagnostics are private and must not be published.

## Workload and boundaries

The eight fact columns are an ordered BIGINT id, INTEGER customer key, nullable
BIGINT amount in cents, INTEGER category, BOOLEAN flag, DATE, 16-character text
code and INTEGER quantity. Fixed arithmetic generates identical data in both
engines, without Faker or a random seed. Every 97th amount is NULL. There are
10,000 uniformly distributed keys and 12,000 dimension rows: keys 0–1999 have
two matches. The join expands N facts to 1.2N rows in eight regions.

The Duckpad pipeline materializes both sources, their join, grouped SUM,
COUNT(amount), COUNT(*) and COUNT(DISTINCT customer_id), plus a separate SUM over
the first 1% of fact ids. The latter applies its predicate after the full source
has been materialized. Sources are Parquet or the actual PostgreSQL Load table
connector; lineage always reads retained DuckDB data.

The report distinguishes:

- `pipeline_seconds`: launch through run-thread completion, including source
  reads, materialization, lineage witness capture and durable run bookkeeping.
- `duckdb_staged_seconds`: the same five materializations without Duckpad
  orchestration or row witnesses, read from Parquet.
- `duckdb_fused_seconds` / `postgres_fused_seconds`: one native join/aggregate
  SELECT returning eight rows. These omit intermediate storage and lineage;
  they are optimization references, not equivalent services.
- `*_filter_at_source_seconds`: one SUM with `id < N/100` at the source, without
  materializing all columns or all facts first.
- `lineage_first_seconds`, `lineage_next_seconds`, `lineage_last_seconds`: five
  contributions plus the exact count and selection context. The last page has
  offset `total - 5`, exposing deep pagination cost.
- `lineage_drill_five_seconds`: ten sequential requests tracing the first five
  contributions through their join to source cells, as a simplified graph load.
- `lineage_distinct_seconds` / `lineage_distinct_group_seconds`: the first five
  distinct groups and the first page inside the first group.

Each sample checks exact aggregate values and cardinalities, NULL exclusion,
disjoint lineage pages, source-cell values, distinct-group totals and native
equivalence. Profiles run **after** latency measurements on the last repetition:
DuckDB operator timing/cardinality, Python cumulative application time, and a
PostgreSQL plan with buffers. Profiling overhead is excluded from measured
latencies. Operator times can overlap or accumulate across threads; Python
cumulative times are nested and must not be summed.

Fixture generation, PostgreSQL load/ANALYZE, project creation and process startup
are excluded from pipeline timing. Native baselines run before Duckpad, and
filesystem/PostgreSQL caches are never flushed. Fresh process does not mean cold
disk. Samples and min/median/max are retained, with no percentile claim from
three observations. Peak RSS is the entire benchmark worker's high-water mark,
including native baselines and diagnostic profiles; it excludes the PostgreSQL
server and fixture generator. The DuckDB memory limit is not a process RSS cap.

PostgreSQL native queries use no parallel workers, 64 MB `work_mem` and no JIT;
the report records server version and selected settings. Native PostgreSQL
execution and DuckDB transfer through its PostgreSQL scanner have different
costs. This is an analytical, unindexed workload, not an OLTP engine ranking.

## Interpreting profiles

Use `Lineage.page` in `src/duckpad/lineage.py` to locate exact count, DISTINCT and
ordered-page work. It runs the contribution query for a count and again for a
page, and repeats the process for selection context on every request. Large
groups and deep OFFSETs are intentional stress cases. `TraceQuery` in
`src/duckpad/trace/query.py` constructs the queries; `AggregateVisitor` in
`src/duckpad/trace/aggregate.py` selects the group and excludes NULL amounts.

Candidate experiments include caching counts/candidate identities for an
immutable dataset generation, deduplicating narrow identity tuples before
formatting JSON values, and avoiding DISTINCT only where uniqueness is proven.
Invalidate any cache on recomputation and preserve context, NULL and duplicate
semantics. Compare deep OFFSET with the first page before prioritizing keyset
pagination: repeated counting may dominate both pages.

For small inputs, inspect Python profiles as well as SQL. Partition annotation
currently looks up run metadata for each contribution/context cell, even for
unpartitioned data; request-local reuse is a separate candidate from SQL work.

Source-level filtering and projection are hypotheses to test against the full
materialization pipeline. Fusing flow nodes changes which intermediate outputs
and lineage witnesses are retained, so an optimization must preserve those
contracts. A filter in a downstream node cannot be pushed through already
materialized data back into the original external read.

DuckDB's [profiling documentation](https://duckdb.org/docs/current/dev/profiling)
describes operator measurements. Its [PostgreSQL extension documentation](https://duckdb.org/docs/current/core_extensions/postgres.html)
describes scanner filtering; do not assume a source predicate executes remotely
without inspecting its plan. PostgreSQL documents [EXPLAIN's instrumentation overhead](https://www.postgresql.org/docs/16/sql-explain.html),
which is why the ordinary SELECT timings are recorded separately.
