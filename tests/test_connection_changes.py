"""Connection edits keep results: credentials never make them stale, and a run that finds new
connection settings moves the results of its isolated worker to a new one."""

import copy
import logging

import duckdb
import pytest
from helpers import wait_run

from duckpad.builtin_templates import BUILTINS
from duckpad.execution import contexts
from duckpad.services import Services

# The secret selects the attached file only so that a test can see which value a worker used.
# Real connectors keep what selects data, such as a host or a database, in non-secret parameters.
KEYED = {
    "id": "keyed",
    "family": "database",
    "name": "Keyed DuckDB",
    "parameters": [{"name": "database", "type": "file", "secret": True}, {"name": "label", "type": "text"}],
    "capabilities": ["read"],
    "init_sql": "ATTACH {{ database }} AS {{ alias }} (READ_ONLY);",
}


@pytest.fixture(params=[False, True], ids=["embedded", "isolated"])
def instance(tmp_path, request):
    services = Services.open(tmp_path / "instance", enforce_access=request.param)
    try:
        yield services
    finally:
        services.close()


def database(tmp_path, name, amount):
    path = tmp_path / name / "warehouse.duckdb"
    path.parent.mkdir(parents=True)
    with duckdb.connect(str(path)) as db:
        db.execute("CREATE TABLE orders AS SELECT range AS id, ?::INTEGER AS amount FROM range(3)", [amount])
    return str(path)


def keyed_project(services, tmp_path):
    services.catalog.save("connector", copy.deepcopy(KEYED))
    connection = {
        "id": "warehouse",
        "name": "Warehouse",
        "connector": "keyed",
        "environments": {
            environment: {"database": database(tmp_path, f"first-{environment}", 10), "label": "first"}
            for environment in services.catalog.environment_names()
        },
    }
    services.catalog.save("connection", copy.deepcopy(connection), create=True)
    bundle = {
        "flow": {
            "nodes": [
                {
                    "id": "read",
                    "template": "load_table",
                    "params": {"connection": "warehouse", "schema": "main", "table": "orders"},
                },
                {"id": "double", "template": "double", "params": {}},
                {"id": "other", "template": "other", "params": {}},
            ],
            "edges": [
                {
                    "id": "edge",
                    "source": "read",
                    "sourceHandle": "result",
                    "target": "double",
                    "targetHandle": "source",
                }
            ],
        },
        "templates": {
            "load_table": BUILTINS["load_table"],
            "double": "-- @input source\n-- @output result\nSELECT id, amount * 2 AS doubled FROM {{ source }};",
            "other": "-- @output result\nSELECT 17 AS value;",
        },
        "components": {},
        "documentation": {},
    }
    worktree = services.projects.create("Rotation", bundle)["id"]
    if services.engine.access:
        services.engine.access.grant_connections(services.projects.get(worktree)["project"], ["warehouse"])
    run = wait_run(services.store, services.engine.launch(worktree, "dev"), timeout=30)
    assert run["status"] == "success", run
    return worktree, connection


def results(services, worktree):
    engine = services.engine
    return {
        "status": engine.statuses(worktree, "dev")["nodes"],
        "double": engine.preview(worktree, "dev", "double"),
        "other": engine.preview(worktree, "dev", "other"),
    }


def explanation(services, worktree, dataset):
    explained = services.lineage.explain(worktree, "dev", dataset, 1, "doubled")
    explained.pop("request")
    return explained


def handoff_files(services, worktree):
    return list(services.store.paths.exports(worktree, "dev").glob(".temporary/handoff-*"))


