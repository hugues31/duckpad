"""Git authorship follows authenticated requests across saves and integrations."""

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.identity import SYSTEM_IDENTITY, account_identity

PASSWORD = "commit-identity-password"


@pytest.fixture
def instance(tmp_path, monkeypatch):
    # Server configuration and legacy settings must not override either Git identity.
    for role in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{role}_NAME", "Server process")
        monkeypatch.setenv(f"GIT_{role}_EMAIL", "server@example.com")
    app = create_app(tmp_path / "instance", watch=False)
    app.state.services.store.put(
        "settings", "identity", {"name": "Legacy author", "email": "legacy@example.com"}
    )
    with TestClient(app) as client:
        users = {}
        for name in ("alice", "bob"):
            user = app.state.auth.create_user(name, PASSWORD)
            token = app.state.auth.login(name, PASSWORD)
            users[name] = (user, {"authorization": "Bearer " + token})
        yield app, client, users


def check_identity(projects, worktree, identity, ref="HEAD"):
    fields = projects.git(worktree["path"], "show", "-s", "--format=%an%n%ae%n%cn%n%ce", ref).splitlines()
    assert fields == [identity["name"], identity["email"]] * 2


def save(client, worktree, headers, description):
    snapshot = client.get(f"/api/worktrees/{worktree['id']}", headers=headers).json()
    snapshot["bundle"]["flow"]["description"] = description
    response = client.put(
        f"/api/worktrees/{worktree['id']}",
        headers=headers,
        json={"revision": snapshot["revision"], "bundle": snapshot["bundle"]},
    )
    assert response.status_code == 200, response.text
    return response.json()


def shared_project(app, client, users):
    worktree = client.post("/api/projects", headers=users["alice"][1], json={"name": "Shared"}).json()
    app.state.access.member(worktree["project"], users["bob"][0]["id"], "editor")
    return worktree


def test_local_creation_saves_removed_setting_and_session_revocation(instance):
    app, client, users = instance
    projects = app.state.services.projects
    worktree = shared_project(app, client, users)
    initial = projects.snapshot(worktree["id"])["commit"]
    check_identity(projects, worktree, account_identity(users["alice"][0]))
    for name in ("bob", "alice"):
        user, headers = users[name]
        save(client, worktree, headers, name)
        check_identity(projects, worktree, account_identity(user))
        assert "identity" not in client.get("/api/workspace", headers=headers).json()
        assert client.put("/api/identity", headers=headers, json={"name": "Spoof"}).status_code == 404
    check_identity(projects, worktree, account_identity(users["alice"][0]), initial)
    token = users["alice"][1]["authorization"].removeprefix("Bearer ")
    app.state.auth.logout(token)
    assert client.post("/api/projects", headers=users["alice"][1], json={}).status_code == 401
    # A service call after requests must not inherit the last account.
    system = projects.create("Outside a request")
    check_identity(projects, system, SYSTEM_IDENTITY)


def test_overlapping_requests_do_not_share_authorship(instance, monkeypatch):
    app, client, users = instance
    projects = app.state.services.projects
    barrier = threading.Barrier(2)
    worktrees = {
        name: client.post("/api/projects", headers=headers, json={"name": name}).json()
        for name, (_, headers) in users.items()
    }
    write = projects.write

    def concurrent_write(*args, **kwargs):
        barrier.wait(timeout=5)
        return write(*args, **kwargs)

    monkeypatch.setattr(projects, "write", concurrent_write)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(save, client, worktrees[name], headers, name) for name, (_, headers) in users.items()
        ]
        for future in futures:
            future.result(timeout=10)
    for name, (user, _) in users.items():
        check_identity(projects, worktrees[name], account_identity(user))


@pytest.mark.parametrize("finalize", ["save", "flush", "watcher"])
def test_external_changes_never_take_the_requesting_accounts_identity(instance, finalize):
    app, client, users = instance
    projects = app.state.services.projects
    worktree = shared_project(app, client, users)
    Path(worktree["path"], "documentation.json").write_text(json.dumps({"project": "External edit"}))
    if finalize == "save":
        save(client, worktree, users["bob"][1], "UI edit")
        check_identity(projects, worktree, account_identity(users["bob"][0]))
        check_identity(projects, worktree, SYSTEM_IDENTITY, "HEAD~1")
    elif finalize == "flush":
        response = client.post(f"/api/worktrees/{worktree['id']}/runs", headers=users["bob"][1], json={})
        assert response.status_code == 200, response.text
        check_identity(projects, worktree, SYSTEM_IDENTITY)
    else:
        projects._observe(worktree)
        projects.pending[worktree["id"]] = 0
        projects._observe(worktree)
        check_identity(projects, worktree, SYSTEM_IDENTITY)


def test_conflict_resolution_and_reviewed_merge_use_the_acting_account(instance):
    app, client, users = instance
    projects = app.state.services.projects
    worktree = shared_project(app, client, users)
    alice, bob = users["alice"][1], users["bob"][1]
    original = client.get(f"/api/worktrees/{worktree['id']}", headers=alice).json()
    save(client, worktree, alice, "Alice's change")
    original["bundle"]["flow"]["description"] = "Bob's proposal"
    conflict = client.put(
        f"/api/worktrees/{worktree['id']}",
        headers=bob,
        json={"revision": original["revision"], "bundle": original["bundle"]},
    )
    assert conflict.status_code == 409
    response = client.post(
        f"/api/conflicts/{conflict.json()['detail']['id']}/resolve",
        headers=bob,
        json={"choice": "proposal"},
    )
    assert response.status_code == 200, response.text
    check_identity(projects, worktree, account_identity(users["bob"][0]))
    branch = client.post(
        f"/api/worktrees/{worktree['id']}/branches", headers=bob, json={"name": "feature"}
    ).json()
    save(client, branch, bob, "Branch change")
    review = client.post(
        f"/api/worktrees/{worktree['id']}/git/reviews", headers=bob, json={"source": "refs/heads/feature"}
    ).json()
    response = client.post(
        f"/api/worktrees/{worktree['id']}/git/reviews/{review['id']}/apply",
        headers=alice,
        json={"choices": {}, "proposal_revision": review["proposal_revision"]},
    )
    assert response.status_code == 200, response.text
    check_identity(projects, worktree, account_identity(users["alice"][0]))
    check_identity(projects, branch, account_identity(users["bob"][0]))
