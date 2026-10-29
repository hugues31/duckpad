import io
import json
import tomllib
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import wait_run

import duckpad
from duckpad.app import SESSION_COOKIE, create_app
from duckpad.builtin_templates import BUILTINS
from duckpad.util import Problem


@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path / "instance", watch=False)


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        yield client


@pytest.fixture
def worktree(client):
    return client.post("/api/projects", json={"name": "API"}).json()["id"]


@pytest.mark.parametrize("name", ["experiment/", "", "feature//change", "two words", "branch.lock"])
def test_invalid_branch_names_have_actionable_errors_without_creating_worktrees(app, client, worktree, name):
    before = client.get("/api/workspace").json()["worktrees"]
    response = client.post(f"/api/worktrees/{worktree}/branches", json={"name": name})
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "invalid_branch_name"
    assert "experiment/my-change" in response.json()["error"]
    assert "cannot end with '/'" in response.json()["error"]
    assert client.get("/api/workspace").json()["worktrees"] == before
    projects = app.state.services.projects
    main = projects.get(worktree)
    assert projects.git(main["path"], "branch", "--format=%(refname:short)") == "main"
    assert not list((projects.store.home / "worktrees").glob("*"))

    corrected = client.post(f"/api/worktrees/{worktree}/branches", json={"name": "experiment/my-change"})
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["branch"] == "experiment/my-change"


def test_session_reports_the_packaged_version(client):
    pyproject = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8"))
    assert (
        client.get("/api/session").json()["version"] == duckpad.__version__ == pyproject["project"]["version"]
    )


def test_named_example_populates_an_independent_project(client, worktree):
    before = client.get(f"/api/worktrees/{worktree}").json()
    response = client.post("/api/example", json={"name": "  Revenue lab  "})
    assert response.status_code == 200, response.text
    example = response.json()
    snapshot = client.get(f"/api/worktrees/{example['id']}").json()
    workspace = client.get("/api/workspace").json()
    project = next(item for item in workspace["projects"] if item["id"] == example["project"])
    assert project["name"] == snapshot["bundle"]["flow"]["name"] == "Revenue lab"
    assert snapshot["bundle"]["flow"]["nodes"]
    assert snapshot["bundle"]["components"]
    connection = next(
        item for item in workspace["catalog"]["connections"] if item["id"] == "sample_" + example["project"]
    )
    for environment in ("dev", "prod"):
        folder = Path(connection["environments"][environment]["root"])
        assert example["project"] in folder.parts
        assert (folder / "orders.csv").is_file()
        assert (folder / "customers.parquet").is_file()
    unchanged = client.get(f"/api/worktrees/{worktree}").json()
    assert unchanged["commit"] == before["commit"]
    assert unchanged["bundle"]["flow"]["nodes"] == []


@pytest.mark.parametrize("body", [None, {}])
def test_example_shortcut_retains_its_default_name(client, body):
    response = client.post("/api/example", json=body)
    assert response.status_code == 200, response.text
    project_id = response.json()["project"]
    project = next(
        item for item in client.get("/api/workspace").json()["projects"] if item["id"] == project_id
    )
    assert project["name"] == "Northstar analytics"


@pytest.mark.parametrize("name", ["", "   ", 42, [], {}])
def test_invalid_example_names_do_not_create_a_project(client, name):
    before = client.get("/api/workspace").json()
    response = client.post("/api/example", json={"name": name})
    assert response.status_code == 422, response.text
    after = client.get("/api/workspace").json()
    assert after["projects"] == before["projects"]
    assert after["catalog"]["connections"] == before["catalog"]["connections"]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("put", "/api/worktrees/{worktree}", {}),
        ("put", "/api/worktrees/{worktree}", {"revision": "r"}),
        ("post", "/api/conflicts/missing/resolve", {}),
        ("put", "/api/catalog/connection", {"id": "abc"}),
        ("put", "/api/catalog/unknown", {"id": "abc"}),
        ("post", "/api/worktrees/{worktree}/lineage", {}),
        ("post", "/api/worktrees/{worktree}/group", {"revision": "r"}),
        ("put", "/api/identity", {"name": "", "email": "someone@example.com"}),
    ],
)
def test_malformed_requests_are_client_errors_in_the_problem_format(client, worktree, method, path, body):
    response = client.request(method, path.format(worktree=worktree), json=body)
    assert 400 <= response.status_code < 500, response.text
    assert response.json()["error"]


def test_grouping_inside_an_unknown_component_is_not_found(client, worktree):
    snapshot = client.get(f"/api/worktrees/{worktree}").json()
    response = client.post(
        f"/api/worktrees/{worktree}/group",
        json={"revision": snapshot["revision"], "nodes": [], "name": "Group", "parent": "missing"},
    )
    assert response.status_code == 404


