"""Assistant boundaries: credentials, ownership, current permissions and streaming."""

import asyncio
import json
from functools import partial

import anyio
import pytest
from assistant_model import test_model as deterministic_model
from fastapi.testclient import TestClient
from helpers import LockHolder, asgi_client, assert_responsive
from pydantic_ai import models
from pydantic_ai.models.test import TestModel

from duckpad.app import create_app
from duckpad.assistant.tools import Dependencies, PageContext
from duckpad.util import Problem


@pytest.mark.parametrize("kind", ["custom", "openai", "deepseek", "ollama"])
def test_only_custom_providers_normalize_split_choices(instance, kind):
    from pydantic_ai.models.openai import OpenAIChatModel

    from duckpad.assistant.gateway import GatewayChatModel

    app, _ = instance
    config = app.state.assistant.configuration
    config.model_override = None

    async def check():
        async with config.model(
            {"id": "test", "kind": kind, "api_key": "test-key", "base_url": "https://example.invalid/v1"},
            "test",
        ) as model:
            assert type(model) is (GatewayChatModel if kind == "custom" else OpenAIChatModel)

    asyncio.run(check())


@pytest.fixture
def instance(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    app.state.assistant.configuration.model_override = deterministic_model()
    with TestClient(app) as client:
        assert (
            client.post("/api/login", json={"password": app.state.auth.initial_password}).status_code == 200
        )
        yield app, client


def configure(client, **changes):
    return client.put(
        "/api/assistant/settings",
        json={
            "enabled": True,
            "providers": [
                {"id": "primary", "kind": "deepseek", "api_key": "private-test-key", "models": ["test"]}
            ],
            "default_provider": "primary",
            "default_model": "test",
            **changes,
        },
    )


def project(client):
    worktree = client.post("/api/projects", json={"name": "Assistant example"}).json()
    context = {
        "page": "pipelines",
        "tab": "flow",
        "project": worktree["project"],
        "worktree": worktree["id"],
        "branch": "main",
        "environment": "dev",
    }
    return worktree, context


def conversation(client, context):
    response = client.post("/api/assistant/conversations", json=context)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def turn(client, identity, context, message="Explain this flow"):
    response = client.post(
        f"/api/assistant/conversations/{identity}/messages",
        json={"message": message, "provider": "primary", "model": "test", "context": context},
    )
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines()]


def test_disabled_by_default_and_write_only_keys(instance):
    app, client = instance
    assert not models.ALLOW_MODEL_REQUESTS
    assert client.get("/api/assistant/options").json()["enabled"] is False
    assert client.post("/api/assistant/conversations", json={"page": "projects"}).status_code == 403
    assert configure(client).status_code == 200
    saved = client.get("/api/assistant/settings").json()
    assert saved["providers"][0]["has_key"]
    assert "private-test-key" not in json.dumps(saved)
    assert "has_key" not in client.get("/api/assistant/options").text
    saved["providers"][0].pop("has_key")
    saved["providers"][0]["api_key"] = ""
    assert client.put("/api/assistant/settings", json=saved).status_code == 200
    assert app.state.assistant.configuration.get()["providers"][0]["api_key"] == "private-test-key"
    saved["providers"][0].update(kind="custom", base_url="https://models.example.invalid/v1")
    assert client.put("/api/assistant/settings", json=saved).status_code == 200
    assert not app.state.assistant.configuration.get()["providers"][0]["api_key"]
    saved["providers"][0]["api_key"] = "another-secret"
    assert client.put("/api/assistant/settings", json=saved).status_code == 200
    saved["providers"][0].update(base_url="https://other.example.invalid/v1", api_key="")
    assert client.put("/api/assistant/settings", json=saved).status_code == 200
    assert not app.state.assistant.configuration.get()["providers"][0]["api_key"]


