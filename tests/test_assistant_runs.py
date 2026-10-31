"""Deferred execution survives reconnects without bypassing approval or project access."""

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from test_assistant import configure, conversation, project, turn
from test_assistant import instance as instance

from duckpad.app import create_app
from duckpad.assistant.runs import cancel_run, compare_run, inspect_run, read_run_sql, wait_for_run
from duckpad.assistant.tools import Dependencies
from duckpad.bundle import bundle_to_files
from duckpad.util import Problem


def run_model(args=None, count=1):
    async def stream(messages, info):
        returned = [p for p in messages[-1].parts if isinstance(p, ToolReturnPart)]
        if returned:
            yield json.dumps([p.content for p in returned])
        else:
            yield {
                i: DeltaToolCall(
                    name="launch_run", json_args=json.dumps(args or {}), tool_call_id=f"run-call-{i}"
                )
                for i in range(count)
            }

    return FunctionModel(stream_function=stream)


def request_run(app, client, context, args=None, count=1):
    app.state.assistant.configuration.model_override = run_model(args, count)
    identity = conversation(client, context)
    result = turn(client, identity, context, "Run the flow")[-1]["turn"]
    assert result["status"] == "awaiting_approval", result
    assert client.get(f"/api/runs?worktree={context['worktree']}").json() == []
    return identity, result


def decide(client, identity, result, approved=True, tool="run-call-0"):
    return client.post(
        f"/api/assistant/conversations/{identity}/approvals",
        json={
            "turn": result["id"],
            "tool": tool,
            "approved": approved,
        },
    )


def final(response):
    assert response.status_code == 200, response.text
    return json.loads(response.text.splitlines()[-1])["turn"]


