"""Authorization, revocation and SQL isolation acceptance tests."""

import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from helpers import wait_run

from duckpad.app import create_app
from duckpad.util import Problem

PASSWORD = "individual-test-password"
PUBLIC, SESSION, READER, EDITOR, PROJECT_ADMIN, INSTANCE_ADMIN = range(6)
# The minimum access level of every API route. Classify each new route here.
ROUTE_ACCESS = {
    PUBLIC: [
        "POST /api/login",
        "GET /api/oidc/provider",
        "GET /api/oidc/login",
        "GET /api/oidc/callback",
    ],
    SESSION: [
        "POST /api/logout",
        "GET /api/session",
        "GET /api/search",
        "GET /api/workspace",
        "GET /api/library",
        "GET /api/runs",
        "POST /api/projects",
        "POST /api/projects/import",
        "POST /api/example",
        "POST /api/password",
        "GET /api/api-tokens",
        "POST /api/api-tokens",
        "DELETE /api/api-tokens/{token}",
        "GET /api/ssh-key",
        "POST /api/ssh-key",
        "DELETE /api/ssh-key",
    ],
    READER: [
        "GET /api/projects/{project}/settings",
        "GET /api/worktrees/{worktree}",
        "GET /api/worktrees/{worktree}/archive.zip",
        "GET /api/worktrees/{worktree}/git/history",
        "GET /api/worktrees/{worktree}/git/tags",
        "GET /api/worktrees/{worktree}/git/compare",
        "GET /api/worktrees/{worktree}/git/branches",
        "GET /api/worktrees/{worktree}/git/remote",
        "GET /api/worktrees/{worktree}/status",
        "GET /api/worktrees/{worktree}/compile/{node}",
        "GET /api/worktrees/{worktree}/exports/{node}",
        "GET /api/worktrees/{worktree}/exports/{node}/download",
        "GET /api/worktrees/{worktree}/preview/{node}",
        "GET /api/worktrees/{worktree}/test-history/{node}",
        "GET /api/worktrees/{worktree}/generations/{identity}",
        "GET /api/worktrees/{worktree}/variables/scope",
        "GET /api/worktrees/{worktree}/extensions",
        "POST /api/worktrees/{worktree}/lineage",
        "GET /api/runs/{run}",
    ],
    EDITOR: [
        "PUT /api/worktrees/{worktree}",
        "POST /api/worktrees/{worktree}/extensions/check",
        "POST /api/worktrees/{worktree}/uploads",
        "POST /api/worktrees/{worktree}/git/open",
        "POST /api/worktrees/{worktree}/git/tags",
        "POST /api/worktrees/{worktree}/git/cleanup",
        "POST /api/worktrees/{worktree}/git/reviews",
        "POST /api/worktrees/{worktree}/git/reviews/{review}",
        "POST /api/worktrees/{worktree}/git/reviews/{review}/apply",
        "POST /api/worktrees/{worktree}/git/consent",
        "POST /api/worktrees/{worktree}/git/fetch",
        "POST /api/worktrees/{worktree}/git/pull",
        "POST /api/worktrees/{worktree}/git/push",
        "POST /api/worktrees/{worktree}/branches",
        "POST /api/worktrees/{worktree}/group",
        "POST /api/worktrees/{worktree}/import",
        "POST /api/worktrees/{worktree}/variables/{name}/rename",
        "POST /api/worktrees/{worktree}/runs",
        "POST /api/conflicts/{conflict}/resolve",
        "POST /api/runs/{run}/cancel",
    ],
    PROJECT_ADMIN: [
        "PUT /api/projects/{project}/members/{identity}",
        "DELETE /api/projects/{project}/members/{identity}",
        "DELETE /api/projects/{project}",
        "PUT /api/worktrees/{worktree}/git/remote",
    ],
    INSTANCE_ADMIN: [
        "GET /api/sso",
        "PUT /api/sso",
        "GET /api/resources",
        "GET /api/extensions/settings",
        "PUT /api/extensions/settings",
        "GET /api/extensions/runtime",
        "POST /api/extensions/import",
        "GET /api/catalog",
        "PUT /api/catalog/{kind}",
        "DELETE /api/catalog/{kind}/{identity}",
        "POST /api/environments",
        "PUT /api/environments/{identity}",
        "DELETE /api/environments/{identity}",
        "GET /api/users",
        "POST /api/users",
        "PATCH /api/users/{identity}",
        "GET /api/users/{identity}/api-tokens",
        "POST /api/users/{identity}/api-tokens",
        "DELETE /api/users/{identity}/api-tokens/{token}",
        "PUT /api/projects/{project}/connections",
        "GET /api/git-hosts",
        "PUT /api/git-hosts",
    ],
}
AUTHORIZATION_ERRORS = {
    "Authentication required",
    "Project not found",
    "Worktree not found",
    "Resource not found",
    "Your project role does not allow this action",
    "Instance administrator access required",
}


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


