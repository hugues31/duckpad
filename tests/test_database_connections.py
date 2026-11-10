"""Database connections: the generic table templates, Test connection and database object listings."""

import copy
import json
import sys
from pathlib import Path

import duckdb
import pytest
from fastapi.testclient import TestClient
from helpers import wait_run

from duckpad import connection_probe
from duckpad.app import create_app
from duckpad.builtin_templates import BUILTINS
from duckpad.catalog import MASK
from duckpad.services import Services
from duckpad.util import Problem

# An administrator-declared connector without extensions: a DuckDB file per environment.
NATIVE = {
    "id": "native",
    "family": "database",
    "name": "Attached DuckDB",
    "parameters": [{"name": "database", "type": "file"}],
    "capabilities": ["read", "write"],
    "init_sql": "ATTACH {{ database }} AS {{ alias }};",
}
CRASH = [sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGILL)"]
EXAMPLES = Path(__file__).resolve().parents[1] / "docs" / "connectors"


def databases(tmp_path):
    """A dev and a prod database file with the same tables and different values."""
    environments = {}
    for environment, amount in (("dev", 10), ("prod", 100)):
        path = tmp_path / "databases" / environment / "warehouse.duckdb"
        path.parent.mkdir(parents=True, exist_ok=True)
        with duckdb.connect(str(path)) as db:
            db.execute("CREATE SCHEMA sales")
            db.execute(
                "CREATE TABLE sales.orders AS SELECT 1 AS id, 'North' AS region, ?::INTEGER AS amount",
                [amount],
            )
            db.execute("CREATE TABLE sales.totals (region VARCHAR, total INTEGER, note VARCHAR)")
            db.execute("CREATE VIEW sales.large_orders AS SELECT * FROM sales.orders WHERE amount > 50")
        environments[environment] = {"database": str(path)}
    return environments


def warehouse(catalog, tmp_path):
    catalog.save("connector", copy.deepcopy(NATIVE))
    connection = {
        "id": "warehouse",
        "name": "Warehouse",
        "connector": "native",
        "environments": databases(tmp_path),
    }
    catalog.save("connection", copy.deepcopy(connection), create=True)
    return connection


def table_bundle(connection="warehouse"):
    node = {"position": {"x": 0, "y": 0}}
    return {
        "flow": {
            "nodes": [
                {
                    **node,
                    "id": "read",
                    "template": "load_table",
                    "params": {"connection": connection, "schema": "sales", "table": "orders"},
                },
                {**node, "id": "totals", "template": "totals", "params": {}},
                {
                    **node,
                    "id": "write",
                    "template": "export_table",
                    "params": {"connection": connection, "schema": "sales", "table": "totals"},
                },
            ],
            "edges": [
                {
                    "id": f"{a}_{b}",
                    "source": a,
                    "sourceHandle": "result",
                    "target": b,
                    "targetHandle": "source",
                }
                for a, b in (("read", "totals"), ("totals", "write"))
            ],
        },
        "templates": {
            **BUILTINS,
            "totals": "-- @input source\n-- @output result\nSELECT region, amount AS total FROM {{ source }};",
        },
        "components": {},
        "documentation": {},
    }


@pytest.fixture(params=[False, True], ids=["embedded", "isolated"])
def database_services(tmp_path, request):
    instance = Services.open(tmp_path / "instance", enforce_access=request.param, isolated=request.param)
    try:
        yield instance.store, instance.projects, instance.catalog, instance.engine
    finally:
        instance.close()


def test_an_administrator_declared_database_works_through_load_table_and_export_table(
    database_services, tmp_path
):
    store, projects, catalog, engine = database_services
    warehouse(catalog, tmp_path)
    worktree = projects.create("Tables", table_bundle())["id"]
    if engine.enforce_access:
        engine.access.grant_connections(projects.get(worktree)["project"], ["warehouse"])
    # Before any run, a separate process attaches the database to list it.
    listed = engine.connection_objects(worktree, "warehouse", "dev")
    sample = engine.connection_objects(worktree, "warehouse", "dev", ("sales", "orders"))
    assert sample["rows"] == [[1, "North", 10]]
    assert sample["columns"][0] == {"name": "id", "type": "INTEGER"}
    assert store.all("run") == []
    with pytest.raises(Problem):
        engine.connection_objects(
            worktree, "warehouse", "dev", ("sales", 'orders"; DROP TABLE sales.orders; --')
        )
    assert listed["schemas"] == ["main", "sales"]
    assert listed["tables"] == [
        {"schema": "sales", "name": "large_orders", "view": True},
        {"schema": "sales", "name": "orders", "view": False},
        {"schema": "sales", "name": "totals", "view": False},
    ]
    for environment in ("dev", "dev", "prod"):
        run = wait_run(store, engine.launch(worktree, environment), timeout=30)
        assert run["status"] == "success", run
    assert engine.preview(worktree, "prod", "read")["rows"][0]["values"] == [1, "North", 100]
    # The session now holds the file's lock: listing falls back to its attachment.
    assert engine.connection_objects(worktree, "warehouse", "dev") == listed
    assert engine.connection_objects(worktree, "warehouse", "dev", ("sales", "orders")) == sample
    for environment, rows in (("dev", [("North", 10, None)] * 2), ("prod", [("North", 100, None)])):
        alias = catalog.capture(["warehouse"], environment)[0]["warehouse"]["alias"]
        context = engine.context(worktree, environment)
        query = f'SELECT region, total, note FROM "{alias}".sales.totals'
        # Appended by name on every run, without truncation or table creation.
        cursor = context.db.cursor()
        try:
            assert cursor.execute(query).fetchall() == rows
        finally:
            cursor.close()


