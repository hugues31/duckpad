"""Search must filter before reading project files and never expose execution data."""

import copy
import time

import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.auth import session_key
from duckpad.bundle import bundle_to_files
from duckpad.util import atomic_write

PASSWORD = "search-test-password"


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
    return user, {"authorization": "Bearer " + token, "cookie": ""}


def project(app, name):
    bundle = {
        "flow": {
            "nodes": [
                {
                    "id": "orders",
                    "template": "source",
                    "label": "Orders",
                    "params": {"token": "hidden-parameter"},
                },
                {"id": "east", "component": "summary", "label": "Eastern summary", "params": {}},
                {"id": "west", "component": "summary", "label": "Western summary", "params": {}},
            ],
            "edges": [],
        },
        "templates": {"source": "-- @label Revenue source\n-- @output result\nSELECT 'hidden-sql' AS value;"},
        "components": {
            "summary": {
                "name": "Summary",
                "nodes": [
                    {"id": "revenue", "template": "source", "label": "Net revenue", "params": {}},
                ],
                "edges": [],
                "inputs": {},
                "outputs": {},
            }
        },
        "documentation": {"project": "hidden-documentation"},
    }
    worktree = app.state.services.projects.create(name, bundle)
    app.state.access.own(worktree, {"id": "admin"})
    return worktree


@pytest.mark.parametrize("role", ["reader", "editor", "admin"])
def test_search_filters_before_reading_and_rechecks_membership(instance, monkeypatch, role):
    app, client = instance
    public = project(app, "Allowed workspace")
    private = project(app, "Confidential workspace")
    user, headers = account(app, "participant")
    _, outsider = account(app, "outsider")
    app.state.access.member(public["project"], user["id"], role)
    projects = app.state.services.projects
    original = projects.revision_files
    read_paths = []

    def read(path, commit):
        read_paths.append(path)
        return original(path, commit)

    monkeypatch.setattr(projects, "revision_files", read)
    result = client.get("/api/search", params={"q": "revenue"}, headers=headers)
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert len(result.json()["results"]) == 3  # Source template label and two component instances.
    assert {r["project"] for r in result.json()["results"]} == {public["project"]}
    assert private["path"] not in read_paths
    assert private["project"] not in result.text
    assert client.get("/api/search?q=Confidential", headers=headers).json()["results"] == []
    assert client.get("/api/search?q=revenue", headers=outsider).json() == {
        "results": [],
        "has_more": False,
        "incomplete": False,
    }
    app.state.access.member(public["project"], user["id"], None)
    read_paths.clear()
    assert client.get("/api/search?q=revenue", headers=headers).json()["results"] == []
    assert read_paths == []
    assert len(client.get("/api/search?q=revenue").json()["results"]) == 6


def test_search_nested_navigation_branch_isolation_and_metadata_only(instance):
    app, client = instance
    worktree = project(app, "Sales workspace")
    projects = app.state.services.projects
    branch = projects.branch(worktree["id"], "experiment")
    snap = projects.snapshot(branch["id"])
    snap["bundle"]["components"]["summary"]["nodes"][0]["label"] = "Branch-only metric"
    projects.write(branch["id"], snap["revision"], bundle_to_files(snap["bundle"]))
    result = client.get("/api/search?q=NET%20REVENUE").json()["results"]
    assert len(result) == 2
    assert {tuple(r["path"]) for r in result} == {("east",), ("west",)}
    assert all(r["node"] == "revenue" and r["worktree"] == worktree["id"] for r in result)
    result = client.get("/api/search?q=branch-only").json()["results"]
    assert len(result) == 2
    assert all(r["worktree"] == branch["id"] and r["branch"] == "experiment" for r in result)
    assert client.get("/api/search?q=experiment").json()["results"][0]["kind"] == "branch"
    assert client.get("/api/search?q=Sales").json()["results"][0]["kind"] == "project"
    assert client.get("/api/search", params={"q": worktree["project"]}).json()["results"]
    for text in ("hidden-parameter", "hidden-sql", "hidden-documentation"):
        assert client.get("/api/search", params={"q": text}).json()["results"] == []
    result = client.get("/api/search?q=Sales")
    for text in ("hidden-parameter", "hidden-sql", "hidden-documentation", worktree["path"]):
        assert text not in result.text


def test_search_authentication_logout_expiry_and_disabled_account(instance):
    app, client = instance
    project(app, "Private")
    assert client.get("/api/search?q=Private", headers={"cookie": ""}).status_code == 401
    user, headers = account(app, "reader")
    assert client.get("/api/search?q=Private", headers=headers).status_code == 200
    token = headers["authorization"].removeprefix("Bearer ")
    session = app.state.auth.store.get("session", session_key(token))
    session["expires"] = time.time() - 1
    app.state.auth.store.put("session", session_key(token), session)
    assert client.get("/api/search?q=Private", headers=headers).status_code == 401
    token = app.state.auth.login("reader", PASSWORD)
    headers["authorization"] = "Bearer " + token
    app.state.access.update_user(user["id"], {"active": False})
    assert client.get("/api/search?q=Private", headers=headers).status_code == 401
    assert client.post("/api/logout").status_code == 200
    assert client.get("/api/search?q=Private").status_code == 401


def test_search_limits_invalid_files_cycles_and_no_project_writes(instance):
    app, client = instance
    worktree = project(app, "A cyclic workspace")
    projects = app.state.services.projects
    snap = projects.snapshot(worktree["id"])
    cyclic = copy.deepcopy(snap["bundle"])
    cyclic["components"]["summary"]["nodes"].append({"id": "cycle", "component": "summary", "params": {}})
    projects.write(worktree["id"], snap["revision"], bundle_to_files(cyclic))
    before = projects.git(worktree["path"], "rev-parse", "HEAD")
    assert client.get("/api/search?q=cycle").status_code == 200
    assert projects.git(worktree["path"], "rev-parse", "HEAD") == before
    result = client.get("/api/search?q=workspace&limit=1").json()
    assert len(result["results"]) == 1 and result["has_more"]
    assert client.get("/api/search?q=%20%20").json()["results"] == []
    for params in ({"q": "a" * 201}, {"limit": 0}, {"limit": 101}):
        assert client.get("/api/search", params=params).status_code == 422
    broken = project(app, "Broken workspace")
    from pathlib import Path

    atomic_write(Path(broken["path"]) / "flow.json", "{")
    projects.commit(broken["path"], "test: break project files")
    result = client.get("/api/search?q=Orders").json()
    assert result["incomplete"] and len(result["results"]) == 1
