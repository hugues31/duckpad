"""Shared builders and deterministic waits for the test suite."""

import asyncio
import threading
import time

import httpx2

from duckpad.execution.journal import UNFINISHED_RUN_STATUSES
from duckpad.extensions import core_catalog
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


def wait_run(store, run, timeout=30):
    # Launch returns before dependency and worker setup, which is part of this bounded wait now.
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


class LockHolder:
    """Holds a lock in another thread, as a long save would, until `release` or a timeout."""

    def __init__(self, lock, timeout=5):
        self.released = None
        self.held, self.stop = threading.Event(), threading.Event()

        def hold():
            with lock:
                self.held.set()
                self.stop.wait(timeout)
                self.released = time.monotonic()

        self.thread = threading.Thread(target=hold, daemon=True)

    def acquire(self):
        self.thread.start()
        assert self.held.wait(5), "The lock was not acquired"

    def holding(self):
        return self.released is None

    def release(self):
        self.stop.set()
        self.thread.join(5)


async def assert_responsive(holding):
    """A callback due in 10 ms runs while `holding()` is still true: the event loop never waited."""
    fired = asyncio.Event()
    asyncio.get_running_loop().call_later(0.01, fired.set)
    await fired.wait()
    assert holding(), "The event loop waited for the lock"


def asgi_client(app, **options):
    """A client calling the app in the test's own event loop, unlike TestClient's loop thread."""
    return httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://testserver", timeout=30, **options
    )


def excel_built_in():
    """Whether the installed DuckDB build links excel, as Duckpad's container image does."""
    return any(extension["name"] == "excel" and extension["built_in"] for extension in core_catalog())


def enable_excel(bundle):
    """Enable excel in the project unless the installed DuckDB build links it statically.

    Other builds, such as the PyPI wheel, read workbooks once the project enables it, from a binary
    an instance administrator installed.
    """
    if not excel_built_in():
        bundle["extensions"] = {"excel": {"source": "core", "enabled": True}}
    return bundle


def files_connection(catalog, identity="files", root=""):
    """A Server folder connection for tests that need a connection to prepare or revoke.

    Without a root, file nodes using it accept only absolute paths.
    """
    environments = {environment: {"root": root} for environment in catalog.environment_names()}
    catalog.save(
        "connection",
        {"id": identity, "name": "Files", "connector": "folder", "environments": environments},
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
            "source": '-- @param connection: connection = ""\n-- @param file: file(connection)\n-- @output result\nSELECT * FROM read_csv({{ file }});',
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
            "source": "-- @param file: file\n-- @output result\nSELECT * FROM read_csv({{ file }});",
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
