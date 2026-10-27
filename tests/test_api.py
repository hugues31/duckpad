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
