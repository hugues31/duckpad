"""Execution context startup, isolated connection setup and race-free cancellation."""

import copy
import threading
from concurrent.futures import ThreadPoolExecutor

import duckdb
import pytest
from helpers import example_bundle, pipeline, wait_run, wait_until

from duckpad import sandbox
from duckpad.bundle import bundle_to_files
from duckpad.services import Services
from duckpad.util import Problem

SLOW = "-- @kind source\n-- @output result\nSELECT SUM(random()) AS value FROM range(10000000000);"
# A request that must not wait for another worktree's worker startup.
PROMPT = 10


@pytest.fixture
def isolated(tmp_path):
    instance = Services.open(tmp_path / "instance", enforce_access=True)
    yield instance
    instance.close()


def project(services, name, connections=("local",), nodes=(), templates=None, edges=()):
    worktree = services.projects.create(name)
    services.engine.access.grant_connections(worktree["project"], list(connections))
    snapshot = services.projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"].update(nodes=list(nodes), edges=list(edges))
    bundle["templates"].update(templates or {})
    services.projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    return worktree


def csv_project(services, name, connections=("local",), extra_nodes=(), extra_templates=None):
    worktree = project(services, name, connections)
    folder = services.store.home / "resources" / worktree["project"]
    folder.mkdir(parents=True, exist_ok=True)
    example = example_bundle(folder / "input.csv")
    snapshot = services.projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"].update(nodes=[*example["flow"]["nodes"], *extra_nodes], edges=example["flow"]["edges"])
    bundle["templates"].update({**example["templates"], **(extra_templates or {})})
    services.projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    return worktree


def test_blocked_worker_startup_blocks_neither_statuses_nor_other_cancellations(isolated, monkeypatch):
    store, engine = isolated.store, isolated.engine
    busy = project(
        isolated, "Busy", nodes=[{"id": "slow", "template": "slow", "params": {}}], templates={"slow": SLOW}
    )
    run = engine.launch(busy["id"], "dev")
    wait_until(
        lambda: store.get("run", run["id"])["nodes"]["slow"]["status"] == "running",
        message="The long query did not start",
    )
    entered, release = threading.Event(), threading.Event()

    class BlockedAttach(sandbox.Database):
        """A worker whose connection setup, such as an unreachable ATTACH, does not return."""

        def __init__(self, policy):
            entered.set()
            release.wait(60)
            super().__init__(policy)

    monkeypatch.setattr(sandbox, "Database", BlockedAttach)
    starting = project(
        isolated,
        "Starting",
        nodes=[{"id": "value", "template": "value", "params": {}}],
        templates={"value": "-- @kind source\n-- @output result\nSELECT 42 AS value;"},
    )
    with ThreadPoolExecutor(4) as pool:
        launch = pool.submit(engine.launch, starting["id"], "dev")
        try:
            assert entered.wait(PROMPT)
            statuses = pool.submit(engine.statuses, busy["id"], "dev").result(PROMPT)
            assert statuses["active"]["id"] == run["id"]
            assert pool.submit(engine.statuses, starting["id"], "dev").result(PROMPT)["nodes"] == {}
            assert pool.submit(engine.cancel, run["id"]).result(PROMPT)["status"] == "canceling"
            assert not launch.done()
        finally:
            release.set()
        started = launch.result(60)
    assert wait_run(store, run, timeout=30)["status"] == "canceled"
    assert wait_run(store, started, timeout=30)["status"] == "success"


def test_isolated_csv_pipeline_ignores_an_authorized_unconfigured_connection(isolated):
    catalog, engine, store = isolated.catalog, isolated.engine, isolated.store
    catalog.save(
        "connection",
        {"id": "warehouse", "name": "Warehouse", "connector": "oracle", "environments": {}},
        create=True,
    )
    catalog.save_environment(
        {"id": "staging", "label": "staging", "color": "#3366cc", "confirm_before_run": False}, create=True
    )
    assert store.get("connection", "warehouse")["environments"] == {"staging": {}}
    oracle = {"id": "oracle", "template": "oracle", "params": {}}
    worktree = csv_project(
        isolated,
        "CSV only",
        ["local", "warehouse"],
        [oracle],
        {
            "oracle": '-- @kind source\n-- @param db: connection = "warehouse"\n-- @output result\nSELECT 1 AS value;'
        },
    )
    run = wait_run(store, engine.launch(worktree["id"], "staging"), timeout=30)
    assert run["status"] == "partial_failure", run
    assert {run["nodes"][n]["status"] for n in ("source", "filter", "total")} == {"success"}
    assert run["nodes"]["oracle"]["status"] == "blocked"
    assert "requires user in staging" in run["nodes"]["oracle"]["error"]
    assert engine.preview(worktree["id"], "staging", "total")["count"] == 2


