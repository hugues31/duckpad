"""Job pinning, isolation, admission, promotion and project permissions."""

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import join_run

from duckpad.app import create_app
from duckpad.util import Problem


@pytest.fixture
def instance(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        auth, services = app.state.auth, app.state.services
        users = {}
        for role in ("owner", "reader", "operator", "editor", "outsider"):
            user = auth.create_user(role, "job-test-password")
            token = auth.create_api_token(user, user["id"], "Tests")["token"]
            users[role] = (user, {"authorization": "Bearer " + token})
        token = auth.login("admin", auth.initial_password)
        users["admin"] = ({"id": "admin"}, {"authorization": "Bearer " + token})
        tree = client.post("/api/projects", headers=users["owner"][1], json={"name": "Jobs"}).json()
        for role in ("reader", "operator", "editor"):
            app.state.access.member(tree["project"], users[role][0]["id"], role)
        projects = services.projects
        snapshot = projects.snapshot(tree["id"])
        files = {
            **snapshot["files"],
            "flow.json": json.dumps(
                {
                    "id": tree["project"],
                    "name": "Jobs",
                    "nodes": [{"id": "source", "template": "source", "params": {}}],
                    "edges": [],
                }
            ),
            "templates/source.sql": "-- @kind source\n-- @output result\nSELECT 1 AS value;",
        }
        snapshot = projects.write(tree["id"], snapshot["revision"], files)
        projects.versioning.create_tag(tree["id"], "v1", snapshot["commit"], "Accepted")

        def call(method, path, data=None, actor="owner"):
            return client.request(method, "/api" + path, headers=users[actor][1], json=data)

        yield app, tree, call, snapshot["commit"], users


def create(instance, slug="daily", kind="tag", ref="v1", **changes):
    _, tree, call, _, _ = instance
    response = call(
        "POST",
        f"/projects/{tree['project']}/jobs",
        {
            "slug": slug,
            "name": "Daily",
            "environment": "dev",
            "target": {"kind": kind, "ref": ref},
            **changes,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def advance(instance, tag="v2"):
    app, tree, _, _, _ = instance
    projects = app.state.services.projects
    snapshot = projects.snapshot(tree["id"])
    snapshot = projects.write(
        tree["id"],
        snapshot["revision"],
        {
            **snapshot["files"],
            "templates/source.sql": "-- @kind source\n-- @output result\nSELECT 2 AS value;",
            "variables.json": json.dumps({"batch_size": {"type": "number", "default": 20}}),
        },
    )
    projects.versioning.create_tag(tree["id"], tag, snapshot["commit"], "Accepted again")
    return snapshot["commit"]


def test_pinned_job_read_only_results_requester_and_deleted_history(instance):
    app, tree, call, commit, _ = instance
    services = app.state.services
    job = create(instance)
    next_commit = advance(instance)
    services.projects.git(tree["path"], "tag", "-f", "v1", next_commit)
    assert call("GET", "/jobs/daily", actor="reader").json()["warning"] == "tag_moved"
    response = call("POST", "/jobs/daily/runs", {}, actor="operator")
    assert response.status_code == 202, response.text
    run = join_run(services.store, response.json()["id"])
    assert run["status"] == "success", run
    assert run["commit"] == commit and run["trigger"] == "job" and run["tag"] == "v1"
    assert run["job"]["slug"] == "daily"
    assert run["requester"]["username"] == "operator" and run["requester"]["token_name"] == "Tests"
    assert job["runtime_variables"] == []
    internal = services.projects.get(job["worktree"])
    assert internal["read_only"]
    assert not services.projects.git(internal["path"], "symbolic-ref", "-q", "HEAD", check=False)
    assert job["worktree"] not in [b["worktree"] for b in services.projects.versioning.branches(tree["id"])]
    preview = call("GET", f"/worktrees/{job['worktree']}/preview/source?environment=dev", actor="reader")
    assert preview.status_code == 200, preview.text
    assert preview.json()["rows"][0]["values"] == [1]
    result = preview.json()
    lineage = call(
        "POST",
        f"/worktrees/{job['worktree']}/lineage",
        {
            "environment": "dev",
            "dataset": result["id"],
            "row": result["rows"][0]["id"],
            "column": "value",
        },
        "reader",
    )
    assert lineage.status_code == 200, lineage.text
    assert lineage.json()["value"] == 1
    snapshot = call("GET", f"/worktrees/{job['worktree']}").json()
    for actor in ("owner", "admin", "operator"):
        for method, suffix, body in [
            ("PUT", "", {"revision": snapshot["revision"], "files": snapshot["files"]}),
            ("POST", "/runs", {"environment": "dev"}),
            ("POST", "/branches", {"name": "escape"}),
            ("POST", "/git/tags", {"name": "escape", "commit": commit, "message": "No"}),
            ("POST", "/uploads", {}),
        ]:
            assert call(method, f"/worktrees/{job['worktree']}" + suffix, body, actor).status_code == 403
    with pytest.raises(Problem, match="read-only"):
        services.projects.write(job["worktree"], snapshot["revision"], snapshot["files"])
    with pytest.raises(Problem, match="from its Job"):
        services.engine.launch(job["worktree"], "dev")
    # Neither launch capture nor the watcher may turn external changes into Job commits.
    Path(internal["path"], "README.md").write_text("External change")
    services.projects._observe(internal)
    assert job["worktree"] not in services.projects.observed
    assert services.projects.flush(job["worktree"])["commit"] == commit
    assert call("DELETE", "/jobs/daily").status_code == 200
    assert call("GET", "/jobs/daily").status_code == 404
    assert call("GET", f"/runs/{run['id']}", actor="reader").json()["commit"] == commit
    history = call("GET", f"/runs?worktree={tree['id']}&include_jobs=true", actor="reader").json()
    assert history[0]["id"] == run["id"]
    assert call("GET", f"/worktrees/{job['worktree']}").status_code == 200


def test_permissions_and_service_operators(instance):
    app, tree, call, _, users = instance
    job = create(instance)
    for actor in ("reader", "operator", "editor", "outsider"):
        expected = 404 if actor == "outsider" else 403
        for method, path, data in [
            ("POST", f"/projects/{tree['project']}/jobs", {}),
            ("PATCH", "/jobs/daily", {}),
            ("POST", "/jobs/daily/version", {}),
            ("DELETE", "/jobs/daily", None),
        ]:
            assert call(method, path, data, actor).status_code == expected
    for actor in ("reader", "outsider"):
        assert call("POST", "/jobs/daily/runs", {}, actor).status_code == (
            404 if actor == "outsider" else 403
        )
    assert call("GET", "/jobs/daily", actor="outsider").status_code == 404
    assert call("GET", f"/projects/{tree['project']}/jobs", actor="outsider").status_code == 404
    run = app.state.services.engine.launch(tree["id"], "dev")
    join_run(app.state.services.store, run["id"])
    assert call("POST", f"/runs/{run['id']}/cancel", {}, "operator").status_code == 403
    assert (
        call("POST", f"/worktrees/{tree['id']}/runs", {"environment": "dev"}, "operator").status_code == 403
    )
    service = app.state.auth.create_user("automation", service=True)
    app.state.access.member(tree["project"], service["id"], "operator")
    with pytest.raises(Problem, match="Readers or Operators"):
        app.state.access.member(tree["project"], service["id"], "editor")
    token = app.state.auth.create_api_token(
        app.state.auth.public(app.state.services.store.get("user", "admin")), service["id"], "Scheduler"
    )
    users["service"] = (service, {"authorization": "Bearer " + token["token"]})
    response = call("POST", "/jobs/daily/runs", {}, "service")
    assert response.status_code == 202, response.text
    finished = join_run(app.state.services.store, response.json()["id"])
    assert finished["requester"]["token_name"] == "Scheduler"
    assert finished["worktree"] == job["worktree"]


def test_promotion_compares_variables_detects_stale_review_and_audits_rollback(instance):
    app, _, call, first, _ = instance
    job = create(instance)
    second = advance(instance)
    review = call("GET", "/jobs/daily/version?ref=v2").json()
    assert review["previous_commit"] == first and review["commit"] == second
    assert "batch_size" in json.dumps(review["comparison"])
    body = {key: review[key] for key in ("revision", "previous_commit", "commit")}
    body["target"] = {"kind": "tag", "ref": "v2"}
    promoted = call("POST", "/jobs/daily/version", body)
    assert promoted.status_code == 200, promoted.text
    promoted = promoted.json()
    assert promoted["target"]["commit"] == second
    assert promoted["versions"][-1]["previous"]["tag"] == "v1"
    assert promoted["versions"][-1]["actor"]["username"] == "owner"
    assert call("POST", "/jobs/daily/version", body).status_code == 409
    assert (
        app.state.services.projects.git(
            app.state.services.projects.get(job["worktree"])["path"], "rev-parse", "HEAD"
        )
        == first
    )
    review = call("GET", "/jobs/daily/version?ref=v1").json()
    body = {key: review[key] for key in ("revision", "previous_commit", "commit")}
    body["target"] = {"kind": "tag", "ref": "v1"}
    assert call("POST", "/jobs/daily/version", body).json()["target"]["commit"] == first
    assert len(call("GET", "/jobs/daily").json()["versions"]) == 3


def test_branch_job_tracks_head_and_ui_confirmation_is_required(instance):
    app, _, call, first, _ = instance
    job = create(instance, kind="branch", ref="main", environment="prod")
    launch = {"entry_point": "ui", "revision": job["revision"]}
    response = call("POST", "/jobs/daily/runs", launch, "operator")
    assert response.status_code == 409 and response.json()["detail"]["confirmation_required"]["id"] == "prod"
    assert not app.state.services.store.all("run")
    first_run = call("POST", "/jobs/daily/runs", {**launch, "confirmed": True}, "operator")
    assert first_run.status_code == 202, first_run.text
    assert join_run(app.state.services.store, first_run.json()["id"])["commit"] == first
    second = advance(instance)
    second_run = call("POST", "/jobs/daily/runs", {}, "operator")
    assert second_run.status_code == 202, second_run.text
    assert join_run(app.state.services.store, second_run.json()["id"])["commit"] == second
    assert "commit" not in call("GET", "/jobs/daily").json()["target"]


def test_one_run_per_job_without_queuing_and_independent_jobs(instance, monkeypatch):
    app, _, call, _, _ = instance
    services = app.state.services
    create(instance)
    create(instance, slug="other")
    release = threading.Event()
    original = services.engine.runs._execute

    def held(execution):
        assert release.wait(10)
        original(execution)

    monkeypatch.setattr(services.engine.runs, "_execute", held)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: call("POST", "/jobs/daily/runs", {}, "operator"), range(2)))
        assert sorted(response.status_code for response in responses) == [202, 409]
        admitted = next(response.json() for response in responses if response.status_code == 202)
        refused = next(response.json() for response in responses if response.status_code == 409)
        assert refused["detail"]["run"] == admitted["id"]
        assert call("DELETE", "/jobs/daily").status_code == 409
        other = call("POST", "/jobs/other/runs", {}, "operator")
        assert other.status_code == 202, other.text
        assert call("POST", f"/runs/{admitted['id']}/cancel", {}, "reader").status_code == 403
        assert call("POST", f"/runs/{admitted['id']}/cancel", {}, "operator").status_code == 200
    finally:
        release.set()
    assert join_run(services.store, admitted["id"])["status"] == "canceled"
    assert join_run(services.store, other.json()["id"])["status"] == "success"
    assert len(services.store.all("run")) == 2


def test_slug_scope_update_and_target_validation(instance):
    _, tree, call, _, _ = instance
    job = create(instance, scope="source")
    base = {"slug": "daily", "name": "Daily", "environment": "dev", "target": {"kind": "tag", "ref": "v1"}}
    assert call("POST", f"/projects/{tree['project']}/jobs", base).status_code == 409
    for changes in (
        {"slug": "Bad_Slug"},
        {"slug": "valid", "runtime_variables": ["x"]},
        {"slug": "valid", "target": {"kind": "tag", "ref": "v1~0"}},
        {"slug": "valid", "scope": "unknown"},
    ):
        assert call("POST", f"/projects/{tree['project']}/jobs", {**base, **changes}).status_code in (
            404,
            422,
        )
    edit = {
        "revision": job["revision"],
        "name": "Renamed",
        "description": "Updated",
        "environment": "prod",
        "scope": None,
    }
    updated = call("PATCH", "/jobs/daily", edit)
    assert updated.status_code == 200, updated.text
    assert updated.json()["slug"] == "daily" and updated.json()["target"] == job["target"]
    assert call("PATCH", "/jobs/daily", edit).status_code == 409
    assert call("PATCH", "/jobs/daily", {**edit, "slug": "changed"}).status_code == 422
    assert call("POST", "/jobs/daily/runs", {"variables": {"x": 2}}, "operator").status_code == 422
    # A confirmation of the old environment cannot authorize execution of an edited Job.
    assert (
        call(
            "POST",
            "/jobs/daily/runs",
            {
                "entry_point": "ui",
                "confirmed": True,
                "revision": job["revision"],
            },
            "operator",
        ).status_code
        == 409
    )


def test_concurrent_slug_claim_across_projects_keeps_one_job_and_no_orphan(instance, monkeypatch):
    app, tree, call, _, _ = instance
    other = call("POST", "/projects", {"name": "Other"}).json()
    barrier = threading.Barrier(2)
    projects = app.state.services.projects
    original = projects.job_worktree

    def synchronized(project, commit):
        result = original(project, commit)
        barrier.wait(timeout=10)
        return result

    monkeypatch.setattr(projects, "job_worktree", synchronized)
    body = {
        "slug": "shared",
        "name": "Shared",
        "environment": "dev",
        "target": {"kind": "branch", "ref": "main"},
    }
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda project: call("POST", f"/projects/{project}/jobs", body),
                (tree["project"], other["project"]),
            )
        )
    assert sorted(response.status_code for response in responses) == [201, 409]
    accepted = next(response.json() for response in responses if response.status_code == 201)
    assert call("GET", "/jobs/shared").json()["worktree"] == accepted["worktree"]
    assert len(app.state.services.store.all("worktree")) == 3


