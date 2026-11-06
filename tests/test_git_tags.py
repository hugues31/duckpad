"""Acceptance tags pin project history and retain the authenticated editor's identity."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.git.identity import account_identity


@pytest.fixture
def instance(tmp_path, monkeypatch):
    monkeypatch.setenv("GIT_COMMITTER_NAME", "Server identity")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "server@example.invalid")
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        users = {}
        for name in ("owner", "editor", "reader", "outsider"):
            user = app.state.auth.create_user(name, "tag-test-password")
            token = app.state.auth.login(name, "tag-test-password")
            users[name] = (user, {"authorization": "Bearer " + token})
        worktree = client.post(
            "/api/projects", headers=users["owner"][1], json={"name": "Tagged project"}
        ).json()
        for name in ("editor", "reader"):
            app.state.access.member(worktree["project"], users[name][0]["id"], name)
        yield app.state.services.projects, client, users, worktree


def create(instance, name="sales/2026.10.31", commit=None, message="Acceptance passed", actor="editor"):
    projects, client, users, worktree = instance
    return client.post(
        f"/api/worktrees/{worktree['id']}/git/tags",
        headers=users[actor][1],
        json={
            "name": name,
            "commit": commit or projects.git(worktree["path"], "rev-parse", "HEAD"),
            "message": message,
        },
    )


def test_annotated_tag_identity_notes_history_and_dirty_files(instance):
    projects, client, users, worktree = instance
    path = worktree["path"]
    head = projects.git(path, "rev-parse", "HEAD")
    Path(path, "README.md").write_text("Unsaved changes")
    message = "Accepted by the sales team\n\n# Checklist\nRevenue and totals checked.\nUnicode: café ✓"
    response = create(instance, message=message)
    assert response.status_code == 201, response.text
    tag = response.json()
    assert tag == {
        "name": "sales/2026.10.31",
        "ref": "refs/tags/sales/2026.10.31",
        "commit": head,
        "message": message,
        "tagger": account_identity(users["editor"][0]),
        "date": tag["date"],
    }
    assert tag["date"]
    assert projects.git(path, "cat-file", "-t", tag["ref"]) == "tag"
    assert projects.git(path, "rev-parse", "HEAD") == head
    assert Path(path, "README.md").read_text() == "Unsaved changes"
    assert not projects.store.all("run")
    base = f"/api/worktrees/{worktree['id']}/git"
    assert client.get(base + "/tags", headers=users["reader"][1]).json() == [tag]
    history = client.get(base + "/history", headers=users["reader"][1]).json()
    assert history["items"][0]["tags"] == [tag["name"]]


@pytest.mark.parametrize("name", ["", "bad name", "a..b", "a.lock", "a/", "/a", "a//b", "-a", "a@{b", "a\0b"])
def test_invalid_tag_names_are_rejected(instance, name):
    response = create(instance, name=name)
    assert response.status_code == 422, response.text
    assert instance[0].versioning.tags(instance[3]["id"]) == []


@pytest.mark.parametrize("message", ["", "  \n", "notes\0hidden"])
def test_acceptance_notes_are_required(instance, message):
    assert create(instance, message=message).status_code == 422


def test_duplicate_and_concurrent_creation_never_move_a_tag(instance):
    projects, client, users, worktree = instance
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: create(instance), range(2)))
    assert sorted(response.status_code for response in responses) == [201, 409]
    original = projects.versioning.tags(worktree["id"])
    snapshot = projects.snapshot(worktree["id"])
    projects.write(
        worktree["id"],
        snapshot["revision"],
        {**snapshot["files"], "README.md": "New version"},
    )
    assert create(instance, message="Replace the version").status_code == 409
    assert projects.versioning.tags(worktree["id"]) == original
    base = f"/api/worktrees/{worktree['id']}/git/tags"
    for method in ("PUT", "PATCH", "DELETE"):
        assert client.request(method, base, headers=users["owner"][1]).status_code == 405
    # Even a lightweight tag created outside Duckpad occupies its immutable name.
    projects.git(worktree["path"], "tag", "legacy", original[0]["commit"])
    assert create(instance, name="legacy").status_code == 409


@pytest.mark.parametrize(("existing", "name"), [("sales", "sales/2026.10.31"), ("v1/rc", "v1")])
def test_names_nested_with_an_existing_tag_are_conflicts(instance, existing, name):
    assert create(instance, name=existing).status_code == 201
    response = create(instance, name=name)
    assert response.status_code == 409, response.text
    assert response.json()["error"] == f"This name conflicts with the tag {existing}. Choose another name."
    assert [tag["name"] for tag in instance[0].versioning.tags(instance[3]["id"])] == [existing]


def test_unknown_foreign_and_unreachable_commits_are_refused(instance):
    projects, _, _, worktree = instance
    other = projects.create("Another project")
    foreign = projects.git(other["path"], "rev-parse", "HEAD")
    assert create(instance, commit=foreign).status_code == 404
    assert create(instance, commit="f" * 40).status_code == 404
    assert create(instance, commit="HEAD").status_code == 422
    path = worktree["path"]
    tree = projects.git(path, "rev-parse", "HEAD^{tree}")
    dangling = projects.git(path, "commit-tree", tree, "-p", "HEAD", "-m", "Unreachable snapshot")
    projects.git(path, "update-ref", "refs/duckpad/private-snapshot", dangling)
    assert create(instance, commit=dangling).status_code == 422
    assert projects.versioning.tags(worktree["id"]) == []


def test_old_and_other_branch_commits_compare_and_open_from_tags(instance):
    projects, client, users, main = instance
    branch = projects.branch(main["id"], "v1.4")
    snapshot = projects.snapshot(branch["id"])
    old = snapshot["commit"]
    projects.write(
        branch["id"],
        snapshot["revision"],
        {**snapshot["files"], "README.md": "Accepted branch"},
    )
    head = projects.git(branch["path"], "rev-parse", "HEAD")
    assert create(instance, name="v1.4", commit=head).status_code == 201
    assert create(instance, name="v1.0", commit=old).status_code == 201
    headers = users["editor"][1]
    base = f"/api/worktrees/{main['id']}"
    tags = client.get(f"/api/worktrees/{branch['id']}/git/tags", headers=headers).json()
    assert {tag["commit"] for tag in tags} == {old, head}
    compared = client.get(
        base + "/git/compare", headers=headers, params={"a": "v1.0", "b": "refs/tags/v1.4"}
    ).json()
    assert compared["a"]["commit"] == old
    assert compared["b"]["commit"] == head
    assert any(
        entity["file"] == "README.md" and entity["status"] != "unchanged" for entity in compared["entities"]
    )
    opened = client.post(
        base + "/branches", headers=headers, json={"name": "from-tag", "revision": "refs/tags/v1.4"}
    )
    assert opened.status_code == 200, opened.text
    assert projects.snapshot(opened.json()["id"])["commit"] == head
    # Tags retain project history after its last branch ref has gone away.
    projects.git(main["path"], "update-ref", "-d", "refs/heads/v1.4")
    projects.git(main["path"], "update-ref", "-d", "refs/heads/from-tag")
    assert create(instance, name="retained", commit=head).status_code == 201


def test_permissions_and_identity_cannot_be_supplied_by_the_client(instance):
    projects, client, users, worktree = instance
    assert create(instance, actor="reader").status_code == 403
    assert create(instance, actor="outsider").status_code == 404
    base = f"/api/worktrees/{worktree['id']}/git/tags"
    assert client.get(base, headers=users["outsider"][1]).status_code == 404
    assert client.get(base).status_code == 401
    assert client.post(base).status_code == 401
    for extra in ({"tagger": {"name": "Spoof", "email": "spoof@example.invalid"}}, {"force": True}):
        response = client.post(
            base,
            headers=users["editor"][1],
            json={
                "name": "v1",
                "commit": projects.git(worktree["path"], "rev-parse", "HEAD"),
                "message": "Accepted",
                **extra,
            },
        )
        assert response.status_code == 422
    assert create(instance, actor="owner").status_code == 201
