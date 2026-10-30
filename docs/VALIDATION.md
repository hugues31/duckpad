# Validation and performance

The recorded benchmark and connector checks were run on Linux x86_64 with Python 3.13.12 and DuckDB 2.0.0 against the embedded engine. Machine-readable reports in `validation/` are historical measurements, not the current CI status or validation of the isolated HTTP worker. The repository contains deterministic acceptance tests, browser scenarios and reproducible integration/performance scripts; see the [README](../README.md#develop-and-verify) for current check commands.

## Acceptance coverage

The Python suite covers authentication persistence, execution admission, immutable configuration during edits, retained multi-output results on failure, independent branches, active SQL cancellation, durable/interrupted run history, source freshness, metadata-only edits, scoped invalid definitions, external-save batching, concurrent-edit recovery, branch isolation and merging, nested component imports, documentation lifecycle, project variables, declarative connectors and lineage.

Native-equivalence tests compare values, types and multiplicities against uninstrumented DuckDB operations. Lineage tests include the extended SQL baseline, repeated values with distinct row identities, hidden grouping keys, window extrema and distinct counts, CTE/derived stages, and pagination of more than five groups and more than five identical source values.

Playwright runs against a disposable authenticated instance. Its scenarios exercise the complete example, nested navigation and lineage pagination, French/English and theme persistence, environment isolation, stale-preview behavior, branch/merge workflows, drag-and-drop, guided filter configuration, component grouping, recoverable conflicts across reload, and invalidation of an open explanation. Uncaught page errors are checked on the main example path. Browser diagnostics are retained on failure.

The installed-wheel smoke test (`scripts/smoke_wheel.py`, run by CI and the release workflow) runs outside the checkout, starts the CLI without Node tooling, checks bundled assets and authentication, executes the complete example, rejects a second process for the same instance, then restarts and verifies the original password and history while results remain absent.

## Performance reference

Run:

```sh
uv run python scripts/benchmark.py --output docs/validation/benchmark.json
```

The input is **1,000,000 rows and 50 columns** in Parquet: BIGINT/INTEGER identifiers, DECIMAL amounts, ten DOUBLE metrics, five BOOLEAN flags, five DATE fields, ten 16-character VARCHAR fields, ten INTEGER counters and seven TIMESTAMP fields. The report includes the full schema.

There are 10,000 customer keys with 100 fact rows per key. A CSV dimension has 12,000 rows: keys 0–1999 have two matching records and the remaining keys have one. The join produces 1.2 million rows across eight regions. The flow reads both inputs, performs the join, groups SUM/AVG/COUNT/COUNT DISTINCT, and exports CSV. An independent native query validates the resulting values.

Recorded hardware: Intel Core i5-1340P, 16 logical CPUs, approximately 15.3 GiB available system RAM; Linux 7.2.9, DuckDB 2.0.0 with core_functions/parquet 2.0.0.

| Measurement | Recorded elapsed time |
| --- | ---: |
| Full pipeline, including source reads | 0.583 s |
| First 100 source rows in preview | 0.035 s |
| Aggregate preview | 0.0024 s |
| First five lineage contributions plus exact count | 0.066 s |
| Next five contributions | 0.063 s |

The selected aggregate has **150,000 contributing cells**. Peak worker-process resident memory was **1,482,492 KiB (about 1.41 GiB)**. This peak includes materialization, lineage and independent native comparison in the worker; source-fixture generation occurs separately. Results are a local measurement, not a latency guarantee. Filesystem caches, CPU contention, data distributions, query shape and extension behavior can change timings. There is no application-enforced dataset-size limit or implicit query timeout.

## Connector reports

- `validation/oracle.json`: live Oracle 19.3, OraDuck 0.4.0, exact DuckDB 2.0.0; read, transform, native export equivalence, repeated append, schema/data refresh, materialized-source lineage and secret redaction.
- `validation/s3.json`: local Moto S3 endpoint; CSV/Parquet reads, join, CSV writes, repeated native replacement, connection reuse and lineage. Live AWS has not been claimed as tested.

See [connector prerequisites](CONNECTORS.md) and [the explicit SQL coverage matrix](LINEAGE.md) for the scope and limits of these checks. The completed scheduling comparison is summarized in the [architecture guide](ARCHITECTURE.md#scheduling-decision).