def test_unknown_worktrees_and_environments_are_not_found(client, worktree):
    assert client.get("/api/worktrees/missing/status?environment=dev").status_code == 404
    assert client.get(f"/api/worktrees/{worktree}/status?environment=missing").status_code == 404
    assert client.get(f"/api/worktrees/{worktree}/status?environment=prod").status_code == 200


ENVIRONMENT_OPERATIONS = [
    ("get", "/status", {}),
    ("get", "/compile/source", {}),
    ("get", "/preview/source", {}),
    ("get", "/exports/export", {}),
    ("get", "/exports/export/download", {"run": "missing"}),
    ("get", "/generations/missing", {}),
    ("post", "/runs", {}),
    ("post", "/lineage", {"dataset": "missing", "row": 0, "column": "value"}),
]


@pytest.mark.parametrize("delete_dev", [False, True])
@pytest.mark.parametrize(("method", "suffix", "data"), ENVIRONMENT_OPERATIONS)
def test_environment_is_required_before_dispatch(
    app, client, worktree, monkeypatch, delete_dev, method, suffix, data
):
    if delete_dev:
        assert client.delete("/api/environments/dev").status_code == 200

    def unexpected_dispatch(*args, **kwargs):
        pytest.fail("A request without an environment reached execution services")

    services = app.state.services
    for name in (
        "statuses",
        "compile",
        "preview",
        "export_result",
        "open_export",
        "generation_valid",
        "launch",
    ):
        monkeypatch.setattr(services.engine, name, unexpected_dispatch)
    monkeypatch.setattr(services.lineage, "explain", unexpected_dispatch)
    response = client.request(
        method,
        f"/api/worktrees/{worktree}{suffix}",
        **{
            "params" if method == "get" else "json": data,
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]
    assert response.json()["detail"] == [
        {
            "location": "query.environment" if method == "get" else "body.environment",
            "message": "Field required",
        }
    ]
    assert services.store.all("run") == []
    assert services.engine.contexts == {}


@pytest.fixture
def environment_pipeline(client, worktree):
    path = f"/api/worktrees/{worktree}"
    snapshot = client.get(path).json()
    bundle = snapshot["bundle"]
    bundle["templates"]["source"] = "-- @kind source\n-- @output result\nSELECT 42 AS value;"
    bundle["templates"]["export_csv"] = BUILTINS["export_csv"]
    bundle["flow"]["nodes"] = [
        {"id": "source", "template": "source", "params": {}},
        {"id": "export", "template": "export_csv", "params": {"destination": "values.csv"}},
    ]
    bundle["flow"]["edges"] = [
        {
            "id": "edge",
            "source": "source",
            "sourceHandle": "result",
            "target": "export",
            "targetHandle": "source",
        }
    ]
    response = client.put(path, json={"revision": snapshot["revision"], "bundle": bundle})
    assert response.status_code == 200, response.text
    return path


@pytest.mark.parametrize("environment", ["dev", "unknown", ""])
@pytest.mark.parametrize(("method", "suffix", "data"), ENVIRONMENT_OPERATIONS)
def test_deleted_and_unknown_environments_are_not_found(
    app, client, environment_pipeline, environment, method, suffix, data
):
    assert client.delete("/api/environments/dev").status_code == 200
    response = client.request(
        method,
        environment_pipeline + suffix,
        **{
            "params" if method == "get" else "json": {**data, "environment": environment},
        },
    )
    assert response.status_code == 404, response.text
    assert response.json()["error"] == "Unknown environment"
    assert app.state.services.store.all("run") == []
    assert app.state.services.engine.contexts == {}


@pytest.mark.parametrize("environment", ["dev", "prod"])
def test_execution_and_results_use_the_explicit_environment(app, client, environment_pipeline, environment):
    path = environment_pipeline
    if environment == "prod":
        assert client.delete("/api/environments/dev").status_code == 200
    params = {"environment": environment}
    response = client.post(path + "/runs", json=params)
    assert response.status_code == 200, response.text
    run = wait_run(app.state.services.store, response.json())
    assert run["status"] == "success", run
    assert run["environment"] == environment
    status = client.get(path + "/status", params=params)
    assert status.status_code == 200
    assert status.json()["nodes"]["source"]["outputs"]["result"]["status"] == "valid"
    compiled = client.get(path + "/compile/source", params=params)
    assert compiled.status_code == 200
    assert "42" in compiled.json()[0]["sql"]
    preview = client.get(path + "/preview/source", params=params)
    assert preview.status_code == 200
    result = preview.json()
    assert result["environment"] == environment
    assert result["rows"][0]["values"] == [42]
    assert client.get(path + f"/generations/{result['id']}", params=params).json() == {"valid": True}
    lineage = client.post(
        path + "/lineage",
        json={
            **params,
            "dataset": result["id"],
            "row": result["rows"][0]["id"],
            "column": "value",
        },
    )
    assert lineage.status_code == 200, lineage.text
    assert lineage.json()["value"] == 42
    assert lineage.json()["complete"]
    exported = client.get(path + "/exports/export", params=params)
    assert exported.status_code == 200
    assert exported.json()["status"] == "available"
    downloaded = client.get(path + "/exports/export/download", params={**params, "run": run["id"]})
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.text.splitlines() == ["value", "42"]


def test_openapi_requires_environments_without_defaults(client):
    schema = client.app.openapi()
    for suffix in (
        "status",
        "compile/{node}",
        "preview/{node}",
        "exports/{node}",
        "exports/{node}/download",
        "generations/{identity}",
    ):
        operation = schema["paths"]["/api/worktrees/{worktree}/" + suffix]["get"]
        parameter = next(item for item in operation["parameters"] if item["name"] == "environment")
        assert parameter["in"] == "query" and parameter["required"]
        assert "default" not in parameter["schema"]
    for name in ("Launch", "Explain"):
        body = schema["components"]["schemas"][name]
        assert "environment" in body["required"]
        assert "default" not in body["properties"]["environment"]


def test_connection_creation_rejects_duplicates_without_overwriting_secrets(app, client):
    connection = {
        "id": "warehouse",
        "name": "Warehouse",
        "connector": "oracle",
        "environments": {
            "dev": {"user": "reader", "password": "dev-secret", "dsn": "dev-db"},
            "prod": {"user": "reader", "password": "prod-secret", "dsn": "prod-db"},
        },
    }
    created = client.put("/api/catalog/connection?create=true", json=connection)
    assert created.status_code == 200, created.text
    store = app.state.services.store
    original = store.get("connection", "warehouse")
    duplicate = {**connection, "name": "Replacement", "environments": {"dev": {"password": "new-secret"}}}
    response = client.put("/api/catalog/connection?create=true", json=duplicate)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "connection_exists"
    assert store.get("connection", "warehouse") == original
    assert client.get("/api/catalog").json() == created.json()

    public = next(c for c in created.json()["connections"] if c["id"] == "warehouse")
    assert public["environments"]["dev"]["password"] == "••••"
    assert public["environments"]["prod"]["password"] == "••••"
    public["name"] = "Renamed warehouse"
    updated = client.put("/api/catalog/connection?create=false", json=public)
    assert updated.status_code == 200, updated.text
    assert store.get("connection", "warehouse") == {**original, "name": "Renamed warehouse"}
    public["environments"]["prod"]["password"] = "rotated-secret"
    assert client.put("/api/catalog/connection?create=false", json=public).status_code == 200
    saved = store.get("connection", "warehouse")
    assert saved["environments"]["prod"]["password"] == "rotated-secret"
    assert saved["environments"]["dev"]["password"] == "dev-secret"


@pytest.mark.parametrize("query", ["", "?create=false"])
def test_connection_update_rejects_unknown_identifiers(app, client, query):
    original = client.get("/api/catalog").json()
    connection = {**original["connections"][0], "id": "missing"}
    response = client.put("/api/catalog/connection" + query, json=connection)
    assert response.status_code == 404, response.text
    assert response.json()["detail"]["code"] == "connection_missing"
    assert app.state.services.store.get("connection", "missing") is None
    assert client.get("/api/catalog").json() == original


@pytest.mark.parametrize("query", ["", "?create=false"])
def test_connection_switch_filters_parameters_in_every_environment(app, client, query):
    connection = {
        "id": "switch_connector",
        "name": "Switch connector",
        "connector": "s3",
        "environments": {
            env: {"key_id": f"{env}-key", "secret": f"{env}-secret", "region": f"{env}-region"}
            for env in ("dev", "prod")
        },
    }
    assert client.put("/api/catalog/connection?create=true", json=connection).status_code == 200
    public = client.get("/api/catalog").json()
    connection = next(c for c in public["connections"] if c["id"] == "switch_connector")
    connection["connector"] = "local"
    for env, values in connection["environments"].items():
        values["root"] = f"data/{env}"
    expected = {env: {"root": f"data/{env}"} for env in ("dev", "prod")}
    for connector in ("local", "xlsx"):
        connection["connector"] = connector
        response = client.put("/api/catalog/connection" + query, json=connection)
        assert response.status_code == 200, response.text
        saved = app.state.services.store.get("connection", "switch_connector")
        assert saved["environments"] == expected
        connection = next(c for c in response.json()["connections"] if c["id"] == "switch_connector")
        assert connection["environments"] == expected


@pytest.fixture
def executed_projects(app, client):
    worktrees = []
    for name in ("Edited project", "Other project"):
        worktree = client.post("/api/projects", json={"name": name}).json()
        path = f"/api/worktrees/{worktree['id']}"
        snapshot = client.get(path).json()
        bundle = snapshot["bundle"]
        bundle["templates"]["source"] = "-- @kind source\n-- @output result\nSELECT 42 AS value;"
        bundle["templates"]["double"] = (
            "-- @input source\n-- @output result\nSELECT value * 2 AS value FROM {{ source }};"
        )
        bundle["flow"]["nodes"] = [
            {"id": "source", "template": "source", "params": {}},
            {"id": "double", "template": "double", "params": {}},
        ]
        bundle["flow"]["edges"] = [
            {
                "id": "edge",
                "source": "source",
                "sourceHandle": "result",
                "target": "double",
                "targetHandle": "source",
            }
        ]
        response = client.put(path, json={"revision": snapshot["revision"], "bundle": bundle})
        assert response.status_code == 200, response.text
        response = client.post(path + "/runs", json={"environment": "dev"})
        assert response.status_code == 200, response.text
        assert wait_run(app.state.services.store, response.json())["status"] == "success"
        preview = client.get(path + "/preview/double?environment=dev").json()
        assert preview["status"] == "valid"
        assert preview["rows"][0]["values"] == [84]
        worktrees.append(worktree)
    return worktrees


def admin_state(app, client, worktrees):
    """Include unredacted storage and every computed node, not just public metadata."""
    state = {
        kind: app.state.services.store.items(kind)
        for kind in ("connector", "connection", "settings", "access")
    }
    for worktree in worktrees:
        for suffix in ("status", "preview/source", "preview/double"):
            path = f"/api/worktrees/{worktree['id']}/{suffix}"
            response = client.get(path, params={"environment": "dev"})
            assert response.status_code == 200, response.text
            state[path] = response.json()
    return state


def assert_rejected_admin_edit(app, client, worktrees, method, path, body, status):
    before = admin_state(app, client, worktrees)
    response = client.request(method, path, json=body)
    assert response.status_code == status, response.text
    assert admin_state(app, client, worktrees) == before


@pytest.mark.parametrize(
    ("identity", "create", "status"), [("local", "true", 409), ("missing", "false", 404)]
)
def test_rejected_connection_save_intent_preserves_results(
    app, client, executed_projects, identity, create, status
):
    body = {
        "id": identity,
        "name": "Rejected connection",
        "connector": "local",
        "environments": {"dev": {"root": ""}},
    }
    assert_rejected_admin_edit(
        app, client, executed_projects, "PUT", f"/api/catalog/connection?create={create}", body, status
    )


@pytest.mark.parametrize(
    ("kind", "body", "status"),
    [
        ("unknown", {"id": "local"}, 404),
        ("connector", {"id": "../invalid"}, 400),
        ("connector", {"id": "local", "init_sql": "ATTACH"}, 400),
        ("connector", {"id": "local", "init_sql": "SELECT 1"}, 400),
        ("connector", {"id": "local", "parameters": [{"name": "alias"}]}, 400),
        ("connection", {"id": "local", "connector": "missing", "environments": {}}, 400),
        ("connection", {"id": "local", "connector": "local"}, 400),
        ("connector", [], 422),
    ],
)
def test_invalid_catalog_save_preserves_results(app, client, executed_projects, kind, body, status):
    assert_rejected_admin_edit(app, client, executed_projects, "PUT", f"/api/catalog/{kind}", body, status)


def test_invalid_catalog_deletion_preserves_results(app, client, executed_projects):
    assert_rejected_admin_edit(
        app, client, executed_projects, "DELETE", "/api/catalog/unknown/local", None, 404
    )


@pytest.mark.parametrize("body", [[], {}, {"id": "../invalid"}])
def test_invalid_environment_creation_preserves_results(app, client, executed_projects, body):
    assert_rejected_admin_edit(app, client, executed_projects, "POST", "/api/environments", body, 422)


@pytest.mark.parametrize(
    "body", [{}, {"connections": "local"}, {"connections": ["local", "missing"]}, {"connections": [1]}]
)
def test_invalid_connection_grants_preserve_results(app, client, executed_projects, body):
    path = f"/api/projects/{executed_projects[0]['project']}/connections"
    assert_rejected_admin_edit(app, client, executed_projects, "PUT", path, body, 400)


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PUT", "/api/catalog/connector", {"id": "local", "name": "Updated", "init_sql": ""}),
        ("DELETE", "/api/catalog/connection/local", None),
        ("PUT", "/api/projects/{project}/connections", {"connections": []}),
    ],
)
@pytest.mark.parametrize("active", [False, True])
def test_admin_edits_reset_results_only_when_idle(app, client, executed_projects, method, path, body, active):
    worktree = executed_projects[0]
    engine = app.state.services.engine
    path = path.format(project=worktree["project"])
    if active:
        engine.active[worktree["id"]] = {"id": "active"}
        try:
            assert_rejected_admin_edit(app, client, executed_projects, method, path, body, 409)
        finally:
            engine.active.clear()
    else:
        before = admin_state(app, client, executed_projects)
        response = client.request(method, path, json=body)
        assert response.status_code == 200, response.text
        assert any(
            app.state.services.store.items(kind) != before[kind]
            for kind in ("connector", "connection", "settings", "access")
        )
        affected = executed_projects[:1] if path.startswith("/api/projects/") else executed_projects
        for item in affected:
            base = f"/api/worktrees/{item['id']}"
            assert client.get(base + "/status?environment=dev").json()["nodes"] == {}
            assert client.get(base + "/preview/double?environment=dev").status_code == 404
        if len(affected) == 1:
            for suffix in ("status", "preview/source", "preview/double"):
                path = f"/api/worktrees/{executed_projects[1]['id']}/{suffix}"
                assert client.get(path, params={"environment": "dev"}).json() == before[path]


