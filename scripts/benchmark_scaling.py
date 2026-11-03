"""Opt-in scaling and cell-lineage benchmark; see docs/BENCHMARKS.md."""

import argparse
import cProfile
import json
import os
import platform
import pstats
import resource
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import duckdb
import psutil

from duckpad.builtin_templates import BUILTINS
from duckpad.services import Services
from duckpad.trace import TraceQuery
from duckpad.util import dumps, literal

SIZES = [10_000, 100_000, 1_000_000, 10_000_000]
MEASURES = "SUM(amount) AS revenue, COUNT(amount) AS nonnull, COUNT(*) AS n, COUNT(DISTINCT customer_id) AS customers"
FACTS = """SELECT i::BIGINT AS id, (i % 10000)::INTEGER AS customer_id,
    CASE WHEN i % 97 = 0 THEN NULL ELSE (i % 100000)::BIGINT END AS amount,
    (i % 5)::INTEGER AS category, (i % 2 = 0) AS active,
    DATE '2025-01-01' + (i % 365)::INTEGER AS event_date,
    lpad((i % 100000)::VARCHAR, 16, '0') AS code,
    (i % 1000)::INTEGER AS quantity FROM {series} t(i)"""
CUSTOMERS = """SELECT (i % 10000)::INTEGER AS customer_id,
    'Region ' || ((i % 10000) % 8)::VARCHAR AS region FROM {series} t(i)"""


def timed(operation):
    started = time.perf_counter()
    result = operation()
    return time.perf_counter() - started, result


def aggregate(facts, customers):
    return (
        f"SELECT region, {MEASURES} FROM {facts} f JOIN {customers} c USING (customer_id) "
        "GROUP BY region ORDER BY region"
    )


def fixtures(folder, rows, config):
    with duckdb.connect(config=config) as db:
        for name, sql in (
            ("facts", FACTS.format(series=f"range({rows})")),
            ("customers", CUSTOMERS.format(series="range(12000)")),
        ):
            db.execute(f"COPY ({sql}) TO {literal(str(folder / (name + '.parquet')))} (FORMAT PARQUET)")
        return db.execute(
            f"DESCRIBE SELECT * FROM read_parquet({literal(str(folder / 'facts.parquet'))})"
        ).fetchall()


def postgres_connect():
    # Optional benchmark-only dependency; the DSN never becomes a command argument or report field.
    import psycopg

    return psycopg.connect(os.environ["DUCKPAD_BENCHMARK_POSTGRES_DSN"], autocommit=True)


@contextmanager
def postgres_fixture(rows, enabled, timeout):
    if not enabled:
        yield None
        return
    schema = "benchmark_" + uuid.uuid4().hex
    with postgres_connect() as db:
        db.execute(f"SET statement_timeout = {timeout * 1000}")
        db.execute(f"CREATE SCHEMA {schema}")
        try:
            db.execute(f"SET search_path = {schema}")
            db.execute(f"CREATE TABLE facts AS {FACTS.format(series=f'generate_series(0, {rows - 1})')}")
            db.execute(f"CREATE TABLE customers AS {CUSTOMERS.format(series='generate_series(0, 11999)')}")
            db.execute("ANALYZE facts")
            db.execute("ANALYZE customers")
            yield schema
        finally:
            db.execute(f"DROP SCHEMA {schema} CASCADE")


