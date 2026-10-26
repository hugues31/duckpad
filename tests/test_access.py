"""Authorization, migration, revocation and SQL isolation acceptance tests."""

import hashlib
import secrets
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from conftest import wait_run
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.auth import Auth
from duckpad.projects import Projects
from duckpad.store import Store
from duckpad.util import Problem

PASSWORD = "individual-test-password"


@pytest.fixture
def instance(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert (
            client.post("/api/login", json={"password": app.state.auth.initial_password}).status_code == 200
        )
        yield app, client


def account(app, name, role="member"):
    user = app.state.auth.create_user(name, PASSWORD, role)
    token = app.state.auth.login(name, PASSWORD, peer=name)
    return user, {"authorization": "Bearer " + token}


def request(client, headers, method, path, **kwargs):
    # A bearer token must be tested without the administrator's session cookie.
    return client.request(method, "/api" + path, headers={**headers, "cookie": ""}, **kwargs)


def own_project(app, client, headers, name="Private"):
    response = request(client, headers, "POST", "/projects", json={"name": name})
    assert response.status_code == 200
    return response.json()


def test_legacy_password_and_projects_migrate_once(tmp_path):
    home = tmp_path / "old"
    store = Store(home)
    salt = secrets.token_hex(32)
    store.put("auth", "admin", {"salt": salt, "hash": Auth.hash(PASSWORD, salt)})
    store.put("session", hashlib.sha256(b"legacy").hexdigest(), {"expires": 9999999999})
    worktree = Projects(store).create("Legacy")
    store.close()
    app = create_app(home, watch=False)
    with TestClient(app) as client:
        assert app.state.auth.initial_password is None
        assert client.get("/api/session", headers={"authorization": "Bearer legacy"}).status_code == 401
        assert client.post("/api/login", json={"password": PASSWORD}).status_code == 200
        assert (
            client.get("/api/projects/" + worktree["project"] + "/settings").json()["members"][0]["role"]
            == "admin"
        )
        assert app.state.auth.store.get("auth", "admin") is None


def test_private_discovery_and_all_direct_resource_routes(instance):
    app, client = instance
    owner, owner_headers = account(app, "owner")
    _, outsider = account(app, "outsider")
    worktree = own_project(app, client, owner_headers)
    store, projects, _, engine = app.state.services
    branch = projects.branch(worktree["id"], "private-branch")
    run = engine.launch(worktree["id"], "dev")
    wait_run(store, run)
    store.put("conflict", "private-conflict", {"id": "private-conflict", "worktree": worktree["id"]})
    workspace = request(client, outsider, "GET", "/workspace").json()
    assert workspace["projects"] == workspace["worktrees"] == []
    assert request(client, outsider, "GET", "/library").json() == []
    assert request(client, outsider, "GET", "/runs").json() == []
    for method, path in [
        ("GET", f"/worktrees/{worktree['id']}"),
        ("GET", f"/worktrees/{branch['id']}"),
        ("GET", f"/worktrees/{worktree['id']}/status"),
        ("GET", f"/worktrees/{worktree['id']}/history"),
        ("GET", f"/worktrees/{worktree['id']}/diff/HEAD"),
        ("GET", f"/worktrees/{worktree['id']}/compile/source"),
        ("GET", f"/worktrees/{worktree['id']}/preview/source"),
        ("GET", f"/worktrees/{worktree['id']}/generations/private"),
        ("GET", f"/worktrees/{worktree['id']}/merge"),
        ("GET", f"/projects/{worktree['project']}/settings"),
        ("GET", f"/runs/{run['id']}"),
        ("GET", f"/runs?worktree={worktree['id']}"),
        ("POST", f"/runs/{run['id']}/cancel"),
        ("POST", "/conflicts/private-conflict/resolve"),
        ("POST", f"/worktrees/{worktree['id']}/lineage"),
    ]:
        response = request(client, outsider, method, path, **({"json": {}} if method == "POST" else {}))
        assert response.status_code == 404, (path, response.text)
    assert client.get(f"/worktrees/{worktree['id']}").status_code == 200  # SPA remains public.
    assert client.get(f"/api/worktrees/{worktree['id']}").status_code == 200
    assert (
        request(client, owner_headers, "GET", f"/projects/{worktree['project']}/settings").json()["members"][
            0
        ]["id"]
        == owner["id"]
    )


@pytest.mark.parametrize("role", ["reader", "editor", "admin"])
def test_project_role_matrix_and_cross_project_import(instance, role):
    app, client = instance
    owner, owner_headers = account(app, "owner")
    participant, headers = account(app, "participant")
    target = own_project(app, client, owner_headers)
    source = own_project(app, client, owner_headers, "Source")
    project, worktree = target["project"], target["id"]
    app.state.access.member(project, participant["id"], role)
    snapshot = request(client, headers, "GET", f"/worktrees/{worktree}").json()
    assert snapshot["role"] == role
    assert request(
        client,
        headers,
        "PUT",
        f"/worktrees/{worktree}",
        json={"revision": snapshot["revision"], "bundle": snapshot["bundle"]},
    ).status_code == (403 if role == "reader" else 200)
    for suffix in ("branches", "group", "import", "merge", "runs", "uploads"):
        if role == "reader":
            assert (
                request(client, headers, "POST", f"/worktrees/{worktree}/{suffix}", json={}).status_code
                == 403
            )
    if role != "reader":
        response = request(
            client,
            headers,
            "POST",
            f"/worktrees/{worktree}/import",
            json={
                "source_worktree": source["id"],
                "kind": "templates",
                "id": "sql",
                "revision": snapshot["revision"],
            },
        )
        assert response.status_code == 404
    response = request(
        client, headers, "PUT", f"/projects/{project}/members/{owner['id']}", json={"role": "admin"}
    )
    assert response.status_code == (200 if role == "admin" else 403)
    assert request(client, headers, "DELETE", f"/projects/{project}").status_code == (
        200 if role == "admin" else 403
    )
    for method, path, data in [
        ("GET", "/users", None),
        ("GET", "/catalog", None),
        ("PUT", "/identity", {}),
        ("PUT", "/environments", ["dev"]),
        ("PATCH", "/users/admin", {"role": "member"}),
    ]:
        assert (
            request(client, headers, method, path, **({"json": data} if data is not None else {})).status_code
            == 403
        )


def test_revocation_deactivation_password_reset_and_last_admin(instance):
    app, client = instance
    owner, owner_headers = account(app, "owner")
    user, headers = account(app, "participant")
    worktree = own_project(app, client, owner_headers)
    project = worktree["project"]
    app.state.access.member(project, user["id"], "reader")
    assert request(client, headers, "GET", f"/worktrees/{worktree['id']}").status_code == 200
    app.state.access.member(project, user["id"], None)
    assert request(client, headers, "GET", f"/worktrees/{worktree['id']}").status_code == 404
    assert client.patch(f"/api/users/{owner['id']}", json={"active": False}).status_code == 409
    assert client.patch("/api/users/admin", json={"role": "member"}).status_code == 409
    assert (
        request(client, owner_headers, "DELETE", f"/projects/{project}/members/{owner['id']}").status_code
        == 409
    )
    assert client.patch(f"/api/users/{user['id']}", json={"active": False}).status_code == 200
    assert request(client, headers, "GET", "/session").status_code == 401
    assert client.patch(f"/api/users/{user['id']}", json={"active": True}).status_code == 200
    # Reactivation must not resurrect sessions from before deactivation.
    assert request(client, headers, "GET", "/session").status_code == 401
    token = app.state.auth.login(user["username"], PASSWORD)
    headers = {"authorization": "Bearer " + token}
    assert client.patch(f"/api/users/{user['id']}", json={"password": PASSWORD + "-new"}).status_code == 200
    assert request(client, headers, "GET", "/session").status_code == 401


def test_last_project_admin_concurrent_changes(instance):
    app, client = instance
    first, first_headers = account(app, "first")
    second, _ = account(app, "second")
    worktree = own_project(app, client, first_headers)
    app.state.access.member(worktree["project"], second["id"], "admin")

    def demote(identity):
        try:
            app.state.access.member(worktree["project"], identity, "reader")
            return 200
        except Problem as error:
            return error.status

    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(demote, [first["id"], second["id"]])) == [200, 409]