def test_environment_metadata_preserves_connections_and_survives_catalog_reload(app, client, worktree):
    from duckpad.catalog import Catalog

    store = app.state.services.store
    original = client.get("/api/workspace").json()["catalog"]
    assert [e["confirm_before_run"] for e in original["environment_details"]] == [False, True]
    before = client.get(f"/api/worktrees/{worktree}").json()["commit"]
    settings = {"label": " Production ", "color": "#123abc", "confirm_before_run": True}
    response = client.put("/api/environments/prod", json=settings)
    assert response.status_code == 200, response.text
    environment = {**settings, "label": "Production", "id": "prod"}
    assert response.json()["environment_details"][1] == environment
    assert response.json()["connections"] == original["connections"]
    assert client.get(f"/api/worktrees/{worktree}").json()["commit"] == before
    assert Catalog(store).environment("prod") == environment


def test_environment_creation_deletion_and_recreation_do_not_copy_secrets(app, client):
    settings = {"id": "qa", "label": "Quality assurance", "color": "#345678", "confirm_before_run": True}
    response = client.post("/api/environments", json=settings)
    assert response.status_code == 200, response.text
    assert response.json()["connections"][0]["environments"]["qa"] == {}
    assert client.post("/api/environments", json=settings).status_code == 409
    store = app.state.services.store
    connection = store.get("connection", "local")
    connection["environments"]["qa"] = {"root": "private-connection-value"}
    store.put("connection", "local", connection)
    worktree = app.state.services.projects.create("Historical environment")
    store.put(
        "run",
        "historic",
        {
            "project": worktree["project"],
            "worktree": worktree["id"],
            "environment": "qa",
            "status": "success",
            "started": "2026-01-01T00:00:00Z",
        },
    )
    response = client.delete("/api/environments/qa")
    assert response.status_code == 200
    assert "qa" not in response.json()["environments"]
    assert "qa" not in store.get("connection", "local")["environments"]
    assert store.get("run", "historic")["environment"] == "qa"
    assert client.delete("/api/environments/qa").status_code == 404
    assert client.post("/api/environments", json=settings).status_code == 200
    assert store.get("connection", "local")["environments"]["qa"] == {}
    assert client.delete("/api/environments/qa").status_code == 200
    assert client.delete("/api/environments/prod").status_code == 200
    assert client.delete("/api/environments/dev").status_code == 409