def test_accounts_memberships_and_grants_survive_restart(tmp_path):
    home = tmp_path / "instance"
    app = create_app(home, watch=False)
    with TestClient(app) as client:
        password = app.state.auth.initial_password
        assert client.post("/api/login", json={"password": password}).status_code == 200
        owner, headers = account(app, "owner")
        worktree = own_project(app, client, headers)
        settings_path = "/projects/" + worktree["project"] + "/settings"
        settings = request(client, headers, "GET", settings_path).json()
        assert settings["members"][0]["id"] == owner["id"]
        assert settings["connections"] == ["local"]
    app = create_app(home, watch=False)
    with TestClient(app) as client:
        assert app.state.auth.initial_password is None
        assert client.post("/api/login", json={"password": password}).status_code == 200
        assert request(client, headers, "GET", settings_path).json() == settings


def test_projects_are_created_without_the_default_local_connection(instance):
    app, client = instance
    owner, headers = account(app, "owner")
    assert client.delete("/api/catalog/connection/local").status_code == 200
    project = own_project(app, client, headers)["project"]
    settings = request(client, headers, "GET", f"/projects/{project}/settings").json()
    assert settings["connections"] == [] and settings["members"][0]["id"] == owner["id"]
    example = request(client, headers, "POST", "/example", json={"name": "Sample"})
    assert example.status_code == 200, example.text
    project = example.json()["project"]
    settings = request(client, headers, "GET", f"/projects/{project}/settings").json()
    assert settings["connections"] == ["sample_" + project]


@pytest.mark.parametrize("kind", ["project", "example"])
def test_a_project_without_its_access_records_leaves_nothing_behind(instance, monkeypatch, kind):
    app, client = instance
    services = app.state.services
    _, headers = account(app, "owner")

    def refuse(*args):
        raise Problem("Simulated access failure", 409)

    monkeypatch.setattr(services.engine.access, "own", refuse)
    route = "/projects" if kind == "project" else "/example"
    response = request(client, headers, "POST", route, json={"name": "Orphan"})
    assert response.status_code == 409 and response.json()["error"] == "Simulated access failure"
    home = services.store.home
    assert services.store.all("project") == [] and services.store.all("worktree") == []
    assert [c["id"] for c in services.store.all("connection")] == ["local"]
    assert not list(home.glob("projects/*")) and not list(home.glob("resources/*"))


