import copy

import duckdb
import pytest
from helpers import wait_run

from duckpad.catalog import redact
from duckpad.lineage import Lineage
from duckpad.util import Problem


def test_absent_numeric_connection_values_use_defaults_without_overriding_explicit_zero(services):
    store, _, catalog, _ = services
    definition = {
        "id": "numeric",
        "parameters": [{"name": "port", "type": "number", "default": 5432}],
        "capabilities": ["read"],
        "init_sql": "",
    }
    catalog.save("connector", definition)
    catalog.save(
        "connection",
        {
            "id": "numeric",
            "name": "Numeric connection",
            "connector": "numeric",
            "environments": {"dev": {}, "prod": {"port": 0}},
        },
        create=True,
    )
    assert catalog.capture(["numeric"], "dev")[0]["numeric"]["values"]["port"] == 5432
    assert catalog.capture(["numeric"], "prod")[0]["numeric"]["values"]["port"] == 0
    assert store.get("connection", "numeric")["environments"]["dev"] == {}
    definition["parameters"][0].pop("default")
    catalog.save("connector", definition)
    with pytest.raises(Problem, match="requires port"):
        catalog.capture(["numeric"], "dev")


def test_declarative_attached_connector_native_insert_and_environment_capture(services, tmp_path):
    store, projects, catalog, engine = services
    paths = {}
    for environment, amount in (("dev", 10), ("prod", 100)):
        path = tmp_path / f"{environment}.duckdb"
        with duckdb.connect(str(path)) as db:
            db.execute("CREATE TABLE orders AS SELECT 1 AS id, ?::INTEGER AS amount", [amount])
            db.execute("CREATE TABLE totals (amount INTEGER)")
        paths[environment] = {"database": str(path)}
    definition = {
        "id": "native",
        "name": "Attached DuckDB",
        "parameters": [{"name": "database", "type": "file"}],
        "capabilities": ["read", "write"],
        "init_sql": "ATTACH {{ database }} AS {{ alias }};",
    }
    catalog.save("connector", definition)
    catalog.save(
        "connection",
        {"id": "warehouse", "name": "Warehouse", "connector": "native", "environments": paths},
        create=True,
    )
    bundle = {
        "flow": {
            "nodes": [
                {"id": "source", "template": "source", "params": {}},
                {"id": "export", "template": "export", "params": {}},
            ],
            "edges": [
                {
                    "id": "input",
                    "source": "source",
                    "sourceHandle": "result",
                    "target": "export",
                    "targetHandle": "source",
                }
            ],
        },
        "templates": {
            "source": '-- @kind source\n-- @param connection: connection = "warehouse"\n-- @param resource: identifier = "orders"\n-- @output result\nSELECT * FROM {{ connection }}.{{ resource }};',
            "export": '-- @kind export\n-- @input source\n-- @param connection: connection = "warehouse"\n-- @param resource: identifier = "totals"\nINSERT INTO {{ connection }}.{{ resource }} SELECT amount * 2 FROM {{ source }};',
        },
        "components": {},
        "documentation": {},
    }
    worktree = projects.create("Generic connector", bundle)["id"]
    commit = projects.snapshot(worktree)["commit"]
    first = wait_run(store, engine.launch(worktree, "dev"))
    assert first["status"] == "success", first
    second = wait_run(store, engine.launch(worktree, "dev"))
    assert second["status"] == "success", second
    data = engine.preview(worktree, "dev", "source")
    assert Lineage(engine).explain(worktree, "dev", data["id"], 0, "amount")["value"] == 10
    context = engine.context(worktree, "dev")
    alias = catalog.capture(["warehouse"], "dev")[0]["warehouse"]["alias"]
    assert context.db.execute(f'SELECT * FROM "{alias}".totals').fetchall() == [(20,), (20,)]
    renamed = {**definition, "name": "Warehouse connector", "description": "Business documentation only"}
    catalog.save("connector", renamed)
    assert engine.preview(worktree, "dev", "source")["status"] == "valid"
    assert projects.snapshot(worktree)["commit"] == commit
    branch = projects.branch(worktree, "historical", commit)["id"]
    third = wait_run(store, engine.launch(branch, "prod"))
    assert third["status"] == "success", third
    assert third["connections"]["warehouse"]["definition"]["name"] == renamed["name"]
    assert first["connections"]["warehouse"]["definition"]["name"] == "Attached DuckDB"
    assert engine.preview(branch, "prod", "source")["rows"][0]["values"] == [1, 100]


def test_setup_rejects_data_operations_and_secret_redaction_survives_definition_deletion(services):
    store, _, catalog, _ = services
    for sql in ("SELECT 1;", "CREATE TABLE hidden AS SELECT 1;", "COPY t TO 'hidden.csv';"):
        with pytest.raises(Problem):
            catalog.save("connector", {"id": "invalid", "parameters": [], "init_sql": sql})
    definition = {
        "id": "secret_test",
        "name": "Secret test",
        "parameters": [{"name": "password", "type": "text", "secret": True}],
        "capabilities": ["read"],
        "init_sql": "",
    }
    catalog.save("connector", definition)
    secret = "quoted'password-with-distinctive-value"
    connection = {
        "id": "hidden",
        "name": "Hidden",
        "connector": "secret_test",
        "environments": {"dev": {"password": secret}},
    }
    catalog.save("connection", copy.deepcopy(connection), create=True)
    _, secrets = catalog.capture(["hidden"], "dev")
    assert secret not in str(catalog.public())
    assert secret.replace("'", "''") not in redact(secret.replace("'", "''"), secrets)
    store.delete("connector", "secret_test")
    assert secret not in str(catalog.public())
    with pytest.raises(Problem, match="Missing connector"):
        catalog.capture(["hidden"], "dev")