def test_approval_survives_restart_and_records_entry_point(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    identity, requested = request_run(app, client, context)
    # A fresh service/process has no in-memory approval state.
    restarted = create_app(app.state.services.store.home, watch=False)
    restarted.state.assistant.configuration.model_override = run_model()
    with TestClient(restarted) as resumed:
        resumed.cookies.update(client.cookies)
        saved = resumed.get(f"/api/assistant/conversations/{identity}").json()["turns"][-1]
        assert saved == requested
        result = final(decide(resumed, identity, saved))
        assert result["status"] == "complete", result
        runs = resumed.get(f"/api/runs?worktree={context['worktree']}").json()
        assert len(runs) == 1
        assert runs[0]["entry_point"] == "assistant"
        assert runs[0]["requester"]["id"] == "admin"
        assert runs[0]["id"] in result["text"]
        assert result["tools"][0]["run"]["id"] == runs[0]["id"]
        assert decide(resumed, identity, saved).status_code == 409


def test_denial_is_returned_to_model_and_chat_can_continue(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    identity, requested = request_run(app, client, context)
    result = final(decide(client, identity, requested, False))
    assert result["status"] == "complete", result
    assert "denied" in result["text"].lower()
    assert client.get("/api/runs").json() == []
    assert turn(client, identity, context)[-1]["turn"]["status"] == "awaiting_approval"


def test_partial_batch_never_executes_and_replays_are_rejected(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    identity, requested = request_run(app, client, context, count=2)
    partial = final(decide(client, identity, requested))
    assert partial["status"] == "awaiting_approval"
    assert client.get("/api/runs").json() == []
    assert decide(client, identity, requested).status_code == 409
    result = final(decide(client, identity, requested, False, "run-call-1"))
    assert result["status"] == "complete", result
    assert len(client.get("/api/runs").json()) == 1


def test_lost_resume_is_closed_without_replay(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    identity, requested = request_run(app, client, context)
    # A restart or disconnect can end an accepted resume before its stream records an outcome.
    store = app.state.services.store
    record = store.get("assistant_conversation", identity)
    record["turns"][-1]["status"] = "resuming"
    record["turns"][-1]["tools"][0].update(status="approved")
    record["turns"][-1]["tools"][0]["approval"]["decision"] = True
    store.put("assistant_conversation", identity, record)
    assert decide(client, identity, requested).status_code == 409
    result = turn(client, identity, context, "What happened?")[-1]["turn"]
    assert result["status"] == "complete", result
    assert "interrupted" in result["text"]
    lost = client.get(f"/api/assistant/conversations/{identity}").json()["turns"][0]
    assert lost["status"] == "stopped" and lost["tools"][0]["status"] == "stopped"
    assert client.get("/api/runs").json() == []


def test_protected_environment_and_changed_configuration(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    app.state.services.catalog.save_environment(
        {"id": "dev", "label": "Development", "color": "blue", "confirm_before_run": True}
    )
    identity, requested = request_run(app, client, context)
    approval = requested["tools"][0]["approval"]
    assert approval["confirm_before_run"] is True
    assert approval["environment"] == "dev"
    assert "variables" in approval and "exports" in approval
    app.state.services.catalog.save_environment(
        {"id": "dev", "label": "Changed", "color": "blue", "confirm_before_run": True}
    )
    result = final(decide(client, identity, requested))
    assert "configuration changed" in result["text"]
    assert client.get("/api/runs").json() == []


def test_approval_is_owned_and_permissions_are_rechecked(instance):
    app, admin = instance
    configure(admin)
    _, context = project(admin)
    user = app.state.auth.create_user("editor", "editor-password-123")
    app.state.access.member(context["project"], user["id"], "editor")
    with TestClient(app) as client:
        client.post("/api/login", json={"username": "editor", "password": "editor-password-123"})
        identity, requested = request_run(app, client, context)
        assert decide(admin, identity, requested).status_code == 404
        app.state.access.member(context["project"], user["id"], "reader")
        assert (
            client.post(f"/api/worktrees/{context['worktree']}/runs", json={"environment": "dev"}).status_code
            == 403
        )
        response = decide(client, identity, requested)
        assert response.status_code == 403
        assert admin.get("/api/runs").json() == []


def test_quick_prompts_default_custom_empty_and_admin_only(instance):
    app, client = instance
    configure(client)
    assert client.get("/api/assistant/options").json()["quick_prompts"] is None
    prompts = [{"label": "Optimize", "prompt": "Find simpler transformations."}]
    assert configure(client, quick_prompts=prompts).status_code == 200
    assert client.get("/api/assistant/options").json()["quick_prompts"] == prompts
    assert configure(client, quick_prompts=[]).status_code == 200
    assert client.get("/api/assistant/options").json()["quick_prompts"] == []
    assert configure(client, quick_prompts=[{"label": " ", "prompt": "x"}]).status_code == 422
    app.state.auth.create_user("reader", "reader-password-123")
    with TestClient(app) as reader:
        reader.post("/api/login", json={"username": "reader", "password": "reader-password-123"})
        assert configure(reader, quick_prompts=prompts).status_code == 403


def test_export_warning_and_variables_match_the_requested_scope(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    projects = app.state.services.projects
    snapshot = projects.snapshot(context["worktree"])
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"] = [
        {"id": "source", "params": {"amount": {"$var": "threshold"}}},
        {"id": "export", "params": {}},
    ]
    bundle["flow"]["edges"] = [
        {
            "id": "edge",
            "source": "source",
            "sourceHandle": "result",
            "target": "export",
            "targetHandle": "rows",
        }
    ]
    bundle["variables"] = {"threshold": {"type": "number", "default": 5}}
    bundle["node_sql"] = {
        "nodes/source.sql": "-- @param amount: number = 1\n-- @output result\nSELECT {{ amount }} AS value;",
        "nodes/export.sql": '-- @kind export\n-- @input rows\n-- @param connection: connection = "local"\n-- @param target: destination(connection) = "approval.csv"\nCOPY {{ rows }} TO {{ target }} (FORMAT CSV);',
    }
    projects.write(context["worktree"], snapshot["revision"], bundle_to_files(bundle))
    identity, requested = request_run(app, client, context)
    plan = requested["tools"][0]["approval"]
    assert plan["node_count"] == 2
    assert plan["variables"]["threshold"]["value"] == 5
    assert plan["exports"] == [{"node": "export", "label": "export", "connections": ["local"]}]
    final(decide(client, identity, requested, False))
    identity, requested = request_run(app, client, context, {"node": "source", "environment": "dev"})
    plan = requested["tools"][0]["approval"]
    assert plan["node_count"] == 1 and plan["exports"] == []
    result = final(decide(client, identity, requested))
    assert result["tools"][0]["run"]["scope"] == "source"


def test_actual_run_diagnostics_and_error_context_keep_the_failed_run(instance):
    from helpers import join_run
    from test_assistant import dependencies

    app, client = instance
    configure(client)
    _, context = project(client)
    services = app.state.services
    snapshot = services.projects.snapshot(context["worktree"])
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"] = [{"id": "source", "params": {}}]
    bundle["node_sql"] = {
        "nodes/source.sql": "-- @output result\nSELECT 1 AS value;\n-- @message\nSELECT 'info' AS level, 'Ready' AS message;\n-- @test positive\nSELECT * FROM {{ result }} WHERE value < 0;"
    }
    services.projects.write(context["worktree"], snapshot["revision"], bundle_to_files(bundle))
    good = join_run(services.store, services.engine.launch(context["worktree"], "dev")["id"])
    assert good["status"] == "success"
    snapshot = services.projects.snapshot(context["worktree"])
    bundle["node_sql"]["nodes/source.sql"] = "-- @output result\nSELECT missing_column;"
    services.projects.write(context["worktree"], snapshot["revision"], bundle_to_files(bundle))
    bad = join_run(services.store, services.engine.launch(context["worktree"], "dev")["id"])
    assert bad["status"] == "failed"
    status = services.engine.statuses(context["worktree"], "dev")["nodes"]["source"]
    assert status["result_run"] == good["id"]
    assert status["error_run"] == bad["id"]
    ctx = dependencies(app, client, context)
    assert "missing_column" in inspect_run(ctx, bad["id"], "source")["error"]
    results = inspect_run(ctx, good["id"], "source")["items"]
    assert len(results) == 2
    assert any(item["origin"]["kind"] == "test" for item in results)
    assert "SELECT 1" in json.dumps(read_run_sql(ctx, good["id"], "source"))
    assert compare_run(ctx, bad["id"])["previous"] == good["id"]


def test_debug_respects_data_policy_and_historical_connection_grants(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    services = app.state.services
    record = {
        "id": "run_before",
        "project": context["project"],
        "worktree": context["worktree"],
        "branch": "main",
        "environment": "dev",
        "scope": "project",
        "started": "2026-01-01",
        "status": "success",
        "commit": "before",
        "nodes": {},
        "connections": {},
    }
    services.store.put("run", record["id"], record)
    record.update(
        id="run_after",
        started="2026-01-02",
        status="failed",
        error="private value",
        nodes={
            "source": {
                "status": "failed",
                "error": "private value",
                "results": [{"message": "private value"}],
                "statements": [{"sql": "SELECT 'private value'"}],
            }
        },
    )
    services.store.put("run", record["id"], record)
    deps = Dependencies(
        services,
        app.state.auth,
        client.cookies.get("duckpad_session"),
        app.state.assistant.configuration,
        app.state.assistant.configuration.get()["revision"],
        context,
    )
    ctx = SimpleNamespace(deps=deps)
    assert inspect_run(ctx, "run_after")["error"] == "private value"
    assert read_run_sql(ctx, "run_after", "source")["items"][0]["sql"] == "SELECT 'private value'"
    assert compare_run(ctx, "run_after")["previous"] == "run_before"
    assert wait_for_run(ctx, "run_after", 0)["status"] == "failed"
    configure(client, allow_data=False)
    deps.revision = deps.configuration.get()["revision"]
    assert "private value" not in json.dumps(inspect_run(ctx, "run_after", "source"))
    assert "private value" not in json.dumps(compare_run(ctx, "run_after"))
    with pytest.raises(Problem, match="cannot read data"):
        read_run_sql(ctx, "run_after", "source")
    record["connections"] = {"revoked": {}}
    services.store.put("run", record["id"], record)
    with pytest.raises(Problem, match="not authorized"):
        inspect_run(ctx, "run_after")


def test_cancel_active_run_and_bounded_wait(instance, monkeypatch):
    import threading

    from helpers import join_run
    from test_assistant import dependencies

    app, client = instance
    configure(client)
    _, context = project(client)
    services = app.state.services
    snapshot = services.projects.snapshot(context["worktree"])
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"] = [{"id": "source", "params": {}}]
    bundle["node_sql"] = {"nodes/source.sql": "-- @output result\nSELECT 1 AS value;"}
    services.projects.write(context["worktree"], snapshot["revision"], bundle_to_files(bundle))
    entered, release = threading.Event(), threading.Event()
    compute = services.engine.runs._compute

    def blocked(*args):
        entered.set()
        assert release.wait(10)
        return compute(*args)

    monkeypatch.setattr(services.engine.runs, "_compute", blocked)
    run = services.engine.launch(context["worktree"], "dev")
    try:
        assert entered.wait(10)
        ctx = dependencies(app, client, context)
        assert wait_for_run(ctx, run["id"], 0)["status"] == "running"
        assert cancel_run(ctx, run["id"])["status"] == "canceling"
    finally:
        release.set()
    assert join_run(services.store, run["id"])["status"] == "canceled"


def test_failed_run_lookup_does_not_block_the_next_turn(instance):
    app, client = instance
    configure(client)
    _, context = project(client)

    async def stream(messages, info):
        if any(isinstance(part, ToolReturnPart) for part in messages[-1].parts):
            yield "No run was found."
        else:
            yield {0: DeltaToolCall(name="read_runs", json_args='{"run":"latest"}', tool_call_id="missing")}

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=stream)
    identity = conversation(client, context)
    first = turn(client, identity, context)[-1]["turn"]
    assert first["tools"][0]["status"] == "error"
    assert first["status"] == "complete"
    assert turn(client, identity, context, "Then propose a new run")[-1]["turn"]["status"] == "complete"