def test_stream_and_resume_full_model_history(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    identity = conversation(client, context)
    events = turn(client, identity, context)
    assert events[-1]["turn"]["status"] == "complete", events
    assert any(e["type"] == "tool" and e["tool"]["status"] == "complete" for e in events)
    assert len([e for e in events if e["type"] == "text"]) >= 1
    record = app.state.services.store.get("assistant_conversation", identity)
    assert any(p["part_kind"] == "tool-return" for m in record["messages"] for p in m["parts"])
    before = len(record["messages"])
    assert turn(client, identity, context, "And its SQL?")[-1]["turn"]["status"] == "complete"
    record = app.state.services.store.get("assistant_conversation", identity)
    assert len(record["messages"]) > before
    assert len(client.get(f"/api/assistant/conversations/{identity}").json()["turns"]) == 2
    assert "messages" not in client.get(f"/api/assistant/conversations/{identity}").json()


def test_stream_keeps_paragraphs_between_tool_rounds(instance):
    from assistant_model import stream
    from pydantic_ai.models.function import FunctionModel

    app, client = instance
    configure(client)
    _, context = project(client)
    identity = conversation(client, context)

    async def with_preamble(messages, info):
        async for item in stream(messages, info):
            if isinstance(item, dict):
                yield "I will read the flow."
            yield item

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=with_preamble)
    events = turn(client, identity, context)
    expected = "I will read the flow.\n\nThe flow contains read-only project nodes."
    assert events[-1]["turn"]["text"].startswith(expected)
    assert "".join(e["text"] for e in events if e["type"] == "text").startswith(expected)


def test_scope_instructions_reach_project_and_general_turns(instance):
    from pydantic_ai.models.function import FunctionModel

    app, client = instance
    configure(client)
    _, context = project(client)
    seen = []

    async def record(messages, info):
        seen.append((info.instructions, [tool.name for tool in info.function_tools]))
        yield "I only help with Duckpad, data and development."

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=record)
    general = {"page": "projects"}
    for page in (context, general):
        events = turn(client, conversation(client, page), page, "How do I bake an apple pie?")
        assert events[-1]["turn"]["status"] == "complete", events
    (project_instructions, project_tools), (general_instructions, general_tools) = seen
    assert len(project_tools) > 1 and general_tools == ["read_guide"]
    for instructions in (project_instructions, general_instructions):
        assert instructions.startswith("You are Duckpad's project assistant.")
        assert "Scope: help only with Duckpad itself" in instructions
        assert "Decline everything else" in instructions
        assert "This scope is final" in instructions


def test_admin_only_configuration_and_private_conversations(instance):
    app, admin = instance
    configure(admin)
    _, context = project(admin)
    identity = conversation(admin, context)
    user = app.state.auth.create_user("reader", "reader-password-123")
    with TestClient(app) as reader:
        reader.post("/api/login", json={"username": "reader", "password": "reader-password-123"})
        assert reader.get("/api/assistant/settings").status_code == 403
        assert configure(reader).status_code == 403
        assert reader.post("/api/assistant/test").status_code == 403
        assert reader.get("/api/assistant/models/primary").status_code == 403
        assert reader.post("/api/assistant/models", json={}).status_code == 403
        assert reader.get("/api/assistant/conversations").json()["items"] == []
        for method in ("get", "delete", "patch"):
            args = {"json": {"title": "stolen"}} if method == "patch" else {}
            assert (
                getattr(reader, method)(f"/api/assistant/conversations/{identity}", **args).status_code == 404
            )
        assert reader.post("/api/assistant/conversations", json=context).status_code == 404
        app.state.access.member(context["project"], user["id"], "reader")
        own = conversation(reader, context)
        assert admin.get(f"/api/assistant/conversations/{own}").status_code == 404


