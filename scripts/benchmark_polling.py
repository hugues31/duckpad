"""Measure HTTP polling on disposable synthetic data, including a 1,000-key preview.

Run with the development environment. PYTHONPATH can point at another revision's
src directory to compare the same fixture and interpreter against a baseline.
"""

import argparse
import copy
import json
import statistics
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from duckpad import partitions
from duckpad.app import create_app
from duckpad.bundle import bundle_to_files
from duckpad.git import command
from duckpad.partition_storage import PartitionStorage
from duckpad.util import now, uid


def measure(client, path, repeats):
    response = client.get(path)
    response.raise_for_status()
    times, processes = [], []
    for _ in range(repeats):
        with patch.object(command, "run", wraps=command.run) as git:
            start = time.perf_counter()
            response = client.get(path)
            response.raise_for_status()
            times.append((time.perf_counter() - start) * 1000)
            processes.append(git.call_count)
    return {
        "median_ms": round(statistics.median(times), 2),
        "bytes": len(response.content),
        "git_processes": statistics.median(processes),
    }


def fixture():
    return {
        "flow": {
            "partitions": {
                "batch": {
                    "type": "text",
                    "values": {"node": "keys", "column": "batch"},
                    "preview": {"keep": "all"},
                }
            },
            "nodes": [
                {"id": "keys", "template": "keys"},
                {
                    "id": "source",
                    "template": "source",
                    "outputs": {"result": {"partition": {"by": "batch", "column": "batch"}}},
                },
            ],
            "edges": [],
        },
        "templates": {
            "keys": "-- @output result\nSELECT 'a' batch UNION ALL SELECT 'b';",
            "source": "-- @output result\nSELECT 'a' batch, 1 amount UNION ALL SELECT 'b', 2;",
            "ordinary": "-- @output result\nSELECT 1 AS amount;",
        },
        "components": {},
        "documentation": {},
    }


def benchmark(repeats, keys):
    with tempfile.TemporaryDirectory(prefix="duckpad-polling-") as directory:
        app = create_app(Path(directory), watch=False, trusted_local=True)
        with TestClient(app) as client:
            client.post("/api/login", json={"password": app.state.auth.initial_password}).raise_for_status()
            services = app.state.services
            store, projects, engine = services.store, services.projects, services.engine
            example = client.post("/api/example").json()
            report = {"example_snapshot": measure(client, f"/api/worktrees/{example['id']}", repeats)}
            tree = projects.create("Polling benchmark", fixture())
            run = engine.launch(tree["id"], "dev")
            for thread in threading.enumerate():
                if thread.name == run["id"]:
                    thread.join(120)
                    if thread.is_alive():
                        raise RuntimeError("Benchmark fixture execution timed out")
            run = store.get("run", run["id"])
            if run["status"] != "success":
                raise RuntimeError("Benchmark fixture execution failed")
            snapshot = projects.snapshot(tree["id"])
            project = snapshot["bundle"]
            project["flow"]["nodes"].extend(
                {"id": f"ordinary_{i}", "template": "ordinary"} for i in range(103)
            )
            projects.write(tree["id"], snapshot["revision"], bundle_to_files(project))
            report["snapshot_105_nodes"] = measure(client, f"/api/worktrees/{tree['id']}", repeats)
            for index in range(9):
                projects.branch(tree["id"], f"branch-{index}")
            report["branches_10"] = measure(client, f"/api/worktrees/{tree['id']}/git/branches", repeats)
            for index in range(10):
                response = client.post(
                    f"/api/projects/{tree['project']}/jobs",
                    json={
                        "slug": f"benchmark-{index}",
                        "name": f"Benchmark {index}",
                        "environment": "dev",
                        "target": {"kind": "branch", "ref": "main"},
                    },
                )
                response.raise_for_status()
                job = response.json()
                for number in range(50):
                    identity = f"run_{index:02}_{number:03}"
                    store.put(
                        "run",
                        identity,
                        {
                            **run,
                            "id": identity,
                            "worktree": job["worktree"],
                            "flow": project["flow"],
                            "definitions": project["templates"],
                            "node_sql": {
                                f"nodes/ordinary_{i}.sql": "-- A representative SQL definition\nSELECT 1 AS amount;\n"
                                * 20
                                for i in range(103)
                            },
                        },
                    )
            report["jobs_10"] = measure(client, f"/api/projects/{tree['project']}/jobs", repeats)
            report["job_runs_50"] = measure(client, "/api/jobs/benchmark-0/runs", repeats)
            storage = PartitionStorage(store, tree["id"], "dev")
            metadata = storage.manifest(identity=run["partitions"]["manifest"])
            entries = storage.entries(metadata["id"])
            # Only the selected key needs a retained result. The other synthetic keys
            # exercise validity computation without timing 1,000 SQL executions.
            for ordinal in range(len(entries), keys):
                entry = copy.deepcopy(entries[0])
                entry["key"]["value"] = f"key-{ordinal}"
                entry.update(
                    ordinal=ordinal, partition_id=uid("part_"), key_hash=partitions.identity(entry["key"])
                )
                entries.append(entry)
            metadata = {**metadata, "id": uid("manifest_"), "count": len(entries), "created": now()}
            storage.publish_manifest(metadata, entries)
            path = f"/api/worktrees/{tree['id']}/preview/source?environment=dev&manifest={metadata['id']}&partition_id={entries[0]['partition_id']}"
            report["partition_preview_1000_keys"] = measure(client, path, repeats)
            return {"repeats": repeats, "nodes": 105, "keys": keys, "measurements": report}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--keys", type=int, default=1000)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(benchmark(args.repeats, args.keys), indent=2) + "\n", encoding="utf-8")
