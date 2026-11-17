"""Scenarios: ordered Job steps, schedules, webhooks, admission, cancellation and notifications."""

import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from helpers import join_run, wait_until

from duckpad.app import create_app
from duckpad.schedules import Schedule
from duckpad.util import Problem

PARIS = ZoneInfo("Europe/Paris")
FLOW = {
    "name": "Scenarios",
    "nodes": [{"id": "value", "template": "value", "params": {"amount": {"$var": "amount"}}}],
    "edges": [],
}
TEMPLATE = "-- @param amount: number = 0\n-- @output result\nSELECT {{ amount }} AS amount;"


def at(text):
    return datetime.fromisoformat(text).astimezone(UTC)


def test_schedules_follow_daylight_saving_rules_and_cron_fields():
    daily = Schedule.parse("30 2 * * *", "Europe/Paris")
    # 02:30 does not exist on 29 March: the occurrence runs once, when the gap ends at 03:00.
    first = daily.next_after(at("2026-03-28T12:00:00+00:00"))
    assert first.astimezone(PARIS).isoformat() == "2026-03-29T03:00:00+02:00"
    assert daily.next_after(first).astimezone(PARIS).isoformat() == "2026-03-30T02:30:00+02:00"
    # 02:30 happens twice on 25 October: only its first occurrence runs.
    autumn = daily.next_after(at("2026-10-24T12:00:00+00:00"))
    assert autumn.astimezone(PARIS).isoformat() == "2026-10-25T02:30:00+02:00"
    assert daily.next_after(autumn).astimezone(PARIS).isoformat() == "2026-10-26T02:30:00+01:00"
    half_hours = Schedule.parse("*/30 1-3 * * *", "Europe/Paris")
    spring = half_hours.between(at("2026-03-29T00:00:00+01:00"), at("2026-03-29T04:00:00+02:00"))
    assert [item.astimezone(PARIS).strftime("%H:%M") for item in spring] == [
        "01:00",
        "01:30",
        "03:00",
        "03:30",
    ]
    fall = half_hours.between(at("2026-10-25T00:00:00+02:00"), at("2026-10-25T04:00:00+01:00"))
    assert [item.astimezone(PARIS).strftime("%H:%M%z") for item in fall] == [
        "01:00+0200",
        "01:30+0200",
        "02:00+0200",
        "02:30+0200",
        "03:00+0100",
        "03:30+0100",
    ]
    # Restricted day of month and day of week match either, as in Vixie cron.
    either = Schedule.parse("0 9 13 * fri", "UTC")
    days = [
        item.day for item in either.between(at("2026-11-01T00:00:00+00:00"), at("2026-12-01T00:00:00+00:00"))
    ]
    assert days == [6, 13, 20, 27]
    weekdays = Schedule.parse("0 9 * jan-mar mon-fri", "America/New_York")
    assert weekdays.next_after(at("2026-11-17T00:00:00+00:00")).isoformat() == "2027-01-01T14:00:00+00:00"
    assert Schedule.parse("@weekly", "UTC").next_after(at("2026-11-17T00:00:00+00:00")).day == 22
    leap = Schedule.parse("0 0 29 2 *", "UTC").next_after(at("2026-11-17T00:00:00+00:00"))
    assert leap.isoformat() == "2028-02-29T00:00:00+00:00"
    for expression, message in (
        ("", "Enter a cron expression"),
        ("* * * *", "five fields"),
        ("60 * * * *", "minute field accepts 0 to 59"),
        ("*/0 * * * *", "Invalid minute step"),
        ("5-1 * * * *", "Invalid minute range"),
        ("0 0 31 2 *", "never occurs"),
        ("0 0 * * funday", "Invalid day of week value"),
    ):
        with pytest.raises(Problem, match=message):
            Schedule.parse(expression, "UTC")
    for zone in ("Mars/Olympus", "../etc/passwd", ""):
        with pytest.raises(Problem, match="Unknown time zone"):
            Schedule.parse("@daily", zone)