def bundle(folder, rows, source, schema):
    nodes = []
    for name in ("facts", "customers"):
        params = (
            {"file": str(folder / (name + ".parquet"))}
            if source == "parquet"
            else {"connection": "benchmark", "schema": schema, "table": name}
        )
        nodes.append(
            {
                "id": name,
                "template": "load_parquet" if source == "parquet" else "load_table",
                "params": params,
            }
        )
    nodes += [
        {
            "id": "joined",
            "template": "join",
            "params": {"columns": "l.*, r.region", "condition": "l.customer_id = r.customer_id"},
        },
        {"id": "totals", "template": "aggregate", "params": {"groups": "region", "measures": MEASURES}},
        {"id": "selected", "template": "selected"},
    ]
    links = [
        ("facts", "joined", "left"),
        ("customers", "joined", "right"),
        ("joined", "totals", "source"),
        ("facts", "selected", "source"),
    ]
    return {
        "flow": {
            "nodes": nodes,
            "edges": [
                {"id": str(i), "source": start, "sourceHandle": "result", "target": end, "targetHandle": port}
                for i, (start, end, port) in enumerate(links)
            ],
        },
        "templates": {
            **BUILTINS,
            "selected": f"-- @input source\n-- @output result\nSELECT SUM(amount) AS revenue FROM {{{{ source }}}} WHERE id < {rows // 100};",
        },
        "components": {},
        "documentation": {},
    }


def operators(profile):
    """Keep numerical plan evidence without generated names, SQL, paths or connection details."""
    found = []

    def visit(node):
        kind = node.get("type", node.get("operator_type"))
        if kind:
            found.append(
                {
                    "operator": kind,
                    "seconds": node.get("timing", node.get("operator_timing", 0)),
                    "rows": node.get("intermediate_rows", node.get("operator_cardinality", 0)),
                }
            )
        for child in node.get("children", node.get("operator", [])):
            visit(child)

    visit(profile)
    return sorted(found, key=lambda item: item["seconds"], reverse=True)


def sql_profile(db, sql):
    return operators(json.loads(db.execute("EXPLAIN (ANALYZE, FORMAT JSON) " + sql).fetchone()[1]))


def lineage_profiles(engine, worktree, dataset_id, row):
    context = engine.context(worktree, "dev")
    data = context.datasets[dataset_id]
    with context.db.cursor() as cursor:
        tracer = TraceQuery(context, cursor, data, row)
        contribution, selection, _ = tracer.trace(tracer.normalize(data), 1)
        profiles = {}
        for name, query in (("contributions", contribution), ("context", selection)):
            distinct = f"SELECT DISTINCT * FROM ({query}) q"
            profiles[name + "_count"] = sql_profile(cursor, f"SELECT count(*) FROM ({distinct}) q")
            profiles[name + "_page"] = sql_profile(
                cursor, distinct + " ORDER BY dataset, row_id, column_name LIMIT 5"
            )
        return profiles


def python_profile(operation):
    profiler = cProfile.Profile()
    profiler.runcall(operation)
    stats = pstats.Stats(profiler)
    records = []
    for (filename, line, function), (_, calls, own, cumulative, _) in stats.stats.items():
        # Only application frames; absolute runtime paths never enter the report.
        normalized = filename.replace("\\", "/")
        if "/duckpad/" in normalized:
            records.append(
                {
                    "function": "duckpad/" + normalized.split("/duckpad/", 1)[1] + f":{line}:{function}",
                    "calls": calls,
                    "own_seconds": own,
                    "cumulative_seconds": cumulative,
                }
            )
    return sorted(records, key=lambda item: item["cumulative_seconds"], reverse=True)[:15]


def assert_rows(actual, expected):
    # All measures are integral, including SUM: compare exactly, including NULLs and duplicates.
    assert sorted(tuple(row) for row in actual) == sorted(tuple(row) for row in expected)