@pytest.fixture
def isolated(tmp_path):
    instance = Services.open(tmp_path / "instance", enforce_access=True, isolated=True)
    try:
        yield instance
    finally:
        instance.close()


@pytest.mark.parametrize("writable", [False, True], ids=["read-only", "writable"])
def test_database_directory_access_is_scoped_to_the_grant_and_environment(isolated, tmp_path, writable):
    connection = warehouse(isolated.catalog, tmp_path)
    if not writable:
        isolated.catalog.save(
            "connector",
            {
                **NATIVE,
                "capabilities": ["read"],
                "init_sql": "ATTACH {{ database }} AS {{ alias }} (READ_ONLY);",
            },
        )
    worktree = isolated.projects.create("Directory scope")
    access = isolated.engine.access
    access.grant_connections(worktree["project"], ["warehouse"])
    dev = Path(connection["environments"]["dev"]["database"]).parent
    sibling = dev / "sibling.csv"
    sibling.write_text("value\n42\n")
    outside = tmp_path / "private.csv"
    outside.write_text("value\n99\n")
    other = isolated.projects.create("Other project")
    private = isolated.store.paths.resources(other["project"]) / "private.csv"
    private.parent.mkdir(parents=True, exist_ok=True)
    private.write_text("value\n100\n")
    link = dev / "escape.csv"
    link.symlink_to(private)
    db = isolated.engine.context(worktree["id"], "dev", create=True).db.cursor()
    assert db.execute("SELECT * FROM read_csv(?)", [str(sibling)]).fetchall() == [(42,)]
    for forbidden in (
        outside,
        private,
        link,
        isolated.store.home / "instance.sqlite",
        Path(connection["environments"]["prod"]["database"]),
    ):
        with pytest.raises((duckdb.Error, Problem)):
            db.execute("SELECT * FROM read_blob(?)", [str(forbidden)]).fetchall()
    output = dev / "journal-test.csv"
    query = f"COPY (SELECT 1 AS value) TO '{output}' (HEADER)"
    if writable:
        db.execute(query)
        assert output.read_text() == "value\n1\n"
    else:
        with pytest.raises((duckdb.Error, Problem)):
            db.execute(query)
        assert not output.exists()
    # A project without this grant gets no access to the directory at all.
    other_db = isolated.engine.context(other["id"], "dev", create=True).db.cursor()
    with pytest.raises((duckdb.Error, Problem)):
        other_db.execute("SELECT * FROM read_blob(?)", [str(sibling)]).fetchall()
    other_db.close()
    db.close()


@pytest.mark.parametrize("location", ["metadata", "ancestor", "other-project", "symlink", "missing"])
def test_database_directory_guards_apply_to_probes_listings_and_workers(isolated, tmp_path, location):
    connection = warehouse(isolated.catalog, tmp_path)
    worktree = isolated.projects.create("Guarded")
    other = isolated.projects.create("Private")
    other_files = isolated.store.paths.resources(other["project"])
    other_files.mkdir(parents=True, exist_ok=True)
    link = tmp_path / "database-link"
    link.symlink_to(other_files, target_is_directory=True)
    path = {
        "metadata": isolated.store.home / "instance.sqlite",
        "ancestor": tmp_path / "broad.duckdb",
        "other-project": other_files / "private.duckdb",
        "symlink": link / "private.duckdb",
        "missing": tmp_path / "missing" / "database.duckdb",
    }[location]
    connection["environments"]["dev"]["database"] = str(path)
    isolated.catalog.save("connection", connection)
    isolated.engine.access.grant_connections(worktree["project"], ["warehouse"])
    for operation in (
        lambda: isolated.engine.test_connection(connection, "dev"),
        lambda: isolated.engine.connection_objects(worktree["id"], "warehouse", "dev"),
        lambda: isolated.engine.context(worktree["id"], "dev", create=True),
    ):
        with pytest.raises(Problem, match="Connection Warehouse, file parameter database") as refused:
            operation()
        assert "Choose an existing dedicated database directory" in str(refused.value)