@pytest.fixture
def instance(tmp_path):
    app = create_app(tmp_path / "instance", watch=False, schedule=False)
    with TestClient(app) as client:
        yield setup(app, client)


def setup(app, client):
    auth, services = app.state.auth, app.state.services
    users = {}
    for role in ("owner", "reader", "operator", "editor", "outsider"):
        user = auth.create_user(role, "scenario-test-password")
        token = auth.create_api_token(user, user["id"], "Tests")["token"]
        users[role] = (user, {"authorization": "Bearer " + token})
    token = auth.login("admin", auth.initial_password)
    users["admin"] = ({"id": "admin"}, {"authorization": "Bearer " + token})
    tree = client.post("/api/projects", headers=users["owner"][1], json={"name": "Scenarios"}).json()
    for role in ("reader", "operator", "editor"):
        app.state.access.member(tree["project"], users[role][0]["id"], role)
    projects = services.projects

    def version(tag, sql):
        snapshot = projects.snapshot(tree["id"])
        files = {
            **snapshot["files"],
            "flow.json": json.dumps({"id": tree["project"], **FLOW}),
            "templates/value.sql": sql,
            "variables.json": json.dumps({"amount": {"type": "number", "default": 1}}),
        }
        snapshot = projects.write(tree["id"], snapshot["revision"], files)
        projects.versioning.create_tag(tree["id"], tag, snapshot["commit"], "Accepted")

    version("v1", TEMPLATE)
    version("broken", "-- @param amount: number = 0\n-- @output result\nSELECT error('boom') AS amount;")

    def call(method, path, data=None, actor="owner", headers=None):
        return client.request(
            method, "/api" + path, headers={**users[actor][1], **(headers or {})}, json=data
        )

    for slug, ref, environment in (
        ("load", "v1", "dev"),
        ("report", "v1", "dev"),
        ("broken", "broken", "dev"),
    ):
        response = call(
            "POST",
            f"/projects/{tree['project']}/jobs",
            {
                "slug": slug,
                "name": slug.title(),
                "environment": environment,
                "target": {"kind": "tag", "ref": ref},
            },
        )
        assert response.status_code == 201, response.text
    return app, tree, call, users