def test_invalid_context_and_revoked_access(instance):
    _app, client = instance
    configure(client)
    _, context = project(client)
    for change in (
        {"branch": "wrong"},
        {"node": "missing"},
        {"file": "../../instance.sqlite"},
        {"environment": "missing"},
        {"project": "missing"},
    ):
        assert client.post("/api/assistant/conversations", json={**context, **change}).status_code in (
            404,
            422,
        )
    identity = conversation(client, context)
    other, elsewhere = project(client)
    response = client.post(
        f"/api/assistant/conversations/{identity}/messages",
        json={"message": "hello", "provider": "primary", "model": "test", "context": elsewhere},
    )
    assert response.status_code == 409
    assert other["id"] != context["worktree"]


def test_policy_change_does_not_resend_previous_values(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    identity = conversation(client, context)
    turn(client, identity, context)
    configure(client, allow_data=False)
    response = client.post(
        f"/api/assistant/conversations/{identity}/messages",
        json={"message": "continue", "provider": "primary", "model": "test", "context": context},
    )
    assert response.status_code == 409
    assert "previous values private" in response.text
    app.state.assistant.configuration.model_override = TestModel(
        call_tools=[], custom_output_text="No data tools"
    )
    new = conversation(client, context)
    assert turn(client, new, context)[-1]["turn"]["status"] == "complete"
    tools = app.state.assistant.configuration.model_override.last_model_request_parameters.function_tools
    assert {t.name for t in tools}.isdisjoint({"preview_output", "explain_value"})


def test_delete_cascades_from_project_and_user(instance):
    app, client = instance
    configure(client)
    worktree, context = project(client)
    identity = conversation(client, context)
    assert client.delete(f"/api/projects/{worktree['project']}").status_code == 200
    assert app.state.services.store.get("assistant_conversation", identity) is None
    user = app.state.auth.create_user("temporary", "temporary-password-123")
    own = app.state.assistant.create(user, PageContext(page="projects"))
    app.state.services.store.delete("user", user["id"])
    assert app.state.services.store.get("assistant_conversation", own["id"]) is None


def dependencies(app, client, context):
    from types import SimpleNamespace

    from duckpad.assistant.tools import validate_context

    token = client.cookies.get("duckpad_session")
    assistant = app.state.assistant
    config = assistant.configuration.get()
    value = validate_context(app.state.services, app.state.auth.check(token), PageContext(**context))
    return SimpleNamespace(
        deps=Dependencies(
            app.state.services, app.state.auth, token, assistant.configuration, config["revision"], value
        )
    )


def test_tools_paginate_sql_documentation_and_never_write(instance):
    from duckpad.assistant.tools import read_documentation, read_flow, read_history, read_sql, search_project

    app, client = instance
    configure(client)
    worktree, context = project(client)
    projects = app.state.services.projects
    snapshot = projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"] = [{"id": f"node_{i}", "template": "custom", "params": {}} for i in range(65)]
    bundle["templates"]["custom"] = "-- @output result\nSELECT 42 AS answer;"
    bundle["documentation"]["project"] = "Project overview"
    bundle["variables"] = {"region": {"type": "text", "default": "North"}}
    from duckpad.bundle import bundle_to_files

    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    before = projects.snapshot(worktree["id"])["commit"]
    ctx = dependencies(app, client, context)
    first = read_flow(ctx, "nodes", limit=10)
    assert len(first["items"]) == 10 and first["next_offset"] == 10 and first["total"] == 65
    assert "SELECT 42" in read_sql(ctx, node="node_0")["text"]
    assert "SELECT 42" in read_sql(ctx, template="custom")["text"]
    assert read_documentation(ctx, "project")["text"] == "Project overview"
    assert read_documentation(ctx, "variables")["items"][0]["name"] == "region"
    assert search_project(ctx, "answer")["items"][0]["file"] == "templates/custom.sql"
    assert read_history(ctx)["items"]
    assert projects.snapshot(worktree["id"])["commit"] == before


def test_preview_limit_lineage_and_connection_revocation(instance):
    from helpers import join_run

    from duckpad.assistant.tools import explain_value, preview_output, read_schemas
    from duckpad.bundle import bundle_to_files

    app, client = instance
    configure(client, max_rows=1)
    worktree, context = project(client)
    projects = app.state.services.projects
    snapshot = projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"] = [{"id": "source", "params": {}}]
    bundle["node_sql"] = {
        "nodes/source.sql": '-- @param connection: connection = "files"\n-- @output result\nSELECT range AS value FROM range(100);'
    }
    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    files = {"id": "files", "name": "Files", "connector": "folder", "environments": {"dev": {"root": ""}}}
    assert client.put("/api/catalog/connection?create=true", json=files).status_code == 200
    app.state.access.grant_connections(worktree["project"], ["files"])
    run = app.state.services.engine.launch(worktree["id"], "dev")
    assert join_run(app.state.services.store, run["id"])["status"] == "success"
    ctx = dependencies(app, client, context)
    preview = preview_output(ctx, "source", limit=5000)
    assert len(preview["rows"]) == 1
    filtered = preview_output(ctx, "source", limit=5000, filter="value >= 98")
    assert [row["values"] for row in filtered["rows"]] == [[98]]
    assert filtered["filtered_count"] == 2
    with pytest.raises(Problem, match="Unknown column"):
        preview_output(ctx, "source", filter="missing = 1")
    with pytest.raises(Problem, match="exact generation ID"):
        explain_value(ctx, "source", 0, "value")
    with pytest.raises(Problem, match=r"groups\[\].key"):
        explain_value(ctx, preview["id"], 0, "value", group="South")
    explanation = explain_value(ctx, preview["id"], preview["rows"][0]["id"], "value")
    assert explanation["value"] == 0 and len(explanation["contributions"]) == 1
    schema = read_schemas(ctx, "source")
    assert schema["items"][0]["columns"] == [{"name": "value", "type": "BIGINT"}]
    app.state.access.grant_connections(worktree["project"], [])
    with pytest.raises(Problem, match="Connection is not authorized"):
        preview_output(ctx, "source")
    with pytest.raises(Problem, match="Connection is not authorized"):
        read_schemas(ctx, "source")


def test_each_tool_rechecks_membership_and_session(instance):
    from duckpad.assistant.tools import read_flow

    app, client = instance
    configure(client)
    worktree, context = project(client)
    user = app.state.auth.create_user("reader", "reader-password-123")
    app.state.access.member(worktree["project"], user["id"], "reader")
    with TestClient(app) as reader:
        reader.post("/api/login", json={"username": "reader", "password": "reader-password-123"})
        ctx = dependencies(app, reader, context)
        assert read_flow(ctx, "nodes")["total"] == 0
        app.state.access.member(worktree["project"], user["id"], None)
        with pytest.raises(Problem, match="Project not found"):
            read_flow(ctx, "nodes")
        app.state.access.member(worktree["project"], user["id"], "reader")
        reader.post("/api/logout")
        with pytest.raises(Problem, match="Authentication required"):
            read_flow(ctx, "nodes")


def test_stop_closes_provider_stream_and_allows_another_turn(instance):
    import asyncio
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from pydantic_ai.models.function import FunctionModel

    app, client = instance
    configure(client)
    _, context = project(client)
    identity = conversation(client, context)
    entered, closed = threading.Event(), threading.Event()

    async def slow(messages, info):
        try:
            entered.set()
            yield "Starting"
            await asyncio.sleep(60)
            yield "Should not finish"
        finally:
            closed.set()

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=slow)
    with ThreadPoolExecutor() as pool:
        response = pool.submit(turn, client, identity, context)
        assert entered.wait(5)
        assert client.post(f"/api/assistant/conversations/{identity}/stop").status_code == 200
        events = response.result(timeout=5)
    assert closed.is_set()
    assert events[-1]["turn"]["status"] == "stopped"
    assert not app.state.assistant.active
    app.state.assistant.configuration.model_override = deterministic_model()
    assert turn(client, identity, context)[-1]["turn"]["status"] == "complete"