@pytest.mark.parametrize("missing", [True, False], ids=["missing-file", "write-permission"])
def test_inaccessible_database_names_the_connection_and_explains_permissions(isolated, tmp_path, missing):
    connection = warehouse(isolated.catalog, tmp_path)
    isolated.catalog.save(
        "connector",
        {
            **NATIVE,
            "capabilities": ["read"],
            "init_sql": (
                "ATTACH {{ database }} AS {{ alias }} (READ_ONLY);" if missing else NATIVE["init_sql"]
            ),
        },
    )
    # The parent is authorized, but the file is missing or its write access is denied.
    if missing:
        Path(connection["environments"]["dev"]["database"]).unlink()
    worktree = isolated.projects.create("Missing file")
    isolated.engine.access.grant_connections(worktree["project"], ["warehouse"])
    with pytest.raises(Problem, match="Cannot initialize connection Warehouse") as failed:
        isolated.engine.context(worktree["id"], "dev", create=True)
    assert "filesystem permissions" in str(failed.value)
    assert "Read-only connectors must attach the database read-only" in str(failed.value)


def test_a_database_in_project_resources_is_only_available_to_its_own_project(isolated):
    owner = isolated.projects.create("Database owner")
    outsider = isolated.projects.create("Other project")
    directory = isolated.store.paths.resources(owner["project"])
    directory.mkdir(parents=True, exist_ok=True)
    warehouse(isolated.catalog, directory)
    for project in (owner, outsider):
        isolated.engine.access.grant_connections(project["project"], ["warehouse"])
    isolated.engine.context(owner["id"], "dev", create=True)
    with pytest.raises(Problem, match="instance metadata and other projects"):
        isolated.engine.context(outsider["id"], "dev", create=True)


def test_file_parameters_use_defaults_and_resolved_paths_without_granting_uris(
    isolated, tmp_path, monkeypatch
):
    directory = tmp_path / "databases"
    directory.mkdir()
    monkeypatch.chdir(directory)
    isolated.catalog.save(
        "connector",
        {
            **NATIVE,
            "parameters": [
                {"name": "database", "type": "file", "default": "relative.duckdb"},
                {"name": "remote", "type": "file", "default": "s3://bucket/database.duckdb"},
                {"name": "memory", "type": "file", "default": ":memory:"},
                {"name": "empty", "type": "file", "default": ""},
                {"name": "text", "type": "text", "default": str(tmp_path)},
            ],
        },
    )
    captured, _ = isolated.catalog.capture_draft(
        {
            "name": "Defaults",
            "connector": "native",
            "environments": {"dev": {}},
        },
        "dev",
    )
    assert captured["unsaved"]["values"]["database"] == str(directory / "relative.duckdb")
    assert isolated.engine.access.database_roots(captured) == ([directory], [directory])


def test_listing_database_objects_needs_a_database_connection(services, tmp_path):
    _, projects, catalog, engine = services
    warehouse(catalog, tmp_path)
    catalog.save(
        "connection",
        {
            "id": "share",
            "name": "Share",
            "connector": "folder",
            "environments": {"dev": {"root": str(tmp_path)}},
        },
        create=True,
    )
    worktree = projects.create("Tables", table_bundle())["id"]
    with pytest.raises(Problem, match="Connection share is not a database") as storage:
        engine.connection_objects(worktree, "share", "dev")
    assert storage.value.status == 422
    with pytest.raises(Problem, match="Missing connection: unknown"):
        engine.connection_objects(worktree, "unknown", "dev")