def create(instance, slug="nightly", steps=("load",), **changes):
    _, tree, call, _ = instance
    response = call(
        "POST",
        f"/projects/{tree['project']}/scenarios",
        {
            "slug": slug,
            "name": slug.title(),
            "steps": [step if isinstance(step, dict) else {"job": step} for step in steps],
            **changes,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def finished(app, run_id, timeout=30):
    store = app.state.services.store
    wait_until(
        lambda: store.get("scenario_run", run_id)["status"] not in ("running", "canceling"),
        timeout,
        "Scenario run did not finish",
    )
    return store.get("scenario_run", run_id)


def history(call, slug):
    return call("GET", f"/scenarios/{slug}/runs").json()


def test_manual_runs_execute_steps_in_order_with_typed_launch_values(instance):
    app, tree, call, _ = instance
    store = app.state.services.store
    scenario = create(instance, steps=("load", "report"), parameters=["amount"], description="Two steps")
    assert [step["name"] for step in scenario["steps"]] == ["Load", "Report"]
    assert scenario["parameters"] == [{"name": "amount", "type": "number"}]
    assert call("GET", f"/projects/{tree['project']}/scenarios", actor="reader").status_code == 200
    assert call("GET", "/scenarios/nightly", actor="outsider").status_code == 404
    assert call("POST", "/scenarios/nightly/runs", {}, actor="reader").status_code == 403
    for invalid in ({"amount": "five"}, {"other": 1}):
        response = call("POST", "/scenarios/nightly/runs", {"parameters": invalid}, actor="operator")
        assert response.status_code == 422, response.text
    response = call("POST", "/scenarios/nightly/runs", {"parameters": {"amount": 5}}, actor="operator")
    assert response.status_code == 202, response.text
    run = finished(app, response.json()["id"])
    assert run["status"] == "success", run
    assert [step["status"] for step in run["steps"]] == ["success", "success"]
    assert run["trigger"] == {"source": "manual"} and run["requester"]["username"] == "operator"
    assert run["parameters"] == {"amount": 5}
    first, second = (store.get("run", step["run"]) for step in run["steps"])
    assert first["finished"] <= second["started"]
    assert first["job"]["scenario"] == {"slug": "nightly", "name": "Nightly", "run": run["id"]}
    assert first["external_trigger"] == {"source": "scenario", "reference": f"nightly/{run['id']}"}
    assert first["launch_values"] == {"amount": 5}
    assert first["variables"]["amount"] == {"type": "number", "value": 5, "source": "launch"}
    assert first["requester"]["username"] == "operator"
    assert [item["id"] for item in history(call, "nightly")] == [run["id"]]
    assert call("GET", "/scenarios/nightly", actor="reader").json()["last_run"]["id"] == run["id"]
    # A launch value never changes the version: the Job alone still uses variables.json.
    plain = join_run(store, call("POST", "/jobs/load/runs", {}, actor="operator").json()["id"])
    assert plain["variables"]["amount"]["value"] == 1 and "launch_values" not in plain


def test_definitions_are_validated_and_only_administrators_change_them(instance):
    _, tree, call, _ = instance
    path = f"/projects/{tree['project']}/scenarios"
    base = {"slug": "checks", "name": "Checks", "steps": [{"job": "load"}]}
    assert call("POST", path, base, actor="editor").status_code == 403
    for changes, message in (
        ({"steps": []}, "Invalid request"),
        ({"steps": [{"job": "missing"}]}, "Step 1: choose a Job of this project"),
        ({"steps": [{"job": "load", "run_if": "sometimes"}]}, "Invalid request"),
        ({"parameters": ["missing"]}, "missing is not a variable"),
        ({"schedules": [{"cron": "0 25 * * *"}]}, "Schedule 1: The hour field accepts 0 to 23"),
        ({"schedules": [{"cron": "@daily", "timezone": "Nowhere/City"}]}, "Unknown time zone"),
        ({"notifications": [{"destination": "dst_missing"}]}, "notification destination"),
        ({"slug": "Bad Slug"}, "Invalid request"),
    ):
        response = call("POST", path, {**base, **changes})
        assert response.status_code == 422, (changes, response.text)
        assert message in response.json()["error"], response.json()
    scenario = create(instance, "checks", schedules=[{"cron": "0 2 * * *", "timezone": "Europe/Paris"}])
    assert call("POST", path, base).status_code == 409
    assert at(scenario["schedules"][0]["next"]) > datetime.now(UTC)
    preview = call("GET", "/schedule-preview?cron=0+2+*+*+*&timezone=Europe/Paris", actor="reader").json()
    assert preview["next"][0] == scenario["schedules"][0]["next"] and len(preview["next"]) == 3
    assert call("GET", "/schedule-preview?cron=0+0+31+2+*").status_code == 422
    edit = {**base, "name": "Renamed", "revision": scenario["revision"]}
    edit.pop("slug")
    assert call("PATCH", "/scenarios/checks", edit, actor="operator").status_code == 403
    assert call("PATCH", "/scenarios/checks", edit).json()["name"] == "Renamed"
    assert call("PATCH", "/scenarios/checks", edit).status_code == 409
    # A Job a scenario runs is not deleted from under it.
    response = call("DELETE", "/jobs/load")
    assert response.status_code == 409 and response.json()["detail"]["scenarios"] == ["Renamed"]
    assert call("GET", "/jobs/load/variables", actor="reader").json() == {
        "amount": {"type": "number", "description": ""}
    }
    assert call("DELETE", "/scenarios/checks").status_code == 200
    assert call("DELETE", "/jobs/load").status_code == 200


def test_step_conditions_and_overall_outcome(instance):
    app, _, call, _ = instance
    create(
        instance,
        steps=(
            "broken",
            {"job": "load", "run_if": "success"},
            {"job": "report", "run_if": "failure"},
            {"job": "load", "run_if": "always"},
        ),
    )
    run = finished(app, call("POST", "/scenarios/nightly/runs", {}, actor="operator").json()["id"])
    assert [step["status"] for step in run["steps"]] == ["failed", "skipped", "success", "success"]
    assert run["status"] == "failed"
    assert "boom" in run["steps"][0]["error"]
    create(instance, "clean", steps=("load", {"job": "broken", "run_if": "failure"}))
    run = finished(app, call("POST", "/scenarios/clean/runs", {}, actor="operator").json()["id"])
    assert [step["status"] for step in run["steps"]] == ["success", "skipped"]
    assert run["status"] == "success"


@pytest.fixture
def held(instance, monkeypatch):
    """Hold Job executions until released."""
    app = instance[0]
    runs = app.state.services.engine.runs
    release = threading.Event()
    original = runs._execute

    def execute(*args):
        assert release.wait(20)
        original(*args)

    monkeypatch.setattr(runs, "_execute", execute)
    yield release
    release.set()


def webhook(call, slug, delivery, parameters=None, actor="operator"):
    return call(
        "POST",
        f"/v1/scenarios/{slug}/webhook",
        {"parameters": parameters or {}},
        actor=actor,
        headers={"Webhook-Id": delivery} if delivery else None,
    )


def test_busy_and_disabled_triggers_are_refused_visibly_without_queuing(instance, held):
    app, _, call, _ = instance
    store = app.state.services.store
    create(instance, webhook=True)
    job_run = call("POST", "/jobs/load/runs", {}, actor="operator").json()
    response = call("POST", "/scenarios/nightly/runs", {}, actor="operator")
    assert response.status_code == 409 and response.json()["detail"] == {
        "code": "job_busy",
        "run": job_run["id"],
    }
    # A person sees the refusal; it is not recorded.
    assert history(call, "nightly") == []
    response = webhook(call, "nightly", "delivery-1")
    assert response.status_code == 409 and response.json()["detail"]["code"] == "job_busy"
    [rejected] = history(call, "nightly")
    assert rejected["status"] == "rejected" and rejected["detail"]["run"] == job_run["id"]
    assert rejected["trigger"] == {"source": "webhook", "delivery": "delivery-1"}
    assert rejected["requester"]["username"] == "operator" and rejected["steps"] == []
    held.set()
    assert join_run(store, job_run["id"])["status"] == "success"
    # A refused delivery left no run: the sender's retry starts one.
    retried = webhook(call, "nightly", "delivery-1")
    assert retried.status_code == 202, retried.text
    assert finished(app, retried.json()["id"])["status"] == "success"
    held.clear()
    active = call("POST", "/scenarios/nightly/runs", {}, actor="operator").json()
    response = webhook(call, "nightly", "delivery-2")
    assert response.status_code == 409 and response.json()["detail"] == {
        "code": "scenario_busy",
        "run": active["id"],
    }
    assert call("DELETE", "/scenarios/nightly").status_code == 409
    held.set()
    finished(app, active["id"])
    scenario = call("GET", "/scenarios/nightly").json()
    fields = {key: scenario[key] for key in ("name", "description", "parameters", "schedules", "webhook")}
    changes = {
        **fields,
        "parameters": [],
        "schedules": [{"cron": "* * * * *", "timezone": "UTC"}],
        "steps": [{"job": "load"}],
        "enabled": False,
        "revision": scenario["revision"],
    }
    assert call("PATCH", "/scenarios/nightly", changes).status_code == 200
    response = webhook(call, "nightly", "delivery-3")
    assert response.status_code == 409 and response.json()["detail"]["code"] == "scenario_disabled"
    count = len(history(call, "nightly"))
    app.state.scenarios.tick(datetime(2100, 1, 1, tzinfo=UTC))
    assert len(history(call, "nightly")) == count
    # A disabled scenario still runs when someone asks for it.
    assert call("POST", "/scenarios/nightly/runs", {}, actor="operator").status_code == 202


def test_webhooks_need_operator_tokens_and_ignore_duplicate_deliveries(instance):
    app, _, call, _ = instance
    create(instance, parameters=["amount"], webhook=True)
    create(instance, "closed")
    assert webhook(call, "nightly", "d1", actor="reader").status_code == 403
    response = webhook(call, "nightly", "d1", actor="outsider")
    assert response.status_code == 404 and response.json()["detail"]["code"] == "scenario_not_found"
    response = webhook(call, "nightly", None)
    assert response.status_code == 422 and response.json()["detail"]["code"] == "invalid_request"
    response = webhook(call, "nightly", "d1", {"other": 1})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "invalid_request"
    response = call(
        "POST",
        "/v1/scenarios/nightly/webhook",
        {"parameters": {}, "sql": "DROP TABLE x"},
        headers={"Webhook-Id": "x"},
    )
    assert response.status_code == 422
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: webhook(call, "nightly", "d1", {"amount": 3}), range(4)))
    assert {response.status_code for response in responses} == {202}
    assert len({response.json()["id"] for response in responses}) == 1
    assert sorted(response.json()["duplicate"] for response in responses) == [False, True, True, True]
    run = finished(app, responses[0].json()["id"])
    assert run["status"] == "success" and run["parameters"] == {"amount": 3}
    again = webhook(call, "nightly", "d1", {"amount": 3})
    assert again.status_code == 202 and again.json()["id"] == run["id"] and again.json()["duplicate"]
    assert again.json()["status"] == "success" and again.json()["steps"][0]["run"]
    assert len(history(call, "nightly")) == 1
    response = webhook(call, "closed", "d1")
    assert response.status_code == 409 and response.json()["detail"]["code"] == "webhook_disabled"
    assert history(call, "closed")[0]["status"] == "rejected"
    openapi = call("GET", "/v1/openapi.json").json()
    assert "/api/v1/scenarios/{scenario}/webhook" in openapi["paths"]