def test_stream_waits_for_the_store_outside_the_event_loop(instance):
    from pydantic_ai.models.function import FunctionModel

    app, client = instance
    configure(client)
    _, context = project(client)
    identity = conversation(client, context)
    holder = LockHolder(app.state.services.store.lock)
    holding = asyncio.Event()

    async def locked(messages, info):
        # Taken after `prepare`, so the response itself meets the held lock.
        holder.acquire()
        holding.set()
        yield "Saved "
        yield "after the lock."

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=locked)
    request = {"message": "Explain this flow", "provider": "primary", "model": "test", "context": context}

    async def scenario():
        headers = {"authorization": "Bearer " + client.cookies["duckpad_session"]}
        async with asgi_client(app, headers=headers) as http:
            response = asyncio.create_task(
                http.post(f"/api/assistant/conversations/{identity}/messages", json=request)
            )
            await holding.wait()
            try:
                await assert_responsive(holder.holding)
                assert not response.done()
            finally:
                holder.release()
            return await response

    events = [json.loads(line) for line in asyncio.run(scenario()).text.splitlines()]
    assert events[-1]["turn"]["status"] == "complete"
    assert events[-1]["turn"]["text"] == "Saved after the lock."


def test_cancelled_stream_still_saves_its_turn_behind_a_held_lock(instance):
    from pydantic_ai.models.function import FunctionModel

    app, client = instance
    configure(client)
    _, context = project(client)
    identity = conversation(client, context)
    holder = LockHolder(app.state.services.store.lock, timeout=0.5)
    streaming = asyncio.Event()

    async def endless(messages, info):
        yield "Partial "
        streaming.set()
        await asyncio.sleep(30)
        yield "never sent"

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=endless)
    request = {"message": "Explain this flow", "provider": "primary", "model": "test", "context": context}

    async def scenario():
        headers = {"authorization": "Bearer " + client.cookies["duckpad_session"]}
        async with asgi_client(app, headers=headers) as http, anyio.create_task_group() as group:
            send = partial(http.post, f"/api/assistant/conversations/{identity}/messages", json=request)
            group.start_soon(send)
            await streaming.wait()
            holder.acquire()
            # As a task group does on a client disconnect: every later checkpoint is cancelled too.
            group.cancel_scope.cancel()

    asyncio.run(scenario())
    assert holder.released is not None
    record = app.state.services.store.get("assistant_conversation", identity)
    assert record["turns"][-1]["status"] == "stopped"
    assert identity not in app.state.assistant.active