def test_job_metadata_and_operator_rights_survive_restart(instance):
    app, _, call, commit, users = instance
    job = create(instance)
    services = app.state.services
    run = call("POST", "/jobs/daily/runs", {}, "operator").json()
    assert join_run(services.store, run["id"])["status"] == "success"
    # Open another server after all workers have settled, using the persisted metadata.
    reopened = create_app(services.store.home, watch=False)
    with TestClient(reopened) as client:
        headers = users["operator"][1]
        assert client.get("/api/jobs/daily", headers=headers).json()["target"]["commit"] == commit
        response = client.post("/api/jobs/daily/runs", headers=headers, json={})
        assert response.status_code == 202, response.text
        assert join_run(reopened.state.services.store, response.json()["id"])["status"] == "success"
        assert reopened.state.services.projects.get(job["worktree"])["read_only"]


def test_branch_invalid_or_missing_targets_do_not_admit_runs(instance):
    app, tree, call, _, _ = instance
    create(instance, kind="branch", ref="main")
    projects = app.state.services.projects
    snapshot = projects.snapshot(tree["id"])
    projects.write(tree["id"], snapshot["revision"], {**snapshot["files"], "flow.json": "{"})
    assert call("POST", "/jobs/daily/runs", {}, "operator").status_code == 422
    assert not app.state.services.store.all("run")
    projects.git(tree["path"], "branch", "-m", "main", "renamed")
    assert call("POST", "/jobs/daily/runs", {}, "operator").status_code == 409
    assert call("GET", "/jobs/daily").json()["warning"] == "target_unavailable"


def test_promoted_commit_survives_external_tag_movement_and_garbage_collection(instance):
    app, tree, call, first, _ = instance
    create(instance)
    second = advance(instance)
    review = call("GET", "/jobs/daily/version?ref=v2").json()
    body = {key: review[key] for key in ("revision", "previous_commit", "commit")}
    body["target"] = {"kind": "tag", "ref": "v2"}
    assert call("POST", "/jobs/daily/version", body).status_code == 200
    projects = app.state.services.projects
    # Results still point at v1. Remove every public reference to the promoted commit.
    projects.git(tree["path"], "reset", "--hard", first)
    projects.git(tree["path"], "tag", "-f", "v2", first)
    projects.git(tree["path"], "reflog", "expire", "--expire=now", "--all")
    projects.git(tree["path"], "gc", "--prune=now")
    assert call("GET", "/jobs/daily").json()["warning"] == "tag_moved"
    response = call("POST", "/jobs/daily/runs", {}, "operator")
    assert response.status_code == 202, response.text
    run = join_run(app.state.services.store, response.json()["id"])
    assert run["status"] == "success" and run["commit"] == second