@pytest.mark.parametrize(
    "changes",
    [
        {"id": "../escape"},
        {"id": ""},
        {"label": " "},
        {"label": "x" * 81},
        {"color": "red"},
        {"color": "#12345g"},
        {"confirm_before_run": "false"},
    ],
)
def test_invalid_environment_settings_leave_catalog_unchanged(client, changes):
    original = client.get("/api/workspace").json()["catalog"]
    settings = {"id": "qa", "label": "QA", "color": "#abcdef", "confirm_before_run": False}
    response = client.post("/api/environments", json={**settings, **changes})
    assert response.status_code == 422, response.text
    assert client.get("/api/workspace").json()["catalog"] == original


def test_ui_runs_require_current_environment_confirmation_each_time(app, client, worktree):
    from helpers import wait_run

    store, engine = app.state.services.store, app.state.services.engine
    body = {"environment": "prod", "entry_point": "ui"}
    path = f"/api/worktrees/{worktree}/runs"
    for _ in range(2):
        count = len(store.all("run"))
        response = client.post(path, json=body)
        assert response.status_code == 409
        assert response.json()["detail"]["confirmation_required"]["id"] == "prod"
        assert len(store.all("run")) == count
        assert not engine.active
        response = client.post(path, json={**body, "confirmed": True})
        assert response.status_code == 200, response.text
        wait_run(store, response.json())
    # Turning the option on affects already-open clients, even for a node run.
    settings = {"label": "Development", "color": "#abcdef", "confirm_before_run": True}
    assert client.put("/api/environments/dev", json=settings).status_code == 200
    assert (
        client.post(path, json={"environment": "dev", "entry_point": "ui", "node": "source"}).status_code
        == 409
    )
    assert (
        client.put("/api/environments/dev", json={**settings, "confirm_before_run": False}).status_code == 200
    )
    response = client.post(path, json={"environment": "dev", "entry_point": "ui"})
    assert response.status_code == 200
    wait_run(store, response.json())
    # Programmatic clients retain their explicit, non-interactive launch contract.
    response = client.post(path, json={"environment": "prod"})
    assert response.status_code == 200
    wait_run(store, response.json())


