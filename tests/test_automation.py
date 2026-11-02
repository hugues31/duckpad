"""Public v1 contracts, safe retries, waiting and automation permissions."""

import asyncio
import hashlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import anyio
import httpx
import pytest
import test_jobs
from fastapi.testclient import TestClient
from helpers import join_run
from sqlalchemy import text

from duckpad.app import create_app
from duckpad.jobs import Jobs
from duckpad.store import Store
from duckpad.util import Problem

instance = test_jobs.instance


@pytest.fixture
def api(instance):
    app, tree, _, commit, users = instance
    job = test_jobs.create(instance)
    client = TestClient(app, raise_server_exceptions=False)

    def call(method, path, body=None, actor="operator", key=None):
        headers = dict(users[actor][1]) if actor else {}
        if key is not None:
            headers["Idempotency-Key"] = key
        return client.request(method, "/api/v1" + path, json=body, headers=headers)

    yield app, call, job, tree, commit, users
    client.close()


def launch(call, **kwargs):
    response = call("POST", "/jobs/daily/runs", **kwargs)
    assert response.status_code == 202, response.text
    return response.json()


def error(response, status, code):
    assert response.status_code == status, response.text
    assert isinstance(response.json()["error"], str)
    assert response.json()["detail"]["code"] == code


def hold_execution(app, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    execute = app.state.services.engine.runs._execute

    def paused(execution):
        entered.set()
        assert release.wait(10), "Test did not release execution"
        execute(execution)

    monkeypatch.setattr(app.state.services.engine.runs, "_execute", paused)
    return entered, release


def test_job_and_run_contract_trigger_requester_and_log(api):
    app, call, job, tree, commit, _ = api
    listed = call("GET", "/jobs", actor="reader").json()
    assert len(listed) == 1 and listed[0]["slug"] == "daily"
    assert listed[0]["last_run"] is None
    assert set(listed[0]) == {
        "slug",
        "name",
        "description",
        "project",
        "target",
        "environment",
        "scope",
        "last_run",
    }
    trigger = {"source": "airflow", "reference": "daily/scheduled-1"}
    run = launch(call, body={"trigger": trigger})
    assert set(run) == {
        "variables",
        "id",
        "job",
        "status",
        "tag",
        "commit",
        "environment",
        "started",
        "finished",
        "nodes",
        "trigger",
        "requester",
        "links",
    }
    assert run["job"] == "daily" and run["tag"] == "v1" and run["commit"] == commit
    assert run["trigger"] == trigger
    assert run["requester"]["username"] == "operator"
    assert run["requester"]["token_name"] == "Tests"
    assert run["nodes"]["total"] == 1
    assert run["links"] == {
        name: f"/api/v1/runs/{run['id']}" + suffix
        for name, suffix in (("self", ""), ("cancel", "/cancel"), ("log", "/log"))
    }
    finished = call("GET", f"/runs/{run['id']}?wait=5", actor="reader").json()
    assert finished["status"] == "success" and finished["finished"]
    assert finished["nodes"]["success"] == 1
    internal = app.state.services.store.get("run", run["id"])
    assert internal["trigger"] == "job" and internal["external_trigger"] == trigger
    assert internal["worktree"] == job["worktree"] and internal["project"] == tree["project"]
    assert call("GET", "/jobs/daily").json()["last_run"] == finished
    log = call("GET", f"/runs/{run['id']}/log", actor="reader")
    assert log.headers["content-type"].startswith("text/plain")
    assert "Node source (source): success" in log.text and "Outcome: success" in log.text
    assert "SELECT" not in log.text
    assert call("POST", f"/runs/{run['id']}/cancel").json() == finished


def test_permissions_and_hidden_resources(api):
    app, call, _, tree, _, _ = api
    assert call("GET", "/jobs", actor="outsider").json() == []
    error(call("GET", "/jobs/daily", actor="outsider"), 404, "job_not_found")
    error(call("POST", "/jobs/daily/runs", {}, actor="reader"), 403, "forbidden")
    error(call("POST", "/jobs/daily/runs", {}, actor="outsider"), 404, "job_not_found")
    error(call("GET", "/jobs/missing"), 404, "job_not_found")
    run = launch(call)
    join_run(app.state.services.store, run["id"])
    for method, suffix in (("GET", ""), ("GET", "/log"), ("POST", "/cancel")):
        error(call(method, f"/runs/{run['id']}" + suffix, actor="outsider"), 404, "run_not_found")
        error(call(method, "/runs/missing" + suffix), 404, "run_not_found")
    error(call("POST", f"/runs/{run['id']}/cancel", actor="reader"), 403, "forbidden")
    manual = app.state.services.engine.launch(tree["id"], "dev")
    join_run(app.state.services.store, manual["id"])
    for suffix in ("", "/log", "/cancel"):
        error(
            call("POST" if suffix == "/cancel" else "GET", f"/runs/{manual['id']}" + suffix),
            404,
            "run_not_found",
        )
    # Deleting the Job does not remove historical run access.
    Jobs(app.state.services).delete("daily")
    assert call("GET", f"/runs/{run['id']}", actor="reader").status_code == 200


def test_authentication_service_token_revocation_and_session(api):
    app, call, _, tree, _, users = api
    error(call("GET", "/jobs", actor=None), 401, "unauthenticated")
    service = app.state.auth.create_user("scheduler", service=True)
    app.state.access.member(tree["project"], service["id"], "operator")
    token = app.state.auth.create_api_token(
        app.state.services.store.get("user", "admin"), service["id"], "Schedule"
    )
    users["service"] = (service, {"Authorization": "Bearer " + token["token"]})
    run = launch(call, actor="service")
    join_run(app.state.services.store, run["id"])
    assert run["requester"] == {"id": service["id"], "username": "scheduler", "token_name": "Schedule"}
    assert call("GET", "/jobs", actor="admin").status_code == 200
    app.state.access.member(tree["project"], service["id"], "reader")
    error(call("POST", "/jobs/daily/runs", {}, actor="service"), 403, "forbidden")
    app.state.services.store.delete("api_token", token["id"])
    error(call("GET", "/jobs", actor="service"), 401, "unauthenticated")


def test_idempotency_same_key_body_order_conflict_and_job_scope(api, instance):
    app, call, _, _, _, _ = api
    trigger = {"source": "airflow", "reference": "scheduled-1"}
    run = launch(call, body={"trigger": trigger}, key="retry")
    join_run(app.state.services.store, run["id"])
    retried = launch(
        call, body={"trigger": dict(reversed(list(trigger.items())))}, key="retry", actor="owner"
    )
    assert retried["id"] == run["id"] and retried["requester"] == run["requester"]
    error(call("POST", "/jobs/daily/runs", {}, key="retry"), 422, "invalid_request")
    test_jobs.create(instance, slug="second")
    other = call("POST", "/jobs/second/runs", {"trigger": trigger}, key="retry")
    assert other.status_code == 202 and other.json()["id"] != run["id"]
    join_run(app.state.services.store, other.json()["id"])
    assert len(app.state.services.store.all("run")) == 2


def test_concurrent_retries_are_one_run(api, monkeypatch):
    app, call, _, _, _, _ = api
    entered, release = hold_execution(app, monkeypatch)
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(lambda _: call("POST", "/jobs/daily/runs", {}, key="same"), range(8)))
        assert entered.is_set()
        assert {response.status_code for response in responses} == {202}
        assert len({response.json()["id"] for response in responses}) == 1
        assert len(app.state.services.store.all("run")) == 1
    finally:
        release.set()