def test_streamed_text_rechecks_access_once_per_interval(instance, monkeypatch):
    from pydantic_ai.models.function import FunctionModel

    import duckpad.assistant.service as service

    app, client = instance
    configure(client)
    _, context = project(client)
    identity = conversation(client, context)
    checks = 0
    check = Dependencies.check

    def counted(self, **options):
        nonlocal checks
        checks += 1
        return check(self, **options)

    async def chatty(messages, info):
        nonlocal checks
        checks = 0
        for _ in range(50):
            yield "word "

    monkeypatch.setattr(Dependencies, "check", counted)
    monkeypatch.setattr(service, "RECHECK_INTERVAL", 60)
    app.state.assistant.configuration.model_override = FunctionModel(stream_function=chatty)
    assert turn(client, identity, context)[-1]["turn"]["status"] == "complete"
    assert checks == 0

    async def revoked(messages, info):
        yield "visible "
        app.state.auth.logout(client.cookies["duckpad_session"])
        yield "hidden"

    monkeypatch.setattr(service, "RECHECK_INTERVAL", 0)
    app.state.assistant.configuration.model_override = FunctionModel(stream_function=revoked)
    result = turn(client, identity, context)[-1]["turn"]
    assert result["status"] == "error" and result["error"] == "Authentication required"
    assert "hidden" not in result["text"]