def test_test_connection_runs_an_unsaved_connection_and_keeps_stored_secrets(services, tmp_path):
    _, _, catalog, engine = services
    catalog.save(
        "connector",
        {
            **NATIVE,
            "id": "keyed",
            "parameters": [{"name": "database", "type": "text", "secret": True}],
            "init_sql": "ATTACH {{ database }} AS {{ alias }} (READ_ONLY);",
        },
    )
    missing = tmp_path / "distinctive-missing-name.duckdb"
    draft = {"id": "", "name": "", "connector": "keyed", "environments": {"dev": {"database": str(missing)}}}
    with pytest.raises(Problem) as failed:
        engine.test_connection(draft, "dev")
    assert failed.value.status == 422
    assert "distinctive-missing-name" not in str(failed.value)
    assert MASK in str(failed.value)
    environments = databases(tmp_path)
    catalog.save(
        "connection",
        {"id": "keyed", "name": "Keyed", "connector": "keyed", "environments": copy.deepcopy(environments)},
        create=True,
    )
    # The form sends saved secrets masked; the test uses the stored values.
    masked = {
        "id": "keyed",
        "name": "Keyed",
        "connector": "keyed",
        "environments": {"dev": {"database": MASK}},
    }
    tested = engine.test_connection(masked, "dev")
    assert tested["schemas"] == ["main", "sales"]
    assert {"schema": "sales", "name": "orders", "view": False} in tested["tables"]
    with pytest.raises(Problem, match="Unknown environment"):
        engine.test_connection(masked, "staging")


def test_a_crashing_connection_setup_is_reported_without_stopping_the_server(services, tmp_path, monkeypatch):
    _, _, catalog, engine = services
    connection = warehouse(catalog, tmp_path)
    monkeypatch.setattr(connection_probe, "COMMAND", CRASH)
    with pytest.raises(Problem, match=r"Connection setup stopped its process \(SIGILL\)") as crashed:
        engine.test_connection(connection, "dev")
    assert crashed.value.status == 422
    monkeypatch.setattr(connection_probe, "TIMEOUT", 0.5)
    monkeypatch.setattr(connection_probe, "COMMAND", [sys.executable, "-c", "import time; time.sleep(30)"])
    with pytest.raises(Problem, match=r"did not respond within 0\.5 seconds"):
        engine.test_connection(connection, "dev")
    # Loading extensions alone may download them: it gets its own, longer limit.
    monkeypatch.setattr(connection_probe, "INSTALL_TIMEOUT", 0.5)
    with pytest.raises(Problem, match=r"Loading did not finish within 0\.5 seconds"):
        connection_probe.run({}, {}, {}, [], setup=False)
    monkeypatch.undo()
    assert engine.test_connection(connection, "dev")["schemas"] == ["main", "sales"]


def test_test_connection_checks_a_folder_root(services, tmp_path):
    _, _, _, engine = services
    folder = {"id": "", "name": "", "connector": "folder", "environments": {"dev": {"root": str(tmp_path)}}}
    assert engine.test_connection(folder, "dev") == {"root": str(tmp_path)}
    folder["environments"]["dev"]["root"] = str(tmp_path / "absent")
    with pytest.raises(Problem, match="The root folder does not exist on the Duckpad server"):
        engine.test_connection(folder, "dev")


def test_embedded_runs_load_connector_extensions_in_a_child_first(services, tmp_path, monkeypatch):
    store, projects, catalog, engine = services
    catalog.save("connector", {**NATIVE, "extensions": [{"name": "crashing_test_extension"}]})
    catalog.save(
        "connection",
        {"id": "warehouse", "name": "Warehouse", "connector": "native", "environments": databases(tmp_path)},
        create=True,
    )
    monkeypatch.setattr(connection_probe, "COMMAND", CRASH)
    worktree = projects.create("Tables", table_bundle())["id"]
    run = wait_run(store, engine.launch(worktree, "dev"), timeout=30)
    assert run["status"] == "failed"
    error = run["nodes"]["read"]["error"]
    assert "Cannot load the extensions of connection Warehouse" in error
    # This process survived: only the child loading the extension stopped.
    assert "SIGILL" in error


def test_isolated_sessions_install_connector_extensions_in_a_child_first(tmp_path, monkeypatch):
    instance = Services.open(tmp_path / "instance", enforce_access=True, isolated=True)
    try:
        instance.catalog.save(
            "connector", {**NATIVE, "extensions": [{"name": "crashing_isolated_extension"}]}
        )
        instance.catalog.save(
            "connection",
            {
                "id": "warehouse",
                "name": "Warehouse",
                "connector": "native",
                "environments": databases(tmp_path),
            },
            create=True,
        )
        worktree = instance.projects.create("Tables")
        assert instance.engine.access is not None
        instance.engine.access.grant_connections(worktree["project"], ["warehouse"])
        monkeypatch.setattr(connection_probe, "COMMAND", CRASH)
        # The server used to load the extension itself before starting the worker.
        with pytest.raises(Problem, match="Cannot load the extensions of connection Warehouse") as crashed:
            instance.engine.context(worktree["id"], "dev", create=True)
        assert crashed.value.status == 422
        assert "SIGILL" in str(crashed.value)
    finally:
        instance.close()