def test_busy_refusal_is_logged_not_recorded_and_key_can_retry(api, monkeypatch, caplog):
    app, call, _, _, _, _ = api
    _, release = hold_execution(app, monkeypatch)
    caplog.set_level("INFO", logger="duckpad.execution")
    try:
        run = launch(call)
        refusal = call("POST", "/jobs/daily/runs", {}, key="later")
        error(refusal, 409, "job_busy")
        assert refusal.json()["detail"]["run"] == run["id"]
        assert "code=job_busy" in caplog.text
        # Edits refused on a running Job are not launch refusals.
        with pytest.raises(Problem, match="active execution"):
            Jobs(app.state.services).delete("daily")
        assert caplog.text.count("Job launch refused") == 1
        assert len(app.state.services.store.all("run")) == 1
        assert (
            app.state.services.store.job_launch("daily", hashlib.sha256(b"later").hexdigest(), time.time())
            is None
        )
    finally:
        release.set()
    join_run(app.state.services.store, run["id"])
    assert launch(call, key="later")["id"] != run["id"]


def test_idempotency_survives_reopen_and_expires_after_seven_days(api):
    app, call, _, _, _, users = api
    store = app.state.services.store
    before = time.time()
    run = launch(call, key="durable")
    join_run(store, run["id"])
    digest = hashlib.sha256(b"durable").hexdigest()
    reopened = Store(store.home)
    try:
        saved = reopened.job_launch("daily", digest, before)
        assert saved["run"] == run["id"]
        assert before + 7 * 86400 <= saved["expires"] <= time.time() + 7 * 86400
        assert reopened.job_launch("daily", digest, saved["expires"]) is None
    finally:
        reopened.close()
    restarted = create_app(store.home, watch=False)
    with TestClient(restarted) as client:
        replay = client.post(
            "/api/v1/jobs/daily/runs",
            json={},
            headers={**users["operator"][1], "Idempotency-Key": "durable"},
        )
        assert replay.status_code == 202 and replay.json()["id"] == run["id"]
    with store.transaction() as session:
        session.exec(text("UPDATE job_idempotency SET expires = 0"))
    assert launch(call, key="durable")["id"] != run["id"]


