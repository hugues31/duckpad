"""Measure bounded partition execution, including an ordered collector scan."""

import argparse
import json
import tempfile
import threading
import time
from pathlib import Path

import psutil

from duckpad.services import Services


def measure(keys, rows, home):
    instance = Services.open(home)
    peak = {"rss": 0, "duckdb": 0, "spill": 0}
    finished = threading.Event()
    try:
        instance.engine.configure_sql_resources({"threads": 1, "memory_limit": "256MiB"})
        bundle = {
            "flow": {
                "partitions": {
                    "batch": {
                        "type": "text",
                        "values": {"node": "keys", "column": "batch"},
                        "preview": {"keep": "none"},
                    }
                },
                "nodes": [
                    {"id": "keys", "template": "keys"},
                    {
                        "id": "source",
                        "template": "source",
                        "outputs": {"result": {"partition": {"by": "batch", "column": "batch"}}},
                    },
                    {"id": "collect", "template": "collect", "partitions": "all"},
                ],
                "edges": [
                    {
                        "id": "e",
                        "source": "source",
                        "sourceHandle": "result",
                        "target": "collect",
                        "targetHandle": "data",
                    }
                ],
            },
            "templates": {
                "keys": f"-- @kind source\n-- @output result\nSELECT i::VARCHAR batch FROM range({keys}) t(i) ORDER BY i;",
                "source": f"-- @kind source\n-- @output result\nSELECT p::VARCHAR batch, i, repeat(printf('%064d', i), 2) payload FROM range({keys}) p(p), range({rows}) r(i) ORDER BY i;",
                "collect": "-- @input data\n-- @output result\nSELECT * FROM {{ data }};",
            },
            "components": {},
            "documentation": {},
        }
        worktree = instance.projects.create("Partition memory benchmark", bundle)["id"]
        context = instance.engine.context(worktree, "dev", create=True)
        process = psutil.Process()

        def sample():
            cursor = context.db.cursor()
            try:
                while not finished.is_set():
                    peak["rss"] = max(peak["rss"], process.memory_info().rss)
                    memory = cursor.execute(
                        "SELECT coalesce(sum(memory_usage_bytes),0), coalesce(sum(temporary_storage_bytes),0) FROM duckdb_memory()"
                    ).fetchone()
                    peak["duckdb"] = max(peak["duckdb"], memory[0])
                    peak["spill"] = max(peak["spill"], memory[1])
                    finished.wait(0.02)
            finally:
                cursor.close()

        sampler = threading.Thread(target=sample)
        sampler.start()
        started = time.monotonic()
        try:
            run = instance.engine.launch(worktree, "dev")
            for thread in threading.enumerate():
                if thread.name == run["id"]:
                    thread.join(180)
                    assert not thread.is_alive(), "Partition benchmark timed out"
            run = instance.store.get("run", run["id"])
            assert run["status"] == "success", run
            output = context.outputs["collect"]["result"]
            assert output.disk
            actual = (
                context.db.cursor()
                .execute(f'SELECT sum(length(payload)) FROM "{output.table}"')
                .fetchone()[0]
            )
            assert actual == keys * rows * 128
            return {
                "keys": keys,
                "rows_per_key": rows,
                "payload_bytes_per_key": rows * 128,
                "threads": 1,
                "memory_limit": "256MiB",
                "peak_bytes": peak,
                "seconds": time.monotonic() - started,
            }
        finally:
            finished.set()
            sampler.join()
    finally:
        instance.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--keys", type=int, required=True)
    parser.add_argument("--rows", type=int, default=100000)
    options = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="partition-memory-") as directory:
        print(json.dumps(measure(options.keys, options.rows, Path(directory))))