def test_provider_errors_never_echo_secrets(instance, caplog):
    from pydantic_ai.exceptions import ModelHTTPError
    from pydantic_ai.models.function import FunctionModel

    app, client = instance
    configure(client)
    _, context = project(client)
    identity = conversation(client, context)

    async def refused(messages, info):
        raise ModelHTTPError(401, "test", "private-test-key")
        yield "unreachable"

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=refused)
    events = turn(client, identity, context)
    assert events[-1]["turn"]["status"] == "error"
    assert "refused the API key" in events[-1]["turn"]["error"]
    assert "private-test-key" not in json.dumps(events) + caplog.text
    assert "private-test-key" not in client.get(f"/api/assistant/conversations/{identity}").text
    archive = client.get(f"/api/worktrees/{context['worktree']}/archive.zip")
    assert b"private-test-key" not in archive.content


def test_timeout_and_usage_limits(instance, monkeypatch):
    import asyncio

    from pydantic_ai.models.function import DeltaToolCall, FunctionModel

    import duckpad.assistant.service as service

    app, client = instance
    configure(client)
    _, context = project(client)
    identity = conversation(client, context)

    async def slow(messages, info):
        await asyncio.sleep(60)
        yield "late"

    monkeypatch.setattr(service, "TURN_TIMEOUT", 0.05)
    app.state.assistant.configuration.model_override = FunctionModel(stream_function=slow)
    result = turn(client, identity, context)[-1]["turn"]
    assert result["status"] == "error" and "timed out" in result["error"]
    monkeypatch.setattr(service, "TURN_TIMEOUT", 120)

    async def loop(messages, info):
        yield {0: DeltaToolCall(name="read_flow", json_args='{"section":"nodes"}')}

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=loop)
    result = turn(client, identity, context)[-1]["turn"]
    assert result["status"] == "error" and "limit for this turn" in result["error"]


@pytest.mark.parametrize("kind", ["openai", "anthropic", "google", "mistral", "deepseek", "ollama", "custom"])
def test_provider_adapters_use_explicit_instance_credentials(instance, kind):
    import asyncio

    app, client = instance
    provider = {
        "id": "primary",
        "kind": kind,
        "api_key": "explicit-key",
        "models": ["test"],
        "base_url": "https://models.example.invalid/v1" if kind == "custom" else "",
    }
    assert configure(client, providers=[provider]).status_code == 200
    configuration = app.state.assistant.configuration
    configuration.model_override = None

    async def inspect_model():
        async with configuration.model(configuration.get()["providers"][0], "test") as model:
            assert model.model_name == "test"

    asyncio.run(inspect_model())


def test_discovery_and_connection_test_are_sanitized(instance, monkeypatch):
    import httpx2
    from pydantic_ai.exceptions import ModelHTTPError
    from pydantic_ai.models.function import FunctionModel

    app, client = instance
    configure(client)
    original = httpx2.AsyncClient
    seen = []

    def handle(request):
        seen.append(request)
        return httpx2.Response(200, json={"data": [{"id": "test"}, {"id": "other"}]})

    monkeypatch.setattr(
        httpx2, "AsyncClient", lambda **kwargs: original(transport=httpx2.MockTransport(handle), **kwargs)
    )
    assert client.get("/api/assistant/models/primary").json()["models"] == ["other", "test"]
    assert seen[0].headers["Authorization"] == "Bearer private-test-key"
    assert seen[0].url.path == "/models"

    def refused(messages, info):
        raise ModelHTTPError(401, "test", "private-test-key")

    async def refused_stream(messages, info):
        yield refused(messages, info)

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=refused_stream)
    response = client.post("/api/assistant/test")
    assert response.status_code == 502
    assert "refused the API key" in response.text and "private-test-key" not in response.text


