"""Reproducible million-row / fifty-column Duckpad performance reference."""

import argparse
import json
import os
import platform
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import duckdb

from duckpad.catalog import Catalog
from duckpad.engine import Engine
from duckpad.lineage import Lineage
from duckpad.projects import Projects
from duckpad.store import Store
from duckpad.templates import BUILTINS
from duckpad.util import dumps, literal


def generate(folder, rows):
    db = duckdb.connect()
    columns = [
        "i::BIGINT AS id",
        "(i % 10000)::INTEGER AS customer_id",
        "((i % 100000) / 100)::DECIMAL(14,2) AS amount",
    ]
    columns += [f"(i * {k + 1} / 7.0)::DOUBLE AS metric_{k}" for k in range(10)]
    columns += [f"(i % {k + 2} = 0) AS flag_{k}" for k in range(5)]
    columns += [f"DATE '2025-01-01' + ((i + {k}) % 365)::INTEGER AS event_{k}" for k in range(5)]
    columns += [f"lpad(((i + {k}) % 100000)::VARCHAR, 16, '0') AS code_{k}" for k in range(10)]
    columns += [f"((i + {k}) % 1000)::INTEGER AS count_{k}" for k in range(10)]
    columns += [f"TIMESTAMP '2025-01-01' + (i + {k}) * INTERVAL '1 second' AS time_{k}" for k in range(7)]
    assert len(columns) == 50
    db.execute(
        f"COPY (SELECT {', '.join(columns)} FROM range({rows}) t(i)) TO {literal(str(folder / 'facts.parquet'))} (FORMAT PARQUET)"
    )
    db.execute(
        f"COPY (SELECT (i % 10000)::INTEGER AS customer_id, 'Region ' || ((i % 10000) % 8)::VARCHAR AS region FROM range(12000) t(i)) TO {literal(str(folder / 'customers.csv'))} (HEADER)"
    )
    schema = db.execute(
        f"DESCRIBE SELECT * FROM read_parquet({literal(str(folder / 'facts.parquet'))})"
    ).fetchall()
    db.close()
    return [{"name": row[0], "type": row[1]} for row in schema]