def test_deleting_environment_during_execution_keeps_configuration(app, client, worktree):
    engine = app.state.services.engine
    original = client.get("/api/workspace").json()["catalog"]
    engine.active[worktree] = {"id": "active"}
    try:
        response = client.delete("/api/environments/prod")
        assert response.status_code == 409
        assert client.get("/api/workspace").json()["catalog"] == original
    finally:
        engine.active.clear()


def test_library_lists_components_without_a_name(client, worktree):
    snapshot = client.get(f"/api/worktrees/{worktree}").json()
    files = {**snapshot["files"], "components/unnamed.json": '{"nodes": [], "edges": []}\n'}
    saved = client.put(f"/api/worktrees/{worktree}", json={"revision": snapshot["revision"], "files": files})
    assert saved.status_code == 200, saved.text
    items = client.get("/api/library").json()
    assert {"kind": "components", "id": "unnamed", "name": "unnamed"}.items() <= next(
        item for item in items if item["id"] == "unnamed"
    ).items()


def test_unknown_api_paths_return_a_json_not_found(client):
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.json()["error"] == "Not found"


def test_logout_revokes_a_bearer_token(app):
    with TestClient(app) as client:
        login = client.post("/api/login", json={"password": app.state.auth.initial_password})
        client.cookies.clear()
        headers = {"Authorization": f"Bearer {login.cookies[SESSION_COOKIE]}"}
        assert client.get("/api/session", headers=headers).status_code == 200
        assert client.post("/api/logout", headers=headers).status_code == 200
        assert client.get("/api/session", headers=headers).status_code == 401