def test_reader_results_and_no_recalculation(instance):
    app, client = instance
    user, headers = account(app, "reader")
    worktree = client.post("/api/example").json()
    app.state.access.member(worktree["project"], user["id"], "reader")
    store, _, _, engine = app.state.services
    assert request(client, headers, "GET", f"/worktrees/{worktree['id']}/status").status_code == 200
    assert engine.context(worktree["id"], "dev").db is None
    run = client.post(f"/api/worktrees/{worktree['id']}/runs", json={}).json()
    assert wait_run(store, run, timeout=30)["status"] == "success"
    response = request(client, headers, "GET", f"/worktrees/{worktree['id']}/preview/orders").json()
    assert response["count"] == 120
    assert request(client, headers, "POST", f"/runs/{run['id']}/cancel", json={}).status_code == 403
    assert len(store.all("run")) == 1
    row = response["rows"][0]
    assert row


def test_sql_worker_blocks_metadata_other_projects_and_symlinks(instance, tmp_path):
    app, client = instance
    _, headers = account(app, "author")
    worktree = own_project(app, client, headers)
    other = client.post("/api/projects", json={"name": "Other"}).json()
    store, projects, _, engine = app.state.services
    folder = store.home / "resources" / worktree["project"]
    folder.mkdir(parents=True)
    (folder / "allowed.csv").write_text("value\n42\n")
    (folder / "escape.csv").symlink_to(store.home / "instance.sqlite")
    for path, success in [
        (folder / "allowed.csv", True),
        (store.home / "instance.sqlite", False),
        (folder / "escape.csv", False),
        (Path(other["path"]) / "flow.json", False),
        (folder / ".." / ".." / "instance.sqlite", False),
    ]:
        snapshot = projects.snapshot(worktree["id"])
        bundle = snapshot["bundle"]
        bundle["flow"]["nodes"] = [
            {
                "id": "source",
                "template": "load_csv",
                "params": {"file": str(path)},
                "position": {"x": 0, "y": 0},
            }
        ]
        from duckpad.projects import bundle_to_files

        projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
        run = engine.launch(worktree["id"], "dev")
        result = wait_run(store, run)
        assert (result["status"] == "success") is success, result
    cursor = engine.context(worktree["id"], "dev").db.cursor()
    with pytest.raises(Exception, match="configuration|locked"):
        cursor.execute("SET enable_external_access = true")
    with pytest.raises(Exception, match="Permission|disabled|denied"):
        cursor.execute("COPY (SELECT 1) TO '" + str(store.home / "overwrite.csv") + "'")
    cursor.close()
    # An editor cannot grant a connection by editing the project bundle.
    app.state.access.grant_connections(worktree["project"], [])
    engine.reset_project(worktree["project"])
    with pytest.raises(Problem, match="not authorized"):
        engine.compile(worktree["id"], "dev", "source")