def worker(folder):
    store = Store(folder / "instance")
    projects, catalog = Projects(store), Catalog(store)
    engine = Engine(store, projects, catalog)
    nodes = [
        {"id": "facts", "template": "load_parquet", "params": {"file": str(folder / "facts.parquet")}},
        {"id": "customers", "template": "load_csv", "params": {"file": str(folder / "customers.csv")}},
        {
            "id": "joined",
            "template": "join",
            "params": {"condition": "l.customer_id = r.customer_id", "columns": "l.*, r.region"},
        },
        {
            "id": "totals",
            "template": "aggregate",
            "params": {
                "groups": "region",
                "measures": "SUM(amount) AS revenue, AVG(amount) AS average_amount, COUNT(*) AS rows, COUNT(DISTINCT customer_id) AS customers",
            },
        },
        {"id": "export", "template": "export_csv", "params": {"destination": str(folder / "totals.csv")}},
    ]
    edges = [
        {"id": str(i), "source": source, "sourceHandle": "result", "target": target, "targetHandle": port}
        for i, (source, target, port) in enumerate(
            [
                ("facts", "joined", "left"),
                ("customers", "joined", "right"),
                ("joined", "totals", "source"),
                ("totals", "export", "source"),
            ]
        )
    ]
    worktree = projects.create(
        "Performance reference",
        {
            "flow": {"nodes": nodes, "edges": edges},
            "templates": dict(BUILTINS),
            "components": {},
            "documentation": {},
        },
    )["id"]
    try:
        start = time.perf_counter()
        run = engine.launch(worktree, "dev")
        while engine.active:
            time.sleep(0.005)
        pipeline_seconds = time.perf_counter() - start
        result = store.get("run", run["id"])
        assert result["status"] == "success", {
            k: v.get("error") for k, v in result["nodes"].items() if v.get("error")
        }
        start = time.perf_counter()
        source_preview = engine.preview(worktree, "dev", "facts")
        source_preview_seconds = time.perf_counter() - start
        start = time.perf_counter()
        preview = engine.preview(worktree, "dev", "totals")
        preview_seconds = time.perf_counter() - start
        start = time.perf_counter()
        explanation = Lineage(engine).explain(
            worktree, "dev", preview["id"], preview["rows"][0]["id"], "revenue"
        )
        lineage_seconds = time.perf_counter() - start
        assert explanation["complete"], explanation
        assert len(explanation["contributions"]) == 5 and explanation["total"] > 5
        start = time.perf_counter()
        second = Lineage(engine).explain(
            worktree, "dev", preview["id"], preview["rows"][0]["id"], "revenue", offset=5
        )
        second_page_seconds = time.perf_counter() - start
        assert second["total"] == explanation["total"]
        # Independently execute native SQL against the original fixtures.
        native = duckdb.connect()
        expected = native.execute(
            f"SELECT region, SUM(amount), AVG(amount), COUNT(*), COUNT(DISTINCT f.customer_id) FROM read_parquet({literal(str(folder / 'facts.parquet'))}) f JOIN read_csv({literal(str(folder / 'customers.csv'))}) c USING (customer_id) GROUP BY region ORDER BY region"
        ).fetchall()
        native.close()
        observed = sorted([row["values"] for row in preview["rows"]])
        assert [row[0] for row in observed] == [row[0] for row in expected]
        for a, b in zip(observed, expected, strict=True):
            assert str(a[1]) == str(b[1]) and a[3:] == list(b[3:])
        return {
            "duckdb": duckdb.__version__,
            "python": platform.python_version(),
            "platform": platform.platform(),
            "cpu": next(
                (
                    line.split(":", 1)[1].strip()
                    for line in Path("/proc/cpuinfo").read_text().splitlines()
                    if line.startswith("model name")
                ),
                platform.processor(),
            ),
            "logical_cpus": os.cpu_count(),
            "memory_total_kib": int(
                next(
                    line.split()[1]
                    for line in Path("/proc/meminfo").read_text().splitlines()
                    if line.startswith("MemTotal")
                )
            ),
            "input_rows": source_preview["count"],
            "input_columns": len(source_preview["columns"]),
            "pipeline_seconds_including_source_reads": pipeline_seconds,
            "source_preview_100_rows_seconds": source_preview_seconds,
            "aggregate_preview_seconds": preview_seconds,
            "lineage_first_five_and_exact_count_seconds": lineage_seconds,
            "lineage_next_five_seconds": second_page_seconds,
            "lineage_total_contributions": explanation["total"],
            "peak_process_memory_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "native_value_comparison": "passed",
            "node_seconds": {k: v.get("duration") for k, v in result["nodes"].items()},
            "flow": "Read 50-column Parquet facts and CSV dimension; one-to-many join; grouped SUM, AVG, COUNT and COUNT DISTINCT; CSV export",
            "distribution": "10,000 customer keys; uniform fact multiplicity (100 at 1M rows); dimension contains 12,000 rows, with two matches for keys 0..1999 and one for remaining keys; 8 regions; 16-character numeric strings; amounts in 0.00..999.99",
            "extensions": ["core_functions 2.0.0", "parquet 2.0.0"],
        }
    finally:
        engine.close()
        store.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=1_000_000)
    parser.add_argument("--output", type=Path, default=Path("docs/validation/benchmark.json"))
    parser.add_argument("--worker", type=Path)
    args = parser.parse_args()
    if args.worker:
        print(dumps(worker(args.worker)))
    else:
        with tempfile.TemporaryDirectory(prefix="duckpad-benchmark-") as directory:
            folder = Path(directory)
            schema = generate(folder, args.rows)
            completed = subprocess.run(
                [sys.executable, __file__, "--worker", str(folder)],
                capture_output=True,
                text=True,
                check=True,
            )
            result = json.loads(completed.stdout)
            result["schema"] = schema
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(dumps(result))
            print(dumps({key: value for key, value in result.items() if key != "schema"}))