def test_remote_access_follows_the_secret_type_rather_than_the_connector_id(isolated, monkeypatch):
    catalog, engine = isolated.catalog, isolated.engine
    catalog.save(
        "connector",
        {
            "id": "minio",
            "name": "MinIO",
            "parameters": [
                {"name": "key_id", "type": "text", "secret": True},
                {"name": "secret", "type": "text", "secret": True},
                {"name": "endpoint", "type": "text"},
            ],
            "extensions": [],
            "init_sql": "-- CREATE OR REPLACE TEMPORARY SECRET {{ secret_name }} (TYPE GCS);\n"
            "CREATE OR REPLACE TEMPORARY SECRET {{ secret_name }} (TYPE S3, KEY_ID {{ key_id }}, SECRET {{ secret }}, ENDPOINT {{ endpoint }});",
            "capabilities": ["read", "write"],
        },
    )
    catalog.save(
        "connection",
        {
            "id": "lake",
            "name": "Lake",
            "connector": "minio",
            "environments": {"dev": {"key_id": "key", "secret": "hidden", "endpoint": "localhost:9000"}},
        },
        create=True,
    )
    policies = []

    class Recorded:
        """Record the worker policy; connecting to object storage is outside this test."""

        closed = False

        def __init__(self, policy):
            policies.append(policy)

        def close(self):
            pass

    monkeypatch.setattr(sandbox, "Database", Recorded)
    remote = project(isolated, "Remote", ["local", "lake"])
    local = project(isolated, "Local")
    engine.context(remote["id"], "dev", create=True)
    engine.context(local["id"], "dev", create=True)
    assert set(policies[0]["captured"]) == {"local", "lake"}
    assert policies[0]["remote_paths"] == ["s3://", "s3a://", "s3n://"]
    assert policies[1]["remote_paths"] == []


def test_extension_installation_failure_is_reported_without_secrets(isolated, tmp_path):
    catalog, engine = isolated.catalog, isolated.engine
    catalog.save(
        "connector",
        {
            "id": "custom",
            "name": "Custom",
            "parameters": [{"name": "token", "type": "text", "secret": True}],
            "extensions": [{"name": "absent_extension", "repository": str(tmp_path / "repository")}],
            "init_sql": "",
            "capabilities": ["read"],
        },
    )
    catalog.save(
        "connection",
        {
            "id": "custom",
            "name": "Custom data",
            "connector": "custom",
            "environments": {"dev": {"token": "t0ken"}},
        },
        create=True,
    )
    worktree = project(isolated, "Extensions", ["local", "custom"])
    with pytest.raises(Problem, match="Cannot install the extensions of connection Custom data") as error:
        engine.context(worktree["id"], "dev", create=True)
    assert error.value.status == 503
    assert "t0ken" not in str(error.value)
    assert engine.context(worktree["id"], "dev").db is None


def test_lineage_unregisters_before_closing_and_ignores_closed_cursors(services, tmp_path):
    store, _, _, engine = services
    worktree, preview, lineage = pipeline(
        services, tmp_path, "SELECT grp, SUM(value) AS total FROM {{ source }} GROUP BY grp ORDER BY grp;"
    )
    context = engine.context(worktree, "dev")
    registered_at_close = []

    class Observed:
        def __init__(self, cursor):
            self.cursor = cursor

        def __getattr__(self, name):
            return getattr(self.cursor, name)

        def close(self):
            registered_at_close.append(bool(context.lineage))
            self.cursor.close()

    class Database:
        def __init__(self, db):
            self.db = db

        def cursor(self):
            return Observed(self.db.cursor())

        def close(self):
            self.db.close()

    context.db = Database(context.db)
    assert lineage.explain(worktree, "dev", preview["id"], preview["rows"][0]["id"], "total")["complete"]
    assert registered_at_close == [False]

    interrupted = threading.Event()

    class Closed:
        """A reader that finished and closed its cursor while recalculation was canceling it."""

        def interrupt(self):
            context.lineage.pop("closed", None)
            interrupted.set()
            raise duckdb.ConnectionException("Connection already closed!")

    canceled = threading.Event()
    context.lineage["closed"] = {"cursor": Closed(), "canceled": canceled, "nodes": {"query"}}
    run = engine.launch(worktree, "dev")
    assert canceled.is_set() and interrupted.wait(PROMPT)
    assert wait_run(store, run)["status"] == "success"


def test_cancellation_keeps_newer_run_progress(services, monkeypatch):
    store, projects, _, engine = services
    tree = projects.create("Cancellation race")
    token = {"id": "race", "cancel": threading.Event(), "cursor": None}
    engine.active[tree["id"]] = token
    run = {
        "id": "race",
        "project": tree["project"],
        "worktree": tree["id"],
        "environment": "dev",
        "status": "running",
        "started": "2026-01-01",
        "commit": "commit",
        "nodes": {"first": {"status": "running"}, "second": {"status": "pending"}},
    }
    engine._persist(run, [])
    progressed = copy.deepcopy(run)
    progressed["nodes"]["first"]["status"] = "success"
    progressed["nodes"]["second"]["status"] = "running"
    # The run thread writes its progress while the cancellation request updates the record.
    writer = threading.Thread(target=engine._persist, args=(progressed, []))
    original = store.put

    def put(kind, key, value):
        if kind == "run" and writer.ident is None:
            writer.start()
            writer.join(0.5)
        return original(kind, key, value)

    with monkeypatch.context() as patch:
        patch.setattr(store, "put", put)
        engine.cancel("race")
        writer.join(PROMPT)
    record = store.get("run", "race")
    assert record["status"] == "canceling"
    assert record["nodes"]["first"]["status"] == "success"
    assert record["nodes"]["second"]["status"] == "running"
    engine.active.pop(tree["id"])