def test_connection_fingerprints_ignore_secret_values(services, tmp_path):
    _, _, catalog, _ = services
    catalog.save("connector", copy.deepcopy(KEYED))
    connection = {
        "id": "warehouse",
        "name": "Warehouse",
        "connector": "keyed",
        "environments": {"dev": {"database": database(tmp_path, "first", 10), "label": "first"}},
    }
    catalog.save("connection", copy.deepcopy(connection), create=True)

    def fingerprint():
        return catalog.capture(["warehouse"], "dev")[0]["warehouse"]["fingerprint"]

    before = fingerprint()
    connection["environments"]["dev"]["database"] = database(tmp_path, "second", 20)
    catalog.save("connection", copy.deepcopy(connection))
    assert fingerprint() == before
    connection["environments"]["dev"]["label"] = "second"
    catalog.save("connection", copy.deepcopy(connection))
    assert fingerprint() != before


def test_rotating_a_secret_keeps_results_and_the_next_run_uses_the_new_value(instance, tmp_path):
    worktree, connection = keyed_project(instance, tmp_path)
    before = results(instance, worktree)
    lineage = explanation(instance, worktree, before["double"]["id"])
    worker = instance.engine.context(worktree, "dev").db
    connection["environments"]["dev"]["database"] = database(tmp_path, "second", 20)
    instance.catalog.save("connection", copy.deepcopy(connection))
    # Saving keeps the session; its next run takes the new value.
    assert results(instance, worktree) == before
    assert instance.engine.context(worktree, "dev").db is worker
    run = wait_run(instance.store, instance.engine.launch(worktree, "dev", "other"), timeout=30)
    assert run["status"] == "success", run
    after = results(instance, worktree)
    # Only the targeted node has a new generation; the others moved with their row identities.
    assert after["double"] == before["double"]
    assert after["other"]["id"] != before["other"]["id"]
    assert {node: state["outputs"] for node, state in after["status"].items() if node != "other"} == {
        node: state["outputs"] for node, state in before["status"].items() if node != "other"
    }
    assert explanation(instance, worktree, before["double"]["id"]) == lineage
    if instance.engine.pool.isolated:
        assert instance.engine.context(worktree, "dev").db is not worker
        assert worker.closed
    assert not handoff_files(instance, worktree)
    run = wait_run(instance.store, instance.engine.launch(worktree, "dev"), timeout=30)
    assert run["status"] == "success", run
    assert instance.engine.preview(worktree, "dev", "double")["rows"][0]["values"] == [0, 40]


@pytest.fixture(params=["remote", "file"])
def isolated(tmp_path, request, monkeypatch):
    if request.param == "remote":
        # A remote database, such as PostgreSQL, locks no file: the new worker starts first.
        monkeypatch.setattr(contexts, "database_files", lambda definition, values: {})
    services = Services.open(tmp_path / "instance", enforce_access=True)
    try:
        yield services
    finally:
        services.close()


def test_a_failing_new_worker_keeps_the_results(isolated, tmp_path, request):
    worktree, connection = keyed_project(isolated, tmp_path)
    before = results(isolated, worktree)
    worker = isolated.engine.context(worktree, "dev").db
    broken = tmp_path / "broken" / "warehouse.duckdb"
    broken.parent.mkdir()
    broken.write_text("not a database")
    connection["environments"]["dev"]["database"] = str(broken)
    isolated.catalog.save("connection", copy.deepcopy(connection))
    refused = wait_run(isolated.store, isolated.engine.launch(worktree, "dev", "other"), timeout=30)
    assert refused["status"] == "failed"
    assert "Cannot initialize execution worker" in refused["error"]
    assert str(broken) not in refused["error"]
    assert results(isolated, worktree) == before
    assert not isolated.engine.active
    context = isolated.engine.context(worktree, "dev")
    assert context.db is worker and not worker.closed
    # The old worker released its database file, so the next run tries again.
    assert ("warehouse" in context.connections) == (request.node.callspec.params["isolated"] == "remote")
    connection["environments"]["dev"]["database"] = database(tmp_path, "second", 20)
    isolated.catalog.save("connection", copy.deepcopy(connection))
    run = wait_run(isolated.store, isolated.engine.launch(worktree, "dev", "other"), timeout=30)
    assert run["status"] == "success", run
    assert results(isolated, worktree)["double"] == before["double"]
    assert not handoff_files(isolated, worktree)