def native(folder, rows, config, source, schema, timeout, profile):
    measurements = {}
    facts = f"read_parquet({literal(str(folder / 'facts.parquet'))})"
    customers = f"read_parquet({literal(str(folder / 'customers.parquet'))})"
    with duckdb.connect(config=config) as db:
        query = aggregate(facts, customers)
        measurements["duckdb_fused_seconds"], expected = timed(lambda: db.execute(query).fetchall())
        selected = f"SELECT SUM(amount) FROM {facts} WHERE id < {rows // 100}"
        measurements["duckdb_filter_at_source_seconds"], selected_expected = timed(
            lambda: db.execute(selected).fetchall()
        )

        def staged():
            db.execute(f"CREATE TABLE facts AS SELECT * FROM {facts}")
            db.execute(f"CREATE TABLE customers AS SELECT * FROM {customers}")
            db.execute(
                "CREATE TABLE joined AS SELECT f.*, c.region FROM facts f JOIN customers c USING (customer_id)"
            )
            db.execute(f"CREATE TABLE totals AS SELECT region, {MEASURES} FROM joined GROUP BY region")
            db.execute(f"CREATE TABLE selected AS SELECT SUM(amount) FROM facts WHERE id < {rows // 100}")

        measurements["duckdb_staged_seconds"], _ = timed(staged)
        assert_rows(db.execute("SELECT * FROM totals").fetchall(), expected)
        assert_rows(db.execute("SELECT * FROM selected").fetchall(), selected_expected)
        plans = {"duckdb_filter_at_source": sql_profile(db, selected)} if profile else {}
    postgres = None
    if source == "postgres":
        with postgres_connect() as db:
            db.execute(f"SET statement_timeout = {timeout * 1000}")
            db.execute(f"SET search_path = {schema}")
            # One backend, no parallel workers: comparable to the default one-thread DuckDB run.
            db.execute("SET max_parallel_workers_per_gather = 0")
            db.execute("SET work_mem = '64MB'")
            db.execute("SET jit = off")
            query = aggregate("facts", "customers")
            measurements["postgres_fused_seconds"], pg_rows = timed(lambda: db.execute(query).fetchall())
            assert_rows(pg_rows, expected)
            measurements["postgres_filter_at_source_seconds"], pg_selected = timed(
                lambda: db.execute(f"SELECT SUM(amount) FROM facts WHERE id < {rows // 100}").fetchall()
            )
            assert_rows(pg_selected, selected_expected)
            postgres = {
                "version": db.execute("SHOW server_version").fetchone()[0],
                "settings": {
                    key: db.execute("SHOW " + key).fetchone()[0]
                    for key in ("shared_buffers", "work_mem", "max_parallel_workers_per_gather", "jit")
                },
            }
            if profile:
                plan = db.execute("EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) " + query).fetchone()[
                    0
                ][0]

                # No schema, query text, or connection settings in the saved plan.
                def trim(node):
                    keep = {
                        key: value
                        for key, value in node.items()
                        if key
                        in {
                            "Node Type",
                            "Actual Rows",
                            "Actual Loops",
                            "Shared Hit Blocks",
                            "Shared Read Blocks",
                            "Temp Read Blocks",
                            "Temp Written Blocks",
                            "Sort Method",
                            "Sort Space Used",
                            "Sort Space Type",
                        }
                    }
                    keep["Plans"] = [trim(child) for child in node.get("Plans", [])]
                    return keep

                plans["postgres_fused"] = {"execution_ms": plan["Execution Time"], "plan": trim(plan["Plan"])}
    return measurements, expected, selected_expected, plans, postgres