def test_private_discovery_and_all_direct_resource_routes(instance):
    app, client = instance
    owner, owner_headers = account(app, "owner")
    _, outsider = account(app, "outsider")
    worktree = own_project(app, client, owner_headers)
    services = app.state.services
    store, projects, engine = services.store, services.projects, services.engine
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
        ("GET", f"/worktrees/{worktree['id']}/git/history"),
        ("GET", f"/worktrees/{worktree['id']}/archive.zip"),
        ("GET", f"/worktrees/{worktree['id']}/git/compare?a=HEAD&b=HEAD"),
        ("GET", f"/worktrees/{worktree['id']}/compile/source"),
        ("GET", f"/worktrees/{worktree['id']}/preview/source"),
        ("GET", f"/worktrees/{worktree['id']}/test-history/source?environment=dev"),
        ("GET", f"/worktrees/{worktree['id']}/generations/private"),
        ("GET", f"/projects/{worktree['project']}/settings"),
        ("GET", f"/runs/{run['id']}"),
        ("GET", f"/runs?worktree={worktree['id']}"),
        ("POST", f"/runs/{run['id']}/cancel"),
        ("POST", "/conflicts/private-conflict/resolve"),
        ("POST", f"/worktrees/{worktree['id']}/lineage"),
    ]:
        response = request(client, outsider, method, path, **({"json": {}} if method == "POST" else {}))
        assert response.status_code == 404, (path, response.text)
    # Backend-only CI runs before the frontend build. The public shell may
    # report missing assets, but it must not require an authenticated session.
    shell = client.get(f"/worktrees/{worktree['id']}", headers={"cookie": ""})
    assert shell.status_code in (200, 503)
    assert shell.content == client.get("/", headers={"cookie": ""}).content
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
    for suffix in (
        "git/history",
        "git/compare",
        "git/branches",
        "git/remote",
        "test-history/source?environment=dev",
    ):
        assert request(client, headers, "GET", f"/worktrees/{worktree}/{suffix}").status_code == 200
    for suffix in (
        "git/open",
        "git/cleanup",
        "git/reviews",
        "git/reviews/missing",
        "git/reviews/missing/apply",
        "git/fetch",
        "git/pull",
        "git/push",
    ):
        response = request(client, headers, "POST", f"/worktrees/{worktree}/{suffix}", json={})
        assert response.status_code in ((403,) if role == "reader" else (409, 422))
    remote = request(client, headers, "GET", f"/worktrees/{worktree}/git/remote").json()
    app.state.services.projects.remotes.credentials.save_hosts("", ["https://example.invalid/"])
    response = request(
        client,
        headers,
        "PUT",
        f"/worktrees/{worktree}/git/remote",
        json={
            "url": "https://example.invalid/project.git",
            "remote_branch": "main",
            "config_revision": remote["config_revision"],
        },
    )
    assert response.status_code == (200 if role == "admin" else 403)
    assert request(client, headers, "GET", f"/worktrees/{worktree}/archive.zip").status_code == 200
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
        ("GET", "/extensions/settings", None),
        ("GET", "/extensions/runtime", None),
        ("POST", "/extensions/import", {}),
        ("PUT", "/extensions/settings", {"allow_unsigned_extensions": True}),
        ("POST", "/environments", {}),
        ("PUT", "/environments/prod", {}),
        ("DELETE", "/environments/prod", None),
        ("PATCH", "/users/admin", {"role": "member"}),
    ]:
        assert (
            request(client, headers, method, path, **({"json": data} if data is not None else {})).status_code
            == 403
        )