def test_key_and_run_are_atomic_before_execution(api, monkeypatch):
    app, call, _, _, _, _ = api
    store = app.state.services.store
    original = store.remember_job_launch

    def fail(*args):
        raise RuntimeError("Persistence unavailable")

    monkeypatch.setattr(store, "remember_job_launch", fail)
    assert call("POST", "/jobs/daily/runs", {}, key="atomic").status_code == 500
    assert store.all("run") == []
    assert not app.state.services.engine.active
    assert not app.state.services.engine.runs.threads
    monkeypatch.setattr(store, "remember_job_launch", original)
    assert launch(call, key="atomic")["id"]


def test_wait_timeout_completion_and_cancellation(api, monkeypatch):
    app, call, _, _, _, _ = api
    _, release = hold_execution(app, monkeypatch)
    try:
        run = launch(call)
        start = time.monotonic()
        waiting = call("GET", f"/runs/{run['id']}?wait=0.15")
        assert time.monotonic() - start >= 0.15
        assert waiting.json()["status"] == "preparing"
        for _ in range(2):
            assert call("POST", f"/runs/{run['id']}/cancel").json()["status"] == "canceling"
        with ThreadPoolExecutor() as pool:
            future = pool.submit(call, "GET", f"/runs/{run['id']}?wait=5")
            release.set()
            assert future.result(timeout=5).json()["status"] == "canceled"
    finally:
        release.set()
    assert call("POST", f"/runs/{run['id']}/cancel").json()["status"] == "canceled"


def test_many_waiters_release_worker_threads(api, monkeypatch):
    app, call, _, _, _, users = api
    _, release = hold_execution(app, monkeypatch)
    run = launch(call)

    async def check():
        limiter = anyio.to_thread.current_default_thread_limiter()
        previous = limiter.total_tokens
        limiter.total_tokens = 2
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://testserver", headers=users["operator"][1]
            ) as client:
                waiters = [
                    asyncio.create_task(client.get(f"/api/v1/runs/{run['id']}?wait=5")) for _ in range(6)
                ]
                await asyncio.sleep(0.1)
                response = await asyncio.wait_for(client.get("/api/v1/jobs"), timeout=1)
                assert response.status_code == 200
                release.set()
                results = await asyncio.wait_for(asyncio.gather(*waiters), timeout=4)
                assert all(result.json()["status"] == "success" for result in results)
        finally:
            limiter.total_tokens = previous
            release.set()

    asyncio.run(check())