def test_protected_environments_need_a_person_to_confirm(instance):
    app, tree, call, _ = instance
    response = call(
        "POST",
        f"/projects/{tree['project']}/jobs",
        {
            "slug": "load-prod",
            "name": "Load prod",
            "environment": "prod",
            "target": {"kind": "tag", "ref": "v1"},
        },
    )
    assert response.status_code == 201, response.text
    create(instance, steps=("load", "load-prod"), webhook=True)
    response = call("POST", "/scenarios/nightly/runs", {}, actor="operator")
    assert response.status_code == 409
    assert [item["id"] for item in response.json()["detail"]["confirmation_required"]] == ["prod"]
    response = call("POST", "/scenarios/nightly/runs", {"confirmed": True}, actor="operator")
    assert response.status_code == 202
    assert finished(app, response.json()["id"])["status"] == "success"
    # Creating the scenario confirmed its environments for automatic triggers.
    response = webhook(call, "nightly", "confirmed-by-definition")
    assert response.status_code == 202
    assert finished(app, response.json()["id"])["status"] == "success"


def test_cancellation_stops_the_active_step_and_skips_the_rest(instance, held):
    app, _, call, _ = instance
    create(instance, steps=("load", {"job": "report", "run_if": "always"}))
    run = call("POST", "/scenarios/nightly/runs", {}, actor="operator").json()
    store = app.state.services.store
    wait_until(lambda: store.get("scenario_run", run["id"])["steps"][0].get("run"))
    assert call("POST", f"/scenario-runs/{run['id']}/cancel", {}, actor="reader").status_code == 403
    response = call("POST", f"/scenario-runs/{run['id']}/cancel", {}, actor="operator")
    assert response.status_code == 200 and response.json()["status"] == "canceling"
    held.set()
    run = finished(app, run["id"])
    assert run["status"] == "canceled"
    assert [step["status"] for step in run["steps"]] == ["canceled", "skipped"]
    assert (
        call("POST", f"/scenario-runs/{run['id']}/cancel", {}, actor="operator").json()["status"]
        == "canceled"
    )