def test_results_that_cannot_be_saved_stay_in_the_old_worker(isolated, tmp_path, monkeypatch):
    worktree, connection = keyed_project(isolated, tmp_path)
    before = results(isolated, worktree)
    worker = isolated.engine.context(worktree, "dev").db
    started = []
    original = contexts.ContextPool._open

    def opened(*arguments, **options):
        started.append(original(*arguments, **options))
        return started[-1]

    def full_disk(database, path, *, save):
        path.write_bytes(b"partial")
        raise duckdb.IOException("No space left on device")

    monkeypatch.setattr(contexts.ContextPool, "_open", opened)
    monkeypatch.setattr(contexts, "transfer", full_disk)
    connection["environments"]["dev"]["database"] = database(tmp_path, "second", 20)
    isolated.catalog.save("connection", copy.deepcopy(connection))
    refused = wait_run(isolated.store, isolated.engine.launch(worktree, "dev", "other"), timeout=30)
    assert refused["status"] == "failed"
    assert "Cannot move the results" in refused["error"]
    assert "No space left on device" in refused["error"]
    assert isolated.engine.context(worktree, "dev").db is worker
    assert all(candidate.closed for candidate, _, _ in started)
    assert results(isolated, worktree) == before
    assert not handoff_files(isolated, worktree)


def test_a_writable_database_file_moves_to_the_new_worker(tmp_path, monkeypatch):
    monkeypatch.setitem(KEYED, "init_sql", "ATTACH {{ database }} AS {{ alias }};")
    monkeypatch.setitem(KEYED, "capabilities", ["read", "write"])
    services = Services.open(tmp_path / "instance", enforce_access=True)
    try:
        worktree, connection = keyed_project(services, tmp_path)
        before = results(services, worktree)
        worker = services.engine.context(worktree, "dev").db
        connection["name"] = "Renamed warehouse"
        services.catalog.save("connection", copy.deepcopy(connection))
        run = wait_run(services.store, services.engine.launch(worktree, "dev", "other"), timeout=30)
        assert run["status"] == "success", run
        # A new name changes no setup, so the worker stays.
        assert services.engine.context(worktree, "dev").db is worker
        # The old worker releases the lock on the file, so the new one can attach it.
        connection["environments"]["dev"]["label"] = "second"
        services.catalog.save("connection", copy.deepcopy(connection))
        run = wait_run(services.store, services.engine.launch(worktree, "dev", "other"), timeout=30)
        assert run["status"] == "success", run
        assert services.engine.context(worktree, "dev").db is not worker
        # A non-secret setting selects data: the moved result is stale, not lost.
        after = results(services, worktree)["double"]
        assert (after["id"], after["rows"]) == (before["double"]["id"], before["double"]["rows"])
    finally:
        services.close()


def test_results_that_cannot_be_loaded_are_recalculated(isolated, tmp_path, monkeypatch, caplog):
    worktree, connection = keyed_project(isolated, tmp_path)
    original = contexts.transfer

    def failing_load(database, path, *, save):
        if not save:
            raise duckdb.OutOfMemoryException("Out of memory")
        original(database, path, save=save)

    monkeypatch.setattr(contexts, "transfer", failing_load)
    connection["environments"]["dev"]["database"] = database(tmp_path, "second", 20)
    isolated.catalog.save("connection", copy.deepcopy(connection))
    with caplog.at_level(logging.WARNING):
        run = wait_run(isolated.store, isolated.engine.launch(worktree, "dev", "other"), timeout=30)
    assert run["status"] == "success", run
    assert "they will be recalculated" in caplog.text
    assert set(isolated.engine.statuses(worktree, "dev")["nodes"]) == {"other"}
    assert not handoff_files(isolated, worktree)
