"""Shared builders and deterministic waits for the test suite."""

import threading
import time

import duckdb

from duckpad.execution.runs import UNFINISHED_RUN_STATUSES
from duckpad.lineage import Lineage


def wait_until(predicate, timeout=10, message="Condition was not reached"):
    """Poll a condition instead of sleeping for a fixed time."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.01)
    raise AssertionError(message)


def wait_run(store, run, timeout=10):
    def finished():
        result = store.get("run", run["id"])
        return result if result["status"] not in UNFINISHED_RUN_STATUSES else None

    return wait_until(finished, timeout, "Run did not finish")


def join_run(store, run_id, timeout=30):
    """Wait until a run's worker thread has finished and released its worktree; return the record."""
    for thread in threading.enumerate():
        if thread.name == run_id:
            thread.join(timeout)
            assert not thread.is_alive(), f"Run {run_id} did not finish within {timeout} seconds"
    return store.get("run", run_id)


def enable_excel(bundle):
    """Enable excel in the project unless the installed DuckDB build links it statically.

    Duckpad's runtime links excel. Other builds, such as the PyPI wheel, read workbooks once the
    project enables it, from a binary an instance administrator installed.
    """
    with duckdb.connect() as db:
        query = "SELECT install_mode = 'STATICALLY_LINKED' FROM duckdb_extensions() WHERE extension_name = 'excel'"
        if not db.execute(query).fetchone()[0]:
            bundle["extensions"] = {"excel": {"source": "core", "enabled": True}}
    return bundle


def files_connection(catalog, identity="files"):
    """A folder connection without a root, for tests that need a connection to prepare or revoke."""
    environments = {environment: {"root": ""} for environment in catalog.environment_names()}
    catalog.save(
        "connection",
        {"id": identity, "name": "Files", "connector": "local", "environments": environments},
        create=True,
    )
    return identity


def example_bundle(path):
    path.write_text("id,region,amount\n1,North,10\n2,North,20\n3,South,30\n")
    return {
        "flow": {
            "name": "Test",
            "nodes": [
                {"id": "source", "template": "source", "params": {"file": str(path)}},
                {"id": "filter", "template": "filter", "params": {"threshold": 0}},
                {"id": "total", "template": "total", "params": {}},
            ],
            "edges": [
                {
                    "id": "a",
                    "source": "source",
                    "sourceHandle": "result",
                    "target": "filter",
                    "targetHandle": "source",
                },
                {
                    "id": "b",
                    "source": "filter",
                    "sourceHandle": "result",
                    "target": "total",
                    "targetHandle": "source",
                },
            ],
        },
        "templates": {
            "source": '-- @kind source\n-- @param connection: connection = ""\n-- @param file: file(connection)\n-- @output result\nSELECT * FROM read_csv({{ file }});',
            "filter": "-- @input source\n-- @param threshold: number = 0\n-- @output result\nSELECT * FROM {{ source }} WHERE amount > {{ threshold }};",
            "total": "-- @input source\n-- @output result\nSELECT region, SUM(amount) AS total, COUNT(*) AS count FROM {{ source }} GROUP BY region ORDER BY region;",
        },
        "components": {},
        "documentation": {},
    }


def pipeline(services, tmp_path, query):
    store, projects, _, engine = services
    source = tmp_path / "input.csv"
    source.write_text(
        "id,grp,value,category\n1,A,10,X\n2,A,20,X\n3,A,20,Y\n4,B,30,Z\n5,B,40,Z\n6,B,50,W\n7,B,60,V\n8,B,70,U\n9,B,80,T\n"
    )
    bundle = {
        "flow": {
            "nodes": [
                {"id": "source", "template": "source", "params": {"file": str(source)}},
                {"id": "query", "template": "query", "params": {}},
            ],
            "edges": [
                {
                    "id": "edge",
                    "source": "source",
                    "sourceHandle": "result",
                    "target": "query",
                    "targetHandle": "source",
                }
            ],
        },
        "templates": {
            "source": "-- @kind source\n-- @param file: file\n-- @output result\nSELECT * FROM read_csv({{ file }});",
            "query": "-- @input source\n-- @output result\n" + query,
        },
        "components": {},
        "documentation": {},
    }
    worktree = projects.create("Lineage", bundle)["id"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["status"] == "success", run
    preview = engine.preview(worktree, "dev", "query")
    return worktree, preview, Lineage(engine)