def worker(args):
    config = {"threads": args.threads, "memory_limit": args.memory_limit}
    # Independent native baselines run first, then close before Duckpad starts.
    timings, expected, selected_expected, profiles, postgres = native(
        args.worker, args.rows[0], config, args.source, args.schema, args.timeout, args.profile
    )
    instance = Services.open(args.worker / ("instance-" + uuid.uuid4().hex))
    engine = instance.engine
    engine.configure_sql_resources(config)
    try:
        if args.source == "postgres":
            with postgres_connect() as db:
                params = db.info.get_parameters()
                params["password"] = db.info.password
            connection = {key: params[key] for key in ("host", "port", "user", "password") if key in params}
            connection["port"] = int(params.get("port", "5432"))
            connection["database"] = params["dbname"]
            # Preserve explicit libpq TLS settings without recording them in the report.
            from psycopg.conninfo import make_conninfo

            connection["options"] = make_conninfo(
                **{
                    key: value
                    for key, value in params.items()
                    if key not in {"host", "port", "user", "password", "dbname"}
                }
            )
            instance.catalog.save(
                "connection",
                {
                    "id": "benchmark",
                    "name": "Benchmark",
                    "connector": "postgres",
                    "environments": {"dev": connection},
                },
                create=True,
            )
        worktree = instance.projects.create(
            "Scaling benchmark", bundle(args.worker, args.rows[0], args.source, args.schema)
        )["id"]
        started = time.perf_counter()
        run = engine.launch(worktree, "dev")
        for thread in threading.enumerate():
            if thread.name == run["id"]:
                thread.join(args.timeout)
                assert not thread.is_alive(), "Pipeline timed out"
        result = instance.store.get("run", run["id"])
        timings["pipeline_seconds"] = time.perf_counter() - started
        assert result["status"] == "success", {
            key: value.get("error") for key, value in result["nodes"].items() if value.get("error")
        }
        timings["preview_seconds"], preview = timed(lambda: engine.preview(worktree, "dev", "totals"))
        assert_rows([row["values"] for row in preview["rows"]], expected)
        assert_rows(
            [row["values"] for row in engine.preview(worktree, "dev", "selected")["rows"]], selected_expected
        )
        assert engine.preview(worktree, "dev", "facts")["count"] == args.rows[0]
        assert engine.preview(worktree, "dev", "joined")["count"] == args.rows[0] * 6 // 5
        region = next(row for row in preview["rows"] if row["values"][0] == "Region 0")

        def explain(**kw):
            return instance.lineage.explain(worktree, "dev", preview["id"], region["id"], "revenue", **kw)

        timings["lineage_first_seconds"], first = timed(explain)
        total = region["values"][2]
        assert first["complete"] and first["total"] == total and len(first["contributions"]) == 5
        first_ids = {cell["row"] for cell in first["contributions"]}
        for name, offset in (("next", 5), ("last", total - 5)):
            timings[f"lineage_{name}_seconds"], page = timed(lambda offset=offset: explain(offset=offset))
            assert page["complete"] and page["total"] == total and len(page["contributions"]) == 5
            assert first_ids.isdisjoint(cell["row"] for cell in page["contributions"])
            assert all(cell["value"] is not None for cell in page["contributions"])

        def drill():
            for contribution in first["contributions"]:
                item = instance.lineage.explain(
                    worktree, "dev", contribution["dataset"], contribution["row"], contribution["column"]
                )
                assert item["complete"] and item["total"] == 1
                leaf = item["contributions"][0]
                source = instance.lineage.explain(
                    worktree, "dev", leaf["dataset"], leaf["row"], leaf["column"]
                )
                assert source["complete"] and source["kind"] == "source"
                assert source["value"] == contribution["value"]

        timings["lineage_drill_five_seconds"], _ = timed(drill)
        timings["lineage_distinct_seconds"], distinct = timed(
            lambda: instance.lineage.explain(worktree, "dev", preview["id"], region["id"], "customers")
        )
        assert distinct["complete"] and distinct["total"] == region["values"][4]
        group = distinct["groups"][0]
        timings["lineage_distinct_group_seconds"], grouped = timed(
            lambda: instance.lineage.explain(
                worktree, "dev", preview["id"], region["id"], "customers", group=group["key"]
            )
        )
        assert grouped["complete"] and grouped["total"] == group["rows"]
        if args.profile:
            profiles["lineage_sql"] = lineage_profiles(engine, worktree, preview["id"], region["id"])
            profiles["lineage_python"] = python_profile(explain)
        return {
            "timings": timings,
            "node_seconds": {key: value["duration"] for key, value in result["nodes"].items()},
            "lineage_contributions": total,
            "correctness": "passed",
            "peak_process_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "postgres": postgres,
            "profiles": profiles,
        }
    finally:
        instance.close()


def summarize(samples):
    return {
        key: {"min": min(values), "median": statistics.median(values), "max": max(values)}
        for key in samples[0]["timings"]
        if (values := [sample["timings"][key] for sample in samples])
    }


