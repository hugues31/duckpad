"""Every Git command is bounded, hook-free, isolated from server Git settings and reports readable errors."""

import logging
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.git import command
from duckpad.git.command import GitError, GitTimeout


@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path / "instance", watch=False)


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        yield client


@pytest.fixture
def worktree(app, client):
    identity = client.post("/api/projects", json={"name": "Git"}).json()["id"]
    return app.state.services.projects.get(identity)


def save(client, worktree, description):
    snapshot = client.get(f"/api/worktrees/{worktree['id']}").json()
    snapshot["bundle"]["flow"]["description"] = description
    return client.put(
        f"/api/worktrees/{worktree['id']}",
        json={"revision": snapshot["revision"], "bundle": snapshot["bundle"]},
    )


def test_a_hanging_git_command_times_out(app, worktree):
    projects = app.state.services.projects
    started = time.monotonic()
    with pytest.raises(GitTimeout) as caught:
        # Without -m, Git waits for the editor to exit.
        projects.git(
            worktree["path"], "commit", "--allow-empty", settings=["core.editor=sleep 10 #"], timeout=0.5
        )
    assert time.monotonic() - started < 5
    assert caught.value.status == 504 and "did not respond in time" in str(caught.value)


@pytest.mark.parametrize("name", ["experiment/", "", "feature//change", "two words", "branch.lock"])
def test_invalid_branch_names_are_explained_wherever_they_are_entered(app, client, worktree, name):
    app.state.services.projects.remotes.credentials.save_hosts("", ["https://example.invalid/"])
    remote = client.get(f"/api/worktrees/{worktree['id']}/git/remote").json()
    for method, path, body in [
        ("POST", "branches", {"name": name}),
        ("POST", "git/open", {"name": name}),
        (
            "PUT",
            "git/remote",
            {
                "url": "https://example.invalid/project.git",
                "remote_branch": name,
                "config_revision": remote["config_revision"],
            },
        ),
    ]:
        response = client.request(method, f"/api/worktrees/{worktree['id']}/{path}", json=body)
        assert response.status_code == 422, (path, response.text)
        assert response.json()["detail"]["code"] == "invalid_branch_name"
        assert response.json()["error"] == command.INVALID_BRANCH_NAME
    status = client.get(f"/api/worktrees/{worktree['id']}/git/remote").json()
    assert status["url"] is None and status["config_revision"] == remote["config_revision"]


def test_existing_branches_and_unknown_revisions_have_readable_errors(client, worktree):
    url = f"/api/worktrees/{worktree['id']}"
    assert client.post(f"{url}/branches", json={"name": "feature"}).status_code == 200
    duplicate = client.post(f"{url}/branches", json={"name": "feature"})
    assert duplicate.status_code == 409 and duplicate.json()["detail"]["code"] == "branch_exists"
    for response in [
        client.post(f"{url}/branches", json={"name": "other", "revision": "missing"}),
        client.post(f"{url}/git/open", json={"name": "missing"}),
        client.get(f"{url}/git/compare", params={"a": "missing", "b": "HEAD"}),
    ]:
        assert response.status_code == 404, response.text
        assert (
            response.json()["error"]
            == "Branch, tag or commit not found. Choose an existing branch, tag or commit."
        )


def test_git_failures_keep_server_paths_in_the_logs(app, client, worktree, caplog):
    home = str(app.state.services.store.home)
    # A Git client that crashed leaves its index lock behind.
    lock = Path(worktree["path"], ".git", "index.lock")
    lock.touch()
    with caplog.at_level(logging.WARNING, logger="duckpad.git.command"):
        response = save(client, worktree, "Locked")
    assert response.status_code == 409, response.text
    assert response.json()["error"] == command.FAILURE
    assert home not in response.text and "index.lock" not in response.text
    assert str(lock) in caplog.text and "File exists" in caplog.text


def test_cleanup_explains_a_worktree_git_keeps(app, client, worktree):
    branch = client.post(f"/api/worktrees/{worktree['id']}/branches", json={"name": "done"}).json()
    Path(branch["path"], "notes.txt").write_text("not a project definition")
    head = app.state.services.projects.git(branch["path"], "rev-parse", "HEAD")
    response = client.post(
        f"/api/worktrees/{worktree['id']}/git/cleanup",
        json={"remove_worktree": branch["id"], "integrated_worktree": worktree["id"], "expected_head": head},
    )
    assert response.status_code == 409, response.text
    assert "untracked files" in response.json()["error"]
    assert str(app.state.services.store.home) not in response.text
    assert Path(branch["path"], "notes.txt").exists()


def test_unreadable_revisions_are_reported_instead_of_crashing(app, worktree):
    with pytest.raises(GitError) as caught:
        app.state.services.projects.revision_files(worktree["path"], "0" * 40)
    assert caught.value.status == 409 and caught.value.output


def test_git_ignores_hooks_and_server_git_settings(app, worktree, tmp_path, monkeypatch):
    projects = app.state.services.projects
    hook = Path(worktree["path"], ".git", "hooks", "pre-commit")
    hook.write_text("#!/bin/sh\nexit 1\n")
    hook.chmod(0o755)
    home = tmp_path / "server-home"
    home.mkdir()
    # Signing with a failing program would reject every commit if the global configuration applied.
    (home / ".gitconfig").write_text("[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = false\n")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home))
    # Inherited repository variables would point Git at another repository and index.
    monkeypatch.setenv("GIT_DIR", str(tmp_path / "elsewhere.git"))
    monkeypatch.setenv("GIT_INDEX_FILE", str(tmp_path / "elsewhere.index"))
    before = projects.git(worktree["path"], "rev-parse", "HEAD")
    projects.git(worktree["path"], "commit", "--allow-empty", "-m", "chore: hook-free commit")
    assert projects.git(worktree["path"], "rev-parse", "HEAD^") == before
    assert not (tmp_path / "elsewhere.index").exists()
    env = command.environment({"name": "Ada", "email": "ada@example.com"})
    assert "GIT_DIR" not in env and "GIT_INDEX_FILE" not in env
    assert env["GIT_CONFIG_GLOBAL"] == os.devnull and env["GIT_CONFIG_NOSYSTEM"] == "1"
    assert env["GIT_AUTHOR_EMAIL"] == env["GIT_COMMITTER_EMAIL"] == "ada@example.com"
