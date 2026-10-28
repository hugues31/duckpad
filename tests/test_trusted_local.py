"""Trusted desktop execution, including the Windows HTTP application path."""

import csv
import io
import sys

import duckdb
import pytest
from fastapi.testclient import TestClient
from helpers import wait_until

from duckpad import cli
from duckpad.app import create_app
from duckpad.util import Problem


def unavailable_sandbox(*args, **kwargs):
    raise Problem("SQL isolation is unavailable", 503)


@pytest.fixture
def local(tmp_path, monkeypatch):
    # Trusted execution must work even when the platform cannot start a sandbox.
    monkeypatch.setattr("duckpad.sandbox.Database", unavailable_sandbox)
    app = create_app(tmp_path / "instance", watch=False, trusted_local=True)
    with TestClient(app) as client:
        assert client.get("/api/workspace").status_code == 401
        response = client.post("/api/login", json={"password": app.state.auth.initial_password})
        assert response.status_code == 200
        yield app, client


def execute(app, client, worktree, **options):
    response = client.post(f"/api/worktrees/{worktree}/runs", json={"environment": "dev", **options})
    assert response.status_code == 200, response.text
    result = app.state.services.engine.wait(response.json()["id"], timeout=30)
    assert result["status"] == "success", result
    return result


def test_trusted_example_runs_previews_traces_exports_and_recalculates(local):
    app, client = local
    response = client.post("/api/example", json={"name": "Trusted desktop example"})
    assert response.status_code == 200, response.text
    worktree = response.json()["id"]
    endpoint = f"/api/worktrees/{worktree}"
    assert client.get(endpoint).json()["diagnostics"] == []
    run = execute(app, client, worktree)
    assert client.get(endpoint + "/preview/orders").json()["count"] == 120
    report = client.get(endpoint + "/preview/report", params={"port": "report"}).json()
    assert report["status"] == "valid" and report["count"] == 4
    lineage = client.post(
        endpoint + "/lineage",
        json={"dataset": report["id"], "row": report["rows"][0]["id"], "column": "revenue"},
    )
    assert lineage.status_code == 200, lineage.text
    assert lineage.json()["complete"] and lineage.json()["total"] > 0
    download = client.get(endpoint + "/exports/export/download", params={"run": run["id"]})
    assert download.status_code == 200, download.text
    assert len(list(csv.DictReader(io.StringIO(download.text)))) == 4

    snapshot = client.get(endpoint).json()
    for node in snapshot["bundle"]["flow"]["nodes"]:
        if node["id"] == "validated":
            node["params"]["status"] = "refunded"
    saved = client.put(endpoint, json={"revision": snapshot["revision"], "bundle": snapshot["bundle"]})
    assert saved.status_code == 200, saved.text
    assert client.get(endpoint + "/preview/report", params={"port": "report"}).json()["status"] == "stale"
    assert execute(app, client, worktree)["id"] != run["id"]
    assert client.get(endpoint + "/preview/validated", params={"port": "orders"}).json()["count"] == 13


def test_trusted_mode_prepares_connections_and_enforces_connection_grants(local, tmp_path):
    app, client = local
    database = tmp_path / "numbers.duckdb"
    with duckdb.connect(str(database)) as db:
        db.execute("CREATE TABLE numbers AS SELECT 42 AS value")
    worktree = client.post("/api/projects", json={"name": "Connection preparation"}).json()
    endpoint = f"/api/worktrees/{worktree['id']}"
    connector = {
        "id": "prepared",
        "name": "Prepared database",
        "parameters": [{"name": "database", "type": "file"}],
        "extensions": [],
        "capabilities": ["read"],
        "init_sql": "ATTACH {{ database }} AS {{ alias }} (READ_ONLY);",
    }
    assert client.put("/api/catalog/connector", json=connector).status_code == 200
    assert (
        client.put(
            "/api/catalog/connection",
            json={
                "id": "prepared",
                "name": "Prepared",
                "connector": "prepared",
                "environments": {"dev": {"database": str(database)}},
            },
        ).status_code
        == 200
    )
    snapshot = client.get(endpoint).json()
    snapshot["bundle"]["templates"]["source"] = (
        '-- @kind source\n-- @param connection: connection = "prepared"\n'
        "-- @output result\nSELECT * FROM {{ connection }}.numbers;"
    )
    snapshot["bundle"]["flow"]["nodes"] = [{"id": "source", "template": "source", "params": {}}]
    assert (
        client.put(
            endpoint, json={"revision": snapshot["revision"], "bundle": snapshot["bundle"]}
        ).status_code
        == 200
    )
    denied = client.post(endpoint + "/runs", json={"node": "source"})
    assert denied.status_code == 422 and "not authorized" in denied.text
    assert (
        client.put(
            f"/api/projects/{worktree['project']}/connections", json={"connections": ["prepared"]}
        ).status_code
        == 200
    )
    # Repeating the run also exercises connector teardown and initialization.
    for _ in range(2):
        execute(app, client, worktree["id"])
        assert client.get(endpoint + "/preview/source").json()["rows"][0]["values"] == [42]