def test_project_zip_contains_only_saved_declarative_files(app, client, worktree):
    snapshot = client.get(f"/api/worktrees/{worktree}").json()
    path = Path(snapshot["worktree"]["path"])
    (path / ".env").write_text("PRIVATE_VALUE=not-for-export\n")
    (path / "data").mkdir()
    (path / "data" / "input.csv").write_text("id\n1\n")
    (path / "notes.txt").write_text("Unrelated local file")
    # An external edit still being written must not leak into a saved download.
    (path / "flow.json").write_text("{")
    response = client.get(f"/api/worktrees/{worktree}/archive.zip")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"] == 'attachment; filename="duckpad-project.zip"'
    assert response.headers["cache-control"] == "no-store"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(snapshot["files"])
        assert {name: archive.read(name).decode("utf-8") for name in archive.namelist()} == snapshot["files"]


def test_project_zip_exports_selected_branch_and_invalid_saved_content(client, worktree):
    branch = client.post(f"/api/worktrees/{worktree}/branches", json={"name": "code-export"}).json()["id"]
    snapshot = client.get(f"/api/worktrees/{branch}").json()
    files = {
        **snapshot["files"],
        "flow.json": "{",
        "templates/unicode.sql": "SELECT '東京';\n",
        "README.md": "# Exported context\n\nMarkdown travels with the project.\n",
        "pyproject.toml": snapshot["files"]["pyproject.toml"] + "\n# Project dependencies\n",
    }
    files["components/report.json"] = '{"nodes": [], "edges": []}\n'
    saved = client.put(f"/api/worktrees/{branch}", json={"revision": snapshot["revision"], "files": files})
    assert saved.status_code == 200, saved.text
    assert saved.json()["diagnostics"]
    response = client.get(f"/api/worktrees/{branch}/archive.zip")
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert {name: archive.read(name).decode("utf-8") for name in archive.namelist()} == files
        assert tomllib.loads(archive.read("pyproject.toml").decode())["project"]["dependencies"]
        assert "project" not in json.loads(archive.read("documentation.json"))
    main = client.get(f"/api/worktrees/{worktree}/archive.zip")
    with zipfile.ZipFile(io.BytesIO(main.content)) as archive:
        assert archive.read("flow.json").decode() == snapshot["files"]["flow.json"]
        assert "templates/unicode.sql" not in archive.namelist()
    assert client.get("/api/worktrees/missing/archive.zip").status_code == 404
    client.cookies.clear()
    assert client.get(f"/api/worktrees/{branch}/archive.zip").status_code == 401