def test_schedules_survive_restarts_and_record_missed_occurrences(tmp_path):
    home = tmp_path / "instance"
    app = create_app(home, watch=False, schedule=False)
    with TestClient(app) as client:
        instance = setup(app, client)
        create(instance, schedules=[{"cron": "0 2 * * *", "timezone": "Europe/Paris"}])
        store = app.state.services.store
        scenario = store.get("scenario", "nightly")
        scenario["schedules"][0]["next"] = "2026-01-01T01:00:00+00:00"
        store.put("scenario", "nightly", scenario)
    app = create_app(home, watch=False, schedule=False)
    with TestClient(app):
        scenarios, store = app.state.scenarios, app.state.services.store
        assert store.get("scenario", "nightly")["schedules"][0]["next"] == "2026-01-01T01:00:00+00:00"
        # Restarted shortly after the third occurrence: two were missed, the third runs late.
        scenarios.tick(at("2026-01-03T01:01:30+00:00"))
        launched, missed = store.scenario_runs("nightly")
        assert missed["status"] == "missed" and launched["status"] in ("running", "success")
        assert missed["trigger"]["missed"] == 2
        assert missed["trigger"]["occurrence"] == "2026-01-01T01:00:00+00:00"
        assert launched["trigger"] == {
            "source": "schedule",
            "cron": "0 2 * * *",
            "timezone": "Europe/Paris",
            "occurrence": "2026-01-03T01:00:00+00:00",
        }
        assert launched["requester"]["username"] == "schedule"
        assert finished(app, launched["id"])["status"] == "success"
        assert store.get("scenario", "nightly")["schedules"][0]["next"] == "2026-01-04T01:00:00+00:00"
        scenarios.tick(at("2026-01-03T01:02:00+00:00"))
        assert len(store.scenario_runs("nightly")) == 2


