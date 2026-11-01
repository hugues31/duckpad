import copy

import duckdb
import pytest
from helpers import wait_run

from duckpad.builtin_connectors import BUILTIN_CONNECTORS
from duckpad.catalog import redact
from duckpad.lineage import Lineage
from duckpad.util import Problem


def test_absent_numeric_connection_values_use_defaults_without_overriding_explicit_zero(services):
    store, _, catalog, _ = services
    definition = {
        "id": "numeric",
        "family": "database",
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
        "family": "database",
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


def test_setup_rejects_data_operations_and_referenced_connector_deletion(services):
    store, _, catalog, _ = services
    for sql in ("SELECT 1;", "CREATE TABLE hidden AS SELECT 1;", "COPY t TO 'hidden.csv';"):
        with pytest.raises(Problem):
            catalog.save(
                "connector", {"id": "invalid", "family": "database", "parameters": [], "init_sql": sql}
            )
    definition = {
        "id": "secret_test",
        "family": "database",
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
    with pytest.raises(Problem, match="Remove this connector's connections"):
        catalog.delete("connector", "secret_test")
    assert secret not in str(catalog.public())
    assert catalog.capture(["hidden"], "dev")[0]
    catalog.delete("connection", "hidden")
    catalog.delete("connector", "secret_test")
    assert store.get("connector", "secret_test") is None


def test_built_in_connectors_come_with_the_release_and_edits_are_overrides(services, monkeypatch):
    store, _, catalog, _ = services
    assert store.all("connector") == []
    listed = {c["id"]: c for c in catalog.connectors()}
    assert {identity: c["origin"] for identity, c in listed.items()} == {
        "folder": "built-in",
        "s3": "built-in",
        "oracle": "built-in",
    }
    assert {identity: c["family"] for identity, c in listed.items()} == {
        "folder": "storage",
        "s3": "storage",
        "oracle": "database",
    }
    assert listed["folder"]["name"] == "Server folder"
    # Saving a built-in unchanged, even with its listing's origin, stores nothing.
    catalog.save("connector", copy.deepcopy(listed["s3"]))
    assert store.all("connector") == []
    customized = {**catalog.connector("s3"), "name": "Company S3"}
    customized["parameters"] = [*customized["parameters"], {"name": "session_token", "type": "text"}]
    catalog.save("connector", copy.deepcopy(customized))
    # A later release changes the shipped definition; the administrator's version is kept.
    shipped = {**BUILTIN_CONNECTORS["s3"], "description": "Fixed in a later release."}
    monkeypatch.setitem(BUILTIN_CONNECTORS, "s3", shipped)
    s3 = next(c for c in catalog.connectors() if c["id"] == "s3")
    assert s3["origin"] == "customized"
    assert s3["name"] == "Company S3"
    assert catalog.connector("s3") == customized
    catalog.reset("s3")
    assert store.all("connector") == []
    assert catalog.connector("s3") == shipped
    assert next(c for c in catalog.connectors() if c["id"] == "s3")["origin"] == "built-in"
    # Resetting an unedited built-in changes nothing; custom types have nothing to reset to.
    catalog.reset("s3")
    with pytest.raises(Problem, match="Only built-in connectors can be reset") as missing:
        catalog.reset("custom")
    assert missing.value.status == 404
    with pytest.raises(Problem, match="Built-in connectors cannot be deleted") as builtin:
        catalog.delete("connector", "folder")
    assert builtin.value.status == 409


def test_duplicates_are_custom_types_under_a_new_identifier(services):
    store, _, catalog, _ = services
    duplicate = {**catalog.connector("folder"), "id": "finance_folder", "name": "Finance folder"}
    with pytest.raises(Problem, match="already exists") as exists:
        catalog.save("connector", {**duplicate, "id": "folder"}, create=True)
    assert exists.value.status == 409
    catalog.save("connector", copy.deepcopy(duplicate), create=True)
    with pytest.raises(Problem, match="already exists"):
        catalog.save("connector", copy.deepcopy(duplicate), create=True)
    listed = {c["id"]: c["origin"] for c in catalog.connectors()}
    assert listed == {
        "folder": "built-in",
        "s3": "built-in",
        "oracle": "built-in",
        "finance_folder": "custom",
    }
    assert store.get("connector", "finance_folder") == duplicate


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"family": None}, "Connector family must be database or storage"),
        ({"family": "files"}, "Connector family must be database or storage"),
        (
            {"parameters": [{"name": "path", "type": "text"}]},
            "Storage connectors must declare a text root parameter",
        ),
        (
            {"parameters": [{"name": "root", "type": "number"}]},
            "Storage connectors must declare a text root parameter",
        ),
    ],
)
def test_definitions_declare_their_family_without_inference(services, changes, message):
    _, _, catalog, _ = services
    definition = {**catalog.connector("folder"), "id": "share", **changes}
    definition = {key: value for key, value in definition.items() if value is not None}
    with pytest.raises(Problem, match=message):
        catalog.save("connector", definition)