def test_account_validation_and_no_credential_disclosure(instance):
    _, client = instance
    assert client.post("/api/users", json={"username": "new", "password": "short"}).status_code == 400
    assert (
        client.post("/api/users", json={"username": "new", "password": PASSWORD, "role": "owner"}).status_code
        == 400
    )
    created = client.post("/api/users", json={"username": "new", "password": PASSWORD}).json()
    assert set(created) == {"id", "username", "role", "active"}
    assert client.post("/api/users", json={"username": "NEW", "password": PASSWORD}).status_code == 409
    assert PASSWORD not in client.get("/api/users").text


def test_sql_worker_cancels_and_recovers_after_process_exit(instance):
    import time

    from duckpad.projects import bundle_to_files

    app, client = instance
    _, headers = account(app, "runner")
    worktree = own_project(app, client, headers)
    store, projects, _, engine = app.state.services
    snapshot = projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["templates"]["slow"] = (
        "-- @kind source\n-- @output result\nSELECT SUM(random()) AS value FROM range(10000000000);"
    )
    bundle["flow"]["nodes"] = [{"id": "source", "template": "slow", "params": {}}]
    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    run = engine.launch(worktree["id"], "dev")
    deadline = time.monotonic() + 10
    while store.get("run", run["id"])["nodes"]["source"]["status"] != "running":
        assert time.monotonic() < deadline
        time.sleep(0.01)
    engine.cancel(run["id"])
    assert wait_run(store, run)["status"] == "canceled"
    database = engine.context(worktree["id"], "dev").db
    database.process.kill()
    database.process.wait()
    database.reader.join(timeout=5)
    snapshot = projects.snapshot(worktree["id"])
    bundle["templates"]["slow"] = "-- @kind source\n-- @output result\nSELECT 42 AS value;"
    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    assert wait_run(store, engine.launch(worktree["id"], "dev"))["status"] == "success"
    assert engine.context(worktree["id"], "dev").db.process.pid != database.process.pid
    database.close()


def test_read_only_connection_root_cannot_be_written_through_another_connection(instance, tmp_path):
    app, client = instance
    _, headers = account(app, "author")
    worktree = own_project(app, client, headers)
    root = tmp_path / "read-only-source"
    root.mkdir()
    (root / "input.csv").write_text("value\n42\n")
    _, _, catalog, engine = app.state.services
    catalog.save(
        "connector",
        {
            "id": "read_only",
            "parameters": [{"name": "root", "type": "text"}],
            "capabilities": ["read"],
            "init_sql": "",
        },
    )
    catalog.save(
        "connection",
        {
            "id": "source_files",
            "name": "Source files",
            "connector": "read_only",
            "environments": {"dev": {"root": str(root)}},
        },
    )
    app.state.access.grant_connections(worktree["project"], ["local", "source_files"])
    cursor = engine.context(worktree["id"], "dev", create=True).db.cursor()
    assert cursor.execute("SELECT * FROM read_csv('" + str(root / "input.csv") + "')").fetchall() == [(42,)]
    with pytest.raises(Exception, match="Permission|denied"):
        cursor.execute("COPY (SELECT 1) TO '" + str(root / "output.csv") + "'")
    assert not (root / "output.csv").exists()
    cursor.close()


def test_sql_worker_cancellation_stays_armed_between_queries(instance):
    import duckdb

    app, client = instance
    _, headers = account(app, "cancel-gap")
    worktree = own_project(app, client, headers)
    engine = app.state.services[3]
    cursor = engine.context(worktree["id"], "dev", create=True).db.cursor()
    assert cursor.execute("SELECT 1").fetchone() == (1,)
    cursor.interrupt()
    with pytest.raises(duckdb.InterruptException, match="canceled"):
        cursor.execute("SELECT 2")
    cursor.close()