def test_restart_interrupts_active_scenario_runs(tmp_path):
    home = tmp_path / "instance"
    app = create_app(home, watch=False, schedule=False)
    with TestClient(app) as client:
        instance = setup(app, client)
        create(instance, steps=("load", "report"))
        store = app.state.services.store
        store.put(
            "scenario_run",
            "scn_left",
            {
                "scenario": "nightly",
                "status": "running",
                "started": "2026-01-01T00:00:00+00:00",
                "finished": None,
                "delivery": None,
                "name": "Nightly",
                "project": instance[1]["project"],
                "trigger": {"source": "manual"},
                "requester": None,
                "parameters": {},
                "steps": [
                    {"job": "load", "name": "Load", "run_if": "success", "status": "running"},
                    {"job": "report", "name": "Report", "run_if": "success", "status": "pending"},
                ],
                "notify": [],
                "notifications": [],
            },
        )
    app = create_app(home, watch=False, schedule=False)
    with TestClient(app):
        run = app.state.services.store.get("scenario_run", "scn_left")
        assert run["status"] == "interrupted" and run["finished"]
        assert [step["status"] for step in run["steps"]] == ["interrupted", "skipped"]


@pytest.fixture
def receiver():
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["content-length"]))
            received.append((self.path, json.loads(body)))
            self.send_response(204 if self.path == "/hook" else 500)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", received
    server.shutdown()
    server.server_close()


