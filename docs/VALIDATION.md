# Validation and performance

See [Contributing](../CONTRIBUTING.md#run-the-checks) for check commands. CI runs
the Python, frontend and browser suites, connector integration checks and an
installed-wheel smoke test. Reports in `validation/` record specific environments;
they are not the current CI status.

## Acceptance coverage

The Python suite covers authentication persistence, execution admission, immutable configuration during edits, retained multi-output results on failure, independent branches, active SQL cancellation, durable/interrupted run history, source freshness, metadata-only edits, scoped invalid definitions, external-save batching, concurrent-edit recovery, branch isolation and merging, nested component imports, documentation lifecycle, project variables, declarative connectors and lineage.

Native-equivalence tests compare values, types and multiplicities against uninstrumented DuckDB operations. Lineage tests include the extended SQL baseline, repeated values with distinct row identities, hidden grouping keys, window extrema and distinct counts, CTE/derived stages, and pagination of more than five groups and more than five identical source values.

Playwright runs against a disposable authenticated instance. Its scenarios exercise the complete example, nested navigation and lineage pagination, English/French/Portuguese and theme persistence, environment isolation, stale-preview behavior, branch/merge workflows, drag-and-drop, guided filter configuration, component grouping, recoverable conflicts across reload, and invalidation of an open explanation. Uncaught page errors are checked on the main example path. Browser diagnostics are retained on failure.

The installed-wheel smoke test (`scripts/smoke_wheel.py`, run by CI and the release workflow) runs outside the checkout, starts the CLI without Node tooling, checks bundled assets and authentication, executes the complete example, rejects a second process for the same instance, then restarts and verifies the original password and history while results remain absent.

## Performance reference

See [Scaling benchmarks](BENCHMARKS.md) for the 10K–10M matrix, PostgreSQL
comparison, cell-lineage pagination and profiling commands. These measure the
embedded engine, not browser latency or the isolated HTTP worker.

For a wider, 50-column Parquet workload, run:

```sh
uv run python scripts/benchmark.py
```

The report is written to `.duckpad-dev/benchmark-wide.json`, outside tracked files.

## Connector reports

- `validation/oracle.json`: live Oracle 19.3, OraDuck 0.4.0, exact DuckDB 2.0.0; read, transform, native export equivalence, repeated append, schema/data refresh, materialized-source lineage and secret redaction.
- `validation/s3.json`: Moto S3 endpoint on localhost, recorded by the CI job that runs `scripts/integration.py s3`; CSV/Parquet reads by relative path under a URI root, a custom storage type, join, CSV writes, repeated native replacement, connection reuse and lineage. Live AWS has not been claimed as tested.

See [connector prerequisites](CONNECTORS.md) and [the explicit SQL coverage matrix](LINEAGE.md) for the scope and limits of these checks.