def project_zip(files, prefix=""):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(prefix + name, content)
    return output.getvalue()


def import_zip(client, data, name=None):
    return client.post(
        "/api/projects/import",
        files={"file": ("project.zip", data, "application/zip")},
        data={} if name is None else {"name": name},
    )


def test_downloaded_zip_imports_as_an_independent_project(app, client, worktree):
    snapshot = client.get(f"/api/worktrees/{worktree}").json()
    flow = json.loads(snapshot["files"]["flow.json"])
    flow["nodes"] = [
        {"id": "city", "template": "city", "label": "City", "params": {}, "position": {"x": 0, "y": 0}}
    ]
    files = {
        **snapshot["files"],
        "flow.json": json.dumps(flow),
        "templates/city.sql": "-- @label City\n-- @output result\nSELECT '東京' AS city;\n",
        "README.md": "# Imported context\n\nMarkdown travels with the project.\n",
    }
    saved = client.put(f"/api/worktrees/{worktree}", json={"revision": snapshot["revision"], "files": files})
    assert saved.status_code == 200, saved.text
    source = saved.json()
    response = import_zip(client, client.get(f"/api/worktrees/{worktree}/archive.zip").content)
    assert response.status_code == 200, response.text
    imported = response.json()
    assert imported["project"] != source["worktree"]["project"]
    assert imported["warnings"] == {"connections": [], "files": []}
    copy = client.get(f"/api/worktrees/{imported['id']}").json()
    assert copy["diagnostics"] == []
    assert copy["role"] == "admin"
    assert copy["bundle"]["flow"] == {**source["bundle"]["flow"], "id": imported["project"]}
    assert {name: text for name, text in copy["files"].items() if name != "flow.json"} == {
        name: text for name, text in source["files"].items() if name != "flow.json"
    }
    project = next(
        p for p in client.get("/api/workspace").json()["projects"] if p["id"] == imported["project"]
    )
    assert project["name"] == "API"
    settings = client.get(f"/api/projects/{imported['project']}/settings").json()
    assert settings["connections"] == ["local"]
    assert [member["role"] for member in settings["members"]] == ["admin"]
    projects = app.state.services.projects
    assert projects.git(imported["path"], "log", "--format=%s") == "feat(project): import API"
    assert client.get(f"/api/worktrees/{worktree}").json()["commit"] == source["commit"]


def test_import_reads_a_nested_project_folder_and_ignores_local_files(app, client, worktree):
    files = client.get(f"/api/worktrees/{worktree}").json()["files"]
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("api-main/", "")
        for name, content in {
            **files,
            ".git/config": "[core]\n",
            ".env": "PRIVATE_VALUE=not-for-import\n",
            "data/input.csv": "id\n1\n",
            "notes.txt": "Unrelated local file",
            "templates/notes.txt": "Not a template",
        }.items():
            archive.writestr("api-main/" + name, content)
        archive.writestr("__MACOSX/api-main/._flow.json", b"\x00\x05\x16\x07")
    response = import_zip(client, output.getvalue(), "  Imported copy  ")
    assert response.status_code == 200, response.text
    imported = response.json()
    copy = client.get(f"/api/worktrees/{imported['id']}").json()
    assert copy["bundle"]["flow"]["name"] == "Imported copy"
    assert set(copy["files"]) == set(files)
    path = Path(imported["path"])
    projects = app.state.services.projects
    assert set(projects.git(path, "ls-files").splitlines()) == {*files, ".gitignore"}
    for name in (".env", "data", "notes.txt", "templates/notes.txt", "__MACOSX"):
        assert not (path / name).exists()


def test_import_reports_what_the_archive_cannot_carry(app, client, worktree, tmp_path):
    example = client.post("/api/example", json={"name": "Revenue lab"}).json()
    response = import_zip(client, client.get(f"/api/worktrees/{example['id']}/archive.zip").content)
    assert response.status_code == 200, response.text
    assert response.json()["warnings"] == {"connections": ["sample_" + example["project"]], "files": []}

    files = client.get(f"/api/worktrees/{worktree}").json()["files"]
    uploaded = str(tmp_path / "instance" / "resources" / "project_elsewhere" / "orders.csv")

    def source(identity, label, **params):
        return {"id": identity, "template": "load_csv", "label": label, "params": params}

    flow = json.loads(files["flow.json"])
    flow["nodes"] = [
        source("upload", "Uploaded orders", connection="local", file=uploaded),
        source("remote", "Remote orders", connection="warehouse", file="s3://bucket/orders.csv"),
        {"id": "packaged", "component": "sources", "label": "Packaged sources", "params": {}},
    ]
    component = {"nodes": [source("inner", "Inner", connection="local", file=uploaded)], "edges": []}
    data = project_zip(
        {**files, "flow.json": json.dumps(flow), "components/sources.json": json.dumps(component)}
    )
    response = import_zip(client, data)
    assert response.status_code == 200, response.text
    assert response.json()["warnings"] == {
        "connections": ["warehouse"],
        "files": ["Packaged sources", "Uploaded orders"],
    }