def test_notifications_follow_outcome_rules_and_failures_are_recorded_apart(instance, receiver):
    app, _, call, _ = instance
    base, received = receiver
    settings = {
        "destinations": [
            {"name": "Ops", "kind": "webhook", "url": base + "/hook"},
            {"name": "Failing", "kind": "webhook", "url": base + "/error"},
        ]
    }
    assert call("PUT", "/notification-settings", settings).status_code == 403
    saved = call("PUT", "/notification-settings", settings, actor="admin")
    assert saved.status_code == 200, saved.text
    ops, failing = saved.json()["destinations"]
    assert "url" not in ops and ops["url_host"] == base.removeprefix("http://")
    # A blank URL keeps the saved one; the URL never comes back.
    kept = call(
        "PUT",
        "/notification-settings",
        {
            "destinations": [
                {"id": ops["id"], "name": "Ops", "kind": "webhook"},
                {**settings["destinations"][1], "id": failing["id"]},
            ]
        },
        actor="admin",
    )
    assert kept.status_code == 200 and kept.json()["destinations"][0]["url_host"] == ops["url_host"]
    with closing(sqlite3.connect(app.state.services.store.paths.database)) as connection:
        stored = json.dumps(
            connection.execute("SELECT value FROM setting WHERE id = 'notifications'").fetchone()
        )
    assert "/hook" not in stored and "/error" not in stored
    assert call("GET", "/notification-destinations", actor="reader").json() == [
        {"id": ops["id"], "name": "Ops", "kind": "webhook"},
        {"id": failing["id"], "name": "Failing", "kind": "webhook"},
    ]
    email = {"destinations": [{"name": "Team", "kind": "email", "recipients": ["team@example.com"]}]}
    response = call("PUT", "/notification-settings", email, actor="admin")
    assert response.status_code == 422 and "SMTP" in response.json()["error"]
    assert (
        call("POST", "/notification-settings/test", {"destination": ops["id"]}, actor="admin").status_code
        == 200
    )
    assert [(path, payload["event"]) for path, payload in received] == [("/hook", "test")]
    response = call("POST", "/notification-settings/test", {"destination": failing["id"]}, actor="admin")
    assert response.status_code == 502 and "HTTP 500" in response.json()["error"]
    received.clear()
    notifications = [
        {"destination": ops["id"], "on": "always"},
        {"destination": failing["id"], "on": "failure"},
    ]
    create(instance, notifications=notifications)
    run = finished(app, call("POST", "/scenarios/nightly/runs", {}, actor="operator").json()["id"])
    wait_until(lambda: app.state.services.store.get("scenario_run", run["id"])["notifications"])
    run = app.state.services.store.get("scenario_run", run["id"])
    assert run["status"] == "success"
    assert [(item["name"], item["status"]) for item in run["notifications"]] == [("Ops", "sent")]
    [(path, payload)] = received
    assert path == "/hook" and payload["event"] == "scenario.finished"
    assert payload["run"]["status"] == "success" and payload["scenario"]["slug"] == "nightly"
    assert payload["steps"][0]["status"] == "success" and "Nightly" in payload["text"]
    received.clear()
    create(instance, "fragile", steps=("broken",), notifications=notifications)
    run = finished(app, call("POST", "/scenarios/fragile/runs", {}, actor="operator").json()["id"])
    wait_until(lambda: app.state.services.store.get("scenario_run", run["id"])["notifications"])
    run = app.state.services.store.get("scenario_run", run["id"])
    # A failed delivery is recorded on its own; it changes nothing else and is not retried.
    assert run["status"] == "failed" and len(run["steps"]) == 1
    assert [(item["name"], item["status"]) for item in run["notifications"]] == [
        ("Ops", "sent"),
        ("Failing", "failed"),
    ]
    assert "HTTP 500" in run["notifications"][1]["error"]
    assert sorted(path for path, _ in received) == ["/error", "/hook"]
    assert len(app.state.services.store.all("run")) == 2
