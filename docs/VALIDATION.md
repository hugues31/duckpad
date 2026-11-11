# Validation and performance

See [Contributing](../CONTRIBUTING.md#run-the-checks) for check commands. CI runs
the Python, frontend and browser suites, connector integration checks and an
installed-wheel smoke test. Reports in `validation/` record specific environments;
they are not the current CI status.

## Acceptance coverage

Lineage and native-equivalence tests cover the constructs listed in the
[lineage coverage matrix](LINEAGE.md#validated-baseline).

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

The [connectors' validated scope](CONNECTORS.md#validated-scope) summarizes the
recorded connector reports.