@pytest.mark.parametrize(
    "path",
    [
        "/srv/duckpad/resources/project_old/orders.csv",
        "C:\\Duckpad\\resources\\project_old\\orders.csv",
        "D:/exports/orders.csv",
        "\\\\files.example.test\\share\\orders.csv",
    ],
)
def test_import_reports_absolute_files_from_any_operating_system(client, worktree, path):
    files = client.get(f"/api/worktrees/{worktree}").json()["files"]
    flow = json.loads(files["flow.json"])
    flow["nodes"] = [
        {"id": "orders", "template": "load_csv", "label": "Orders", "params": {"file": path}},
        {"id": "relative", "template": "load_csv", "label": "Relative", "params": {"file": "orders.csv"}},
    ]
    response = import_zip(client, project_zip({**files, "flow.json": json.dumps(flow)}))
    assert response.status_code == 200, response.text
    assert response.json()["warnings"]["files"] == ["Orders"]


@pytest.mark.parametrize(
    ("entries", "complete", "error"),
    [
        (None, True, "Choose a readable ZIP archive of a Duckpad project"),
        ({"README.md": "# No flow\n"}, True, "The archive must contain one Duckpad project"),
        (
            {"first/flow.json": "{}", "second/flow.json": "{}"},
            True,
            "The archive must contain one Duckpad project",
        ),
        ({"flow.json": "{"}, False, "flow.json is not valid JSON: Expecting property name"),
        ({"components/report.json": "[]"}, False, "components/report.json must contain a JSON object"),
        ({"templates/broken.sql": b"\xff"}, False, "templates/broken.sql is not valid UTF-8 text"),
        (
            {"documentation.json": '{"project": 123}', "README.md": None},
            False,
            'documentation.json: "project" must be Markdown text',
        ),
    ],
)
def test_invalid_archives_do_not_create_projects(app, client, worktree, entries, complete, error):
    files = {} if complete else client.get(f"/api/worktrees/{worktree}").json()["files"]
    # A None entry removes that file from the archive.
    data = (
        b"not a zip"
        if entries is None
        else project_zip({k: v for k, v in {**files, **entries}.items() if v is not None})
    )
    before = client.get("/api/workspace").json()["projects"]
    response = import_zip(client, data, "Rejected")
    assert response.status_code == 422, response.text
    assert response.json()["error"].startswith(error)
    assert client.get("/api/workspace").json()["projects"] == before
    assert len(list((app.state.services.store.home / "projects").iterdir())) == len(before)


def test_failed_import_leaves_no_project_folder(app, client, worktree, monkeypatch):
    data = client.get(f"/api/worktrees/{worktree}/archive.zip").content
    projects = app.state.services.projects
    before = set((projects.store.home / "projects").iterdir())

    def fail(path, message):
        raise Problem("Cannot commit the imported project", 500)

    monkeypatch.setattr(projects, "commit", fail)
    response = import_zip(client, data)
    assert response.status_code == 500
    assert response.json()["error"] == "Cannot commit the imported project"
    assert len(client.get("/api/workspace").json()["projects"]) == 1
    assert set((projects.store.home / "projects").iterdir()) == before


def test_import_rejects_duplicate_and_oversized_archives(app, client, worktree, monkeypatch):
    files = client.get(f"/api/worktrees/{worktree}").json()["files"]
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
        with pytest.warns(UserWarning, match="Duplicate name"):
            archive.writestr("flow.json", files["flow.json"])
    response = import_zip(client, output.getvalue())
    assert response.status_code == 422
    assert response.json()["error"] == "The archive contains flow.json more than once"
    expanded = project_zip({**files, "README.md": "A" * 2_000_000})
    monkeypatch.setattr("duckpad.archive.MAX_PROJECT_BYTES", 1_000_000)
    response = import_zip(client, expanded)
    assert response.status_code == 413
    assert response.json()["error"] == "Extracted project files are limited to 64 MiB"
    monkeypatch.setattr("duckpad.archive.MAX_ARCHIVE_BYTES", len(expanded) - 1)
    response = import_zip(client, expanded)
    assert response.status_code == 413
    assert response.json()["error"] == "Project archives are limited to 16 MiB"
    assert len(client.get("/api/workspace").json()["projects"]) == 1