def test_trusted_mode_cancels_native_sql_and_can_run_again(local):
    app, client = local
    worktree = client.post("/api/projects", json={"name": "Cancel trusted SQL"}).json()["id"]
    endpoint = f"/api/worktrees/{worktree}"
    snapshot = client.get(endpoint).json()
    snapshot["bundle"]["templates"]["slow"] = (
        "-- @kind source\n-- @output result\nSELECT SUM(random()) AS value FROM range(10000000000);"
    )
    snapshot["bundle"]["flow"]["nodes"] = [{"id": "source", "template": "slow", "params": {}}]
    assert (
        client.put(
            endpoint, json={"revision": snapshot["revision"], "bundle": snapshot["bundle"]}
        ).status_code
        == 200
    )
    run = client.post(endpoint + "/runs", json={}).json()
    wait_until(lambda: client.get(f"/api/runs/{run['id']}").json()["nodes"]["source"]["status"] == "running")
    assert client.post(f"/api/runs/{run['id']}/cancel").status_code == 200
    assert app.state.services.engine.wait(run["id"], timeout=30)["status"] == "canceled"
    snapshot = client.get(endpoint).json()
    snapshot["bundle"]["templates"]["slow"] = "-- @kind source\n-- @output result\nSELECT 42 AS value;"
    assert (
        client.put(
            endpoint, json={"revision": snapshot["revision"], "bundle": snapshot["bundle"]}
        ).status_code
        == 200
    )
    execute(app, client, worktree)


def test_trusted_mode_retains_api_project_permissions(local):
    app, client = local
    worktree = client.post("/api/projects", json={"name": "Readable"}).json()
    private = client.post("/api/projects", json={"name": "Private"}).json()
    password = "trusted-test-password"
    user = app.state.auth.create_user("reader", password, "member")
    app.state.access.member(worktree["project"], user["id"], "reader")
    assert client.post("/api/login", json={"username": "reader", "password": password}).status_code == 200
    assert client.get(f"/api/worktrees/{worktree['id']}").status_code == 200
    assert client.post(f"/api/worktrees/{worktree['id']}/runs", json={}).status_code == 403
    assert client.get(f"/api/worktrees/{private['id']}").status_code == 404
    assert client.get("/api/users").status_code == 403


def test_restart_without_flag_restores_isolation_and_never_falls_back(tmp_path, monkeypatch):
    monkeypatch.setattr("duckpad.sandbox.Database", unavailable_sandbox)
    trusted = create_app(tmp_path / "instance", watch=False, trusted_local=True)
    with TestClient(trusted) as client:
        password = trusted.state.auth.initial_password
        client.post("/api/login", json={"password": password})
        worktree = client.post("/api/example", json={}).json()["id"]
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert client.post("/api/login", json={"password": password}).status_code == 200
        response = client.post(f"/api/worktrees/{worktree}/runs", json={})
        assert response.status_code == 503
        assert response.json()["error"] == "SQL isolation is unavailable"


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
@pytest.mark.parametrize("trusted", [False, True])
def test_cli_explicit_mode_and_loopback_hosts(tmp_path, monkeypatch, capsys, host, trusted):
    args = ["duckpad", "start", "--home", str(tmp_path), "--host", host, "--no-browser"]
    monkeypatch.setattr(sys, "argv", [*args, *(["--trusted-local"] if trusted else [])])

    def serve(app, **options):
        assert options["host"] == host
        assert app.state.services.engine.isolated is not trusted
        with TestClient(app) as client:
            assert client.get("/api/workspace").status_code == 401

    monkeypatch.setattr(cli.uvicorn, "run", serve)
    cli.main()
    assert ("SQL runs without OS isolation" in capsys.readouterr().out) is trusted


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.0.2.1", "example.invalid"])
def test_trusted_cli_rejects_non_loopback_bind_before_creating_instance(tmp_path, monkeypatch, capsys, host):
    home = tmp_path / "instance"
    monkeypatch.setattr(
        sys, "argv", ["duckpad", "start", "--trusted-local", "--host", host, "--home", str(home)]
    )
    with pytest.raises(SystemExit) as error:
        cli.main()
    assert error.value.code == 2
    assert "--trusted-local requires --host" in capsys.readouterr().err
    assert not home.exists()