def positive(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("Expected a positive integer")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=positive, nargs="+", default=SIZES)
    parser.add_argument("--repeats", type=positive, default=3)
    parser.add_argument("--threads", type=positive, default=1)
    parser.add_argument("--memory-limit", default="2GiB")
    parser.add_argument("--timeout", type=positive, default=600, help="Per worker deadline in seconds")
    parser.add_argument(
        "--postgres", action="store_true", help="Also use the DSN from DUCKPAD_BENCHMARK_POSTGRES_DSN"
    )
    parser.add_argument("--output", type=Path, default=Path(".duckpad-dev/benchmark-scaling.json"))
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    parser.add_argument(
        "--source", choices=["parquet", "postgres"], default="parquet", help=argparse.SUPPRESS
    )
    parser.add_argument("--schema", help=argparse.SUPPRESS)
    parser.add_argument("--profile", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if any(rows < 10000 or rows % 10000 for rows in args.rows):
        parser.error("Row counts must be multiples of 10,000 (at least 10,000)")
    if args.worker:
        print(dumps(worker(args)))
        return
    if args.postgres and not os.environ.get("DUCKPAD_BENCHMARK_POSTGRES_DSN"):
        parser.error("Set DUCKPAD_BENCHMARK_POSTGRES_DSN privately before using --postgres")
    report = {
        "format_version": 1,
        "status": "running",
        "started_at": datetime.now(UTC).isoformat(),
        "mode": "embedded Services, fresh process per sample",
        "duckdb": duckdb.__version__,
        "python": platform.python_version(),
        "system": platform.system(),
        "cpu": next(
            (
                line.split(":", 1)[1].strip()
                for line in Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith("model name")
            ),
            platform.processor(),
        ),
        "logical_cpus": os.cpu_count(),
        "system_memory_bytes": psutil.virtual_memory().total,
        "threads": args.threads,
        "memory_limit": args.memory_limit,
        "repeats": args.repeats,
        "cache_policy": "OS and PostgreSQL caches are not flushed; first process is not a cold disk measurement",
        "postgres_enabled": args.postgres,
        "results": [],
    }
    with tempfile.TemporaryDirectory(prefix="duckpad-scaling-") as directory:
        for rows in args.rows:
            folder = Path(directory) / str(rows)
            folder.mkdir()
            seconds, schema = timed(
                lambda folder=folder, rows=rows: fixtures(
                    folder, rows, {"threads": args.threads, "memory_limit": args.memory_limit}
                )
            )
            report["schema"] = [{"name": column[0], "type": column[1]} for column in schema]
            with postgres_fixture(rows, args.postgres, args.timeout) as pg_schema:
                for source in ["parquet", "postgres"] if args.postgres else ["parquet"]:
                    samples = []
                    for repetition in range(args.repeats):
                        command = [
                            sys.executable,
                            __file__,
                            "--worker",
                            str(folder),
                            "--rows",
                            str(rows),
                            "--source",
                            source,
                            "--threads",
                            str(args.threads),
                            "--memory-limit",
                            args.memory_limit,
                            "--timeout",
                            str(args.timeout),
                        ]
                        if pg_schema:
                            command += ["--schema", pg_schema]
                        if repetition == args.repeats - 1:
                            command += ["--profile"]
                        completed = subprocess.run(
                            command, capture_output=True, text=True, timeout=args.timeout, check=False
                        )
                        if completed.returncode:
                            args.output.parent.mkdir(parents=True, exist_ok=True)
                            args.output.with_suffix(".error.log").write_text(completed.stderr)
                            raise SystemExit(
                                "Benchmark worker failed; see the private .error.log beside the output. Do not publish raw logs."
                            )
                        samples.append(json.loads(completed.stdout))
                        print(f"{rows:,} rows / {source} / sample {repetition + 1}: passed", flush=True)
                    report["results"].append(
                        {
                            "rows": rows,
                            "source": source,
                            "fixture_seconds": seconds,
                            "samples": samples,
                            "seconds": summarize(samples),
                        }
                    )
                    args.output.parent.mkdir(parents=True, exist_ok=True)
                    args.output.write_text(dumps(report))
            # Release this size's instance stores and fixtures before generating the next size.
            shutil.rmtree(folder)
    report["status"] = "passed"
    args.output.write_text(dumps(report))


if __name__ == "__main__":
    main()
