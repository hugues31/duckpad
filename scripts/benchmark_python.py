"""Bounded-memory SQL/Python/SQL reference; no table is collected in the API process."""

import argparse
import json
import tempfile
import time
from pathlib import Path

import psutil

from duckpad.bundle import bundle_to_files
from duckpad.execution.runs import UNFINISHED_RUN_STATUSES
from duckpad.services import Services


def benchmark(rows):
    with tempfile.TemporaryDirectory() as folder:
        instance = Services.open(Path(folder), enforce_access=False)
        try:
            projects, engine, store = instance.projects, instance.engine, instance.store
            worktree = projects.create("Python performance")
            store.put("settings", "python:" + worktree["project"], {"enabled": True})
            snapshot = projects.snapshot(worktree["id"])
            bundle = snapshot["bundle"]
            bundle["flow"].update(
                nodes=[
                    {"id": "source", "template": "source"},
                    {"id": "python", "language": "python"},
                    {"id": "total", "template": "total"},
                ],
                edges=[
                    {
                        "id": key,
                        "source": source,
                        "sourceHandle": "result",
                        "target": target,
                        "targetHandle": "source",
                    }
                    for key, source, target in [("a", "source", "python"), ("b", "python", "total")]
                ],
            )
            bundle["templates"].update(
                source=f"-- @output result\nSELECT i AS id, (i % 100)::INTEGER category, (i / 100)::DECIMAL(18,2) amount FROM range({rows}) t(i)",
                total="-- @input source\n-- @output result\nSELECT count(*) AS records, sum(amount) AS total FROM {{ source }}",
            )
            bundle["node_sql"] = {
                "nodes/python.py": "import duckpad as dp\nclass Filter(dp.Node):\n    def run(self, source: dp.Relation) -> dp.Relation:\n        return source.filter('category < 50')\n"
            }
            projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
            context = engine.context(worktree["id"], "dev", create=True)
            api, worker = psutil.Process(), psutil.Process(context.db.process.pid)
            baseline = api.memory_info().rss + worker.memory_info().rss
            peak = baseline
            started = time.monotonic()
            run = engine.launch(worktree["id"], "dev")
            while store.get("run", run["id"])["status"] in UNFINISHED_RUN_STATUSES:
                peak = max(peak, api.memory_info().rss + worker.memory_info().rss)
                if time.monotonic() - started > 120:
                    engine.cancel(run["id"])
                    raise RuntimeError("Benchmark exceeded 120 seconds")
                time.sleep(0.02)
            elapsed = time.monotonic() - started
            result = store.get("run", run["id"])
            assert result["status"] == "success", result["nodes"]
            output = context.outputs["total"]["result"]
            observed = context.db.execute(f'SELECT records FROM "{output.table}"').fetchone()[0]
            expected = (rows // 100) * 50 + min(rows % 100, 50)
            assert observed == expected
            report = {
                "rows": rows,
                "output_rows": observed,
                "seconds": round(elapsed, 3),
                "incremental_rss_mib": round((peak - baseline) / 1024**2, 1),
                "peak_combined_rss_mib": round(peak / 1024**2, 1),
                "budget_seconds": 30,
                "budget_incremental_rss_mib": 512,
            }
            print(json.dumps(report, indent=2))
            assert elapsed < 30 and peak - baseline < 512 * 1024**2, "Reference budget exceeded"
        finally:
            instance.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=1_000_000)
    arguments = parser.parse_args()
    if arguments.rows < 1:
        parser.error("--rows must be positive")
    benchmark(arguments.rows)
