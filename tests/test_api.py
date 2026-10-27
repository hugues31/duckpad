import io
import tomllib
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import duckpad
from duckpad.app import SESSION_COOKIE, create_app


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


def test_session_reports_the_packaged_version(client):
    pyproject = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8"))
    assert (
        client.get("/api/session").json()["version"] == duckpad.__version__ == pyproject["project"]["version"]
    )


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
    assert client.get("/api/worktrees/missing/status").status_code == 404
    assert client.get(f"/api/worktrees/{worktree}/status?environment=missing").status_code == 404
    assert client.get(f"/api/worktrees/{worktree}/status?environment=prod").status_code == 200


def test_environment_names_are_validated_and_normalized(client):
    assert client.put("/api/environments", json=["dev", "../../escape"]).status_code == 400
    assert client.put("/api/environments", json=[]).status_code == 400
    response = client.put("/api/environments", json=[" dev ", "prod", "dev", "qa-1"])
    assert response.json()["environments"] == ["dev", "prod", "qa-1"]


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
    # Older clients can still send environment identifiers without losing metadata.
    assert client.put("/api/environments", json=["dev", "prod"]).status_code == 200
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
    store.put("run", "historic", {"environment": "qa"})
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
    assert client.post(path, json={"entry_point": "ui", "node": "source"}).status_code == 409
    assert (
        client.put("/api/environments/dev", json={**settings, "confirm_before_run": False}).status_code == 200
    )
    response = client.post(path, json={"entry_point": "ui"})
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
    files = {**snapshot["files"], "flow.json": "{", "templates/unicode.sql": "SELECT '東京';\n"}
    files["components/report.json"] = '{"nodes": [], "edges": []}\n'
    saved = client.put(f"/api/worktrees/{branch}", json={"revision": snapshot["revision"], "files": files})
    assert saved.status_code == 200, saved.text
    assert saved.json()["diagnostics"]
    response = client.get(f"/api/worktrees/{branch}/archive.zip")
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert {name: archive.read(name).decode("utf-8") for name in archive.namelist()} == files
    main = client.get(f"/api/worktrees/{worktree}/archive.zip")
    with zipfile.ZipFile(io.BytesIO(main.content)) as archive:
        assert archive.read("flow.json").decode() == snapshot["files"]["flow.json"]
        assert "templates/unicode.sql" not in archive.namelist()
    assert client.get("/api/worktrees/missing/archive.zip").status_code == 404
    client.cookies.clear()
    assert client.get(f"/api/worktrees/{branch}/archive.zip").status_code == 401