@pytest.mark.parametrize(
    "body",
    [
        {"unexpected": True},
        {"trigger": {}},
        {"trigger": {"source": 4}},
        {"trigger": {"source": "x", "secret": "no"}},
        [],
    ],
)
def test_invalid_launch_body(api, body):
    _, call, *_ = api
    error(call("POST", "/jobs/daily/runs", body), 422, "invalid_request")


@pytest.mark.parametrize("wait", ["-1", "61", "nan", "infinity", "invalid"])
def test_invalid_wait(api, wait):
    _, call, *_ = api
    run = launch(call)
    error(call("GET", f"/runs/{run['id']}?wait=" + wait), 422, "invalid_request")


def test_missing_target_and_invalid_project_do_not_consume_keys(api):
    app, call, job, _, _, _ = api
    store = app.state.services.store
    record = store.get("job", job["slug"])
    record["target"] = {"kind": "branch", "branch": "absent"}
    store.put("job", job["slug"], record)
    error(call("POST", "/jobs/daily/runs", {}, key="fix"), 409, "target_unavailable")
    record["target"] = job["target"]
    record["scope"] = "missing-node"
    store.put("job", job["slug"], record)
    error(call("POST", "/jobs/daily/runs", {}, key="fix"), 422, "invalid_project")
    record["scope"] = None
    store.put("job", job["slug"], record)
    assert launch(call, key="fix")["id"]


def test_launch_errors_keep_their_status(api, monkeypatch):
    app, call, _, _, _, _ = api
    services = app.state.services
    join_run(services.store, launch(call)["id"])
    services.catalog.delete_environment("dev")
    error(call("POST", "/jobs/daily/runs", {}), 409, "target_unavailable")
    launch_job = Jobs.launch

    def deleted_after_authorization(self, slug, *args, **kwargs):
        services.store.delete("job", slug)
        return launch_job(self, slug, *args, **kwargs)

    monkeypatch.setattr(Jobs, "launch", deleted_after_authorization)
    error(call("POST", "/jobs/daily/runs", {}, key="gone"), 404, "job_not_found")
    assert len(services.store.all("run")) == 1


def test_text_log_messages_failure_and_terminal_control_escaping(api):
    app, call, _, _, _, _ = api
    run = launch(call)
    store = app.state.services.store
    internal = join_run(store, run["id"])
    internal.update(status="partial_failure", error="Execution failed")
    internal["nodes"]["source"].update(
        status="failed",
        error="Invalid source",
        external_outcome="partial or unknown",
        results=[
            {
                "level": "warning",
                "message": "Check this\nOutcome: forged\x1b[31m",
                "origin": {"kind": "message"},
            }
        ],
    )
    store.put("run", run["id"], internal)
    result = call("GET", f"/runs/{run['id']}/log")
    assert "warning: Check this\\u000aOutcome: forged\\u001b[31m" in result.text
    assert "error: Invalid source" in result.text
    assert "external outcome: partial or unknown" in result.text
    assert "Error: Execution failed" in result.text
    assert "Outcome: partial_failure" in result.text


def test_openapi_only_documents_public_routes_and_error_contract(api):
    _, call, *_ = api
    response = call("GET", "/openapi.json", actor="reader")
    assert response.status_code == 200, response.text
    schema = response.json()
    assert set(schema["paths"]) == {
        "/api/v1/jobs",
        "/api/v1/jobs/{slug}",
        "/api/v1/jobs/{slug}/runs",
        "/api/v1/runs/{run_id}",
        "/api/v1/runs/{run_id}/cancel",
        "/api/v1/runs/{run_id}/log",
    }
    assert schema["security"] == [{"BearerAuth": []}, {"SessionCookie": []}]
    assert schema["paths"]["/api/v1/jobs/{slug}/runs"]["post"]["responses"]["422"]["content"][
        "application/json"
    ]["schema"]["$ref"].endswith("/Error")
    assert "Run" in schema["components"]["schemas"]
    assert "text/plain" in schema["paths"]["/api/v1/runs/{run_id}/log"]["get"]["responses"]["200"]["content"]