def test_unsaved_provider_discovery_and_test_reuse_only_matching_keys(instance, monkeypatch):
    import httpx2

    app, client = instance
    configure(client)
    original = httpx2.AsyncClient
    seen = []
    catalogs = {
        "api.deepseek.com": {"data": [{"id": "deepseek-chat"}]},
        "generativelanguage.googleapis.com": {
            "models": [
                {"name": "models/gemini-chat", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/text-embedding", "supportedGenerationMethods": ["embedContent"]},
            ]
        },
        "api.mistral.ai": {
            "data": [
                {"id": "mistral-chat", "capabilities": {"completion_chat": True}},
                {"id": "mistral-embed", "capabilities": {"completion_chat": False}},
            ]
        },
        "api.anthropic.com": {"data": [{"id": "claude-test"}]},
    }

    def handle(request):
        seen.append(request)
        if request.url.host in catalogs:
            return httpx2.Response(200, json=catalogs[request.url.host])
        return httpx2.Response(404)

    monkeypatch.setattr(
        httpx2, "AsyncClient", lambda **kwargs: original(transport=httpx2.MockTransport(handle), **kwargs)
    )

    def discover(**provider):
        return client.post("/api/assistant/models", json={"models": [], **provider})

    # The saved key serves the unchanged provider, even before saving other edits.
    response = discover(id="primary", kind="deepseek")
    assert response.json() == {"models": ["deepseek-chat"], "listed": True}
    assert seen[-1].headers["Authorization"] == "Bearer private-test-key"
    # Another provider identity or type never receives it.
    assert discover(id="other", kind="deepseek").json()["error"] == "Provide an API key for this provider"
    assert discover(id="primary", kind="mistral").status_code == 400
    count = len(seen)
    response = discover(id="primary", kind="custom", base_url="https://models.example.invalid/v1")
    assert response.json() == {"models": [], "listed": False}
    assert len(seen) == count + 1 and "Authorization" not in seen[-1].headers
    # A typed key is used as is and model lists keep only chat models.
    assert discover(id="new", kind="google", api_key="typed-key").json()["models"] == ["gemini-chat"]
    assert seen[-1].headers["x-goog-api-key"] == "typed-key"
    assert seen[-1].url.params["pageSize"] == "1000"
    assert discover(id="new", kind="mistral", api_key="typed-key").json()["models"] == ["mistral-chat"]
    assert discover(id="new", kind="anthropic", api_key="typed-key").json()["models"] == ["claude-test"]
    assert seen[-1].url.params["limit"] == "1000"
    assert app.state.assistant.configuration.get()["providers"][0]["kind"] == "deepseek"

    check = {"provider": {"id": "draft", "kind": "openai", "models": []}, "model": "gpt-test"}
    assert (
        client.post("/api/assistant/test", json=check).json()["error"]
        == "Provide an API key for this provider"
    )
    check["provider"]["api_key"] = "typed-key"
    assert client.post("/api/assistant/test", json=check).json() == {"ok": True}
    check["model"] = " "
    assert client.post("/api/assistant/test", json=check).status_code == 400
    assert client.post("/api/assistant/test", json={}).json() == {"ok": True}
    app.state.auth.create_user("reader", "reader-password-123")
    with TestClient(app) as reader:
        reader.post("/api/login", json={"username": "reader", "password": "reader-password-123"})
        assert (
            reader.post("/api/assistant/models", json={"id": "primary", "kind": "deepseek"}).status_code
            == 403
        )


def test_unlisted_models_and_concurrent_turns_are_rejected(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    identity = conversation(client, context)
    request = {"message": "hello", "provider": "primary", "model": "unlisted", "context": context}
    assert client.post(f"/api/assistant/conversations/{identity}/messages", json=request).status_code == 400
    from pydantic_ai import CancellationToken

    app.state.assistant.active[identity] = CancellationToken()
    request["model"] = "test"
    assert client.post(f"/api/assistant/conversations/{identity}/messages", json=request).status_code == 409
    app.state.assistant.active.clear()