def test_every_api_route_requires_its_classified_access_level(instance):
    app, client = instance
    routes = {
        (method, route.path)
        for route in app.routes
        if isinstance(route, APIRoute) and route.path.startswith("/api/")
        for method in route.methods
    }
    levels = {tuple(entry.split()): level for level, entries in ROUTE_ACCESS.items() for entry in entries}
    assert routes == set(levels)
    _, owner_headers = account(app, "owner")
    worktree = own_project(app, client, owner_headers)
    # Deleting a project must not remove the one that the other routes probe.
    disposable = own_project(app, client, owner_headers, "Disposable")
    actors = [{"cookie": ""}, account(app, "outsider")[1]]
    for role in ("reader", "editor"):
        user, headers = account(app, role)
        for project in (worktree, disposable):
            app.state.access.member(project["project"], user["id"], role)
        actors.append(headers)
    admin = app.state.auth.login("admin", app.state.auth.initial_password, peer="probe")
    actors += [owner_headers, {"authorization": "Bearer " + admin}]
    store, engine = app.state.services.store, app.state.services.engine
    run = wait_run(store, engine.launch(worktree["id"], "dev"))
    store.put("conflict", "probe", {"id": "probe", "worktree": worktree["id"]})
    values = {
        "project": worktree["project"],
        "worktree": worktree["id"],
        "run": run["id"],
        "conflict": "probe",
        "kind": "connection",
        "commit": "HEAD",
    }
    # Logging out revokes the probing session, so it is probed last.
    for (method, path), level in sorted(levels.items(), key=lambda item: (item[0][1] == "/api/logout", item)):
        ids = {**values, "project": disposable["project"]} if path == "/api/projects/{project}" else values
        url = re.sub(r"\{(\w+)\}", lambda match, ids=ids: ids.get(match[1], "missing"), path)
        # An unknown environment keeps the permitted launch probe from starting a run.
        body = {"environment": "missing"} if path.endswith("/runs") else {}
        # Probe each lower level, then the minimum level; higher levels may change state.
        for rank, headers in enumerate(actors[: level + 1]):
            response = client.request(
                method,
                url,
                headers={"cookie": "", **headers},
                json=None if method == "GET" else body,
                follow_redirects=False,
            )
            try:
                error = response.json().get("error")
            except (ValueError, AttributeError):
                error = None
            denied = response.status_code in (401, 403, 404) and error in AUTHORIZATION_ERRORS
            assert denied == (rank < level), (method, path, rank, response.status_code, error)


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
    store, engine = app.state.services.store, app.state.services.engine
    assert (
        request(client, headers, "GET", f"/worktrees/{worktree['id']}/status?environment=dev").status_code
        == 200
    )
    assert engine.context(worktree["id"], "dev").db is None
    run = client.post(f"/api/worktrees/{worktree['id']}/runs", json={"environment": "dev"}).json()
    assert wait_run(store, run, timeout=30)["status"] == "success"
    response = request(
        client, headers, "GET", f"/worktrees/{worktree['id']}/preview/orders?environment=dev"
    ).json()
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
    services = app.state.services
    store, projects, engine = services.store, services.projects, services.engine
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
        from duckpad.bundle import bundle_to_files

        projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
        run = engine.launch(worktree["id"], "dev")
        result = wait_run(store, run)
        assert (result["status"] == "success") is success, result
    cursor = engine.context(worktree["id"], "dev").db.cursor()
    with pytest.raises(Exception, match=r"configuration|locked"):
        cursor.execute("SET enable_external_access = true")
    with pytest.raises(Exception, match=r"Permission|disabled|denied"):
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
        == 422
    )
    created = client.post("/api/users", json={"username": "new", "password": PASSWORD}).json()
    assert set(created) == {"id", "username", "role", "active"}
    assert client.post("/api/users", json={"username": "NEW", "password": PASSWORD}).status_code == 409
    assert PASSWORD not in client.get("/api/users").text


def test_sql_worker_cancels_and_recovers_after_process_exit(instance):
    import time

    from duckpad.bundle import bundle_to_files

    app, client = instance
    _, headers = account(app, "runner")
    worktree = own_project(app, client, headers)
    services = app.state.services
    store, projects, engine = services.store, services.projects, services.engine
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
    # The replaced worker was reaped and its descriptors released.
    assert database.process.stderr.closed and database.socket.fileno() == -1


def test_read_only_connection_root_cannot_be_written_through_another_connection(instance, tmp_path):
    app, client = instance
    _, headers = account(app, "author")
    worktree = own_project(app, client, headers)
    root = tmp_path / "read-only-source"
    root.mkdir()
    (root / "input.csv").write_text("value\n42\n")
    catalog, engine = app.state.services.catalog, app.state.services.engine
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
        create=True,
    )
    app.state.access.grant_connections(worktree["project"], ["local", "source_files"])
    cursor = engine.context(worktree["id"], "dev", create=True).db.cursor()
    assert cursor.execute("SELECT * FROM read_csv('" + str(root / "input.csv") + "')").fetchall() == [(42,)]
    with pytest.raises(Exception, match=r"Permission|denied"):
        cursor.execute("COPY (SELECT 1) TO '" + str(root / "output.csv") + "'")
    assert not (root / "output.csv").exists()
    cursor.close()


def test_sql_worker_cancellation_stays_armed_between_queries(instance):
    import duckdb

    app, client = instance
    _, headers = account(app, "cancel-gap")
    worktree = own_project(app, client, headers)
    engine = app.state.services.engine
    cursor = engine.context(worktree["id"], "dev", create=True).db.cursor()
    assert cursor.execute("SELECT 1").fetchone() == (1,)
    cursor.interrupt()
    with pytest.raises(duckdb.InterruptException, match="canceled"):
        cursor.execute("SELECT 2")
    cursor.close()