def test_postgres_passes_additional_options_to_the_driver_unchanged(services):
    _, _, catalog, _ = services
    postgres = catalog.connector("postgres")
    options = next(p for p in postgres["parameters"] if p["name"] == "options")
    assert (options["label"], options["default"]) == ("Additional options", "")
    catalog.save(
        "connection",
        {
            "id": "sales",
            "name": "Sales",
            "connector": "postgres",
            "environments": {
                "dev": {"host": "db.example.com", "database": "sales", "user": "duckpad", "password": "pw"},
                "prod": {
                    "host": "db.example.com",
                    "database": "sales",
                    "user": "duckpad",
                    "password": "pw",
                    "options": "sslmode=verify-full application_name=duckpad",
                },
            },
        },
        create=True,
    )
    executed = []

    class Recorder:
        def execute(self, sql):
            executed.append(sql)
            return self

        def fetchall(self):
            return []

    for environment, attached in (("dev", "''"), ("prod", "'sslmode=verify-full application_name=duckpad'")):
        captured, _ = catalog.capture(["sales"], environment)
        executed.clear()
        catalog.prepare(Recorder(), captured)
        assert executed[0] == 'LOAD "postgres"'
        # libpq refuses a port written as 5432.0.
        assert "PORT 5432," in executed[-1]
        assert f"ATTACH {attached} AS" in executed[-1]


def test_connector_parameter_labels_are_documentation(services):
    _, _, catalog, _ = services
    with pytest.raises(Problem, match="labels and descriptions must be text"):
        catalog.save(
            "connector", {**NATIVE, "parameters": [{"name": "database", "type": "file", "label": 1}]}
        )
    catalog.save("connector", copy.deepcopy(NATIVE))
    catalog.save(
        "connection",
        {"id": "w", "name": "W", "connector": "native", "environments": {"dev": {"database": ":memory:"}}},
        create=True,
    )
    before = catalog.capture(["w"], "dev")[0]["w"]["fingerprint"]
    labeled = copy.deepcopy(NATIVE)
    labeled["parameters"][0].update(label="Database file", description="Path on the server")
    catalog.save("connector", labeled)
    # Relabeling a parameter never makes results stale.
    assert catalog.capture(["w"], "dev")[0]["w"]["fingerprint"] == before


@pytest.mark.skipif(not EXAMPLES.is_dir(), reason="Source archives ship no documentation")
@pytest.mark.parametrize("name", ["mysql", "sqlite"])
def test_published_examples_are_valid_definitions_shown_in_the_guide(services, name):
    _, _, catalog, _ = services
    definition = json.loads((EXAMPLES / f"{name}.json").read_text())
    catalog.save("connector", copy.deepcopy(definition), create=True)
    assert definition["family"] == "database"
    guide = (EXAMPLES.parent / "CONNECTORS.md").read_text()
    blocks = [block.split("```", 1)[0] for block in guide.split("```json\n")[1:]]
    assert definition in [json.loads(block) for block in blocks]


@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path / "instance", watch=False)


def test_test_connection_and_object_listing_api(app, tmp_path):
    with TestClient(app) as client:
        client.post("/api/login", json={"username": "admin", "password": app.state.auth.initial_password})
        client.put("/api/catalog/connector", json=NATIVE).raise_for_status()
        connection = {
            "id": "warehouse",
            "name": "Warehouse",
            "connector": "native",
            "environments": databases(tmp_path),
        }
        tested = client.post(
            "/api/catalog/connection/test", json={"connection": connection, "environment": "dev"}
        )
        assert tested.status_code == 200, tested.text
        assert tested.json()["schemas"] == ["main", "sales"]
        failed = client.post(
            "/api/catalog/connection/test",
            json={"connection": {**connection, "connector": "missing"}, "environment": "dev"},
        )
        assert failed.status_code == 400
        assert failed.json()["error"] == "Connector definition does not exist"
        client.put("/api/catalog/connection?create=true", json=connection).raise_for_status()
        worktree = client.post("/api/projects", json={"name": "Tables"}).json()
        url = f"/api/worktrees/{worktree['id']}/connections/warehouse/objects?environment=dev"
        assert client.get(url).status_code == 403
        client.put(
            f"/api/projects/{worktree['project']}/connections", json={"connections": ["warehouse"]}
        ).raise_for_status()
        listed = client.get(url)
        assert listed.status_code == 200, listed.text
        assert {"schema": "sales", "name": "orders", "view": False} in listed.json()["tables"]
