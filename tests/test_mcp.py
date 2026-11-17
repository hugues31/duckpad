"""External-agent workflow, denied access, approval binding and real stdio and HTTP interoperability."""

import asyncio
import contextlib
import json
import re
import socket
import subprocess
import sys
import threading
import time
import uuid

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

from duckpad.app import create_app


@pytest.fixture
def instance(tmp_path):
    app = create_app(tmp_path / "instance", watch=False, trusted_local=True)
    with TestClient(app) as browser:
        assert (
            browser.post(
                "/api/login", json={"username": "admin", "password": app.state.auth.initial_password}
            ).status_code
            == 200
        )
        tree = browser.post("/api/projects", json={"name": "Agent test"}).json()
        actor = app.state.auth.create_user("agent", "agent-test-password")
        app.state.access.member(tree["project"], actor["id"], "editor")
        token = app.state.auth.create_api_token(actor, actor["id"], "Agent")
        yield app, browser, tree, actor, token


def call(instance, name, /, **args):
    _, browser, tree, _, token = instance
    response = browser.post(
        "/api/agent/tools/" + name,
        headers={"Authorization": "Bearer " + token["token"]},
        json={"worktree": tree["id"], **args},
    )
    assert response.status_code == 200, response.text
    return response.json()


def result(instance, name, /, **args):
    response = call(instance, name, **args)
    assert response["ok"], response
    return response["result"]


def seed(instance, sql="-- @output result\nSELECT 42 AS value;"):
    revision = result(instance, "validate_project")["revision"]
    return result(
        instance, "edit_flow", revision=revision, nodes=[{"operation": "add", "id": "answer", "sql": sql}]
    )


def approve(browser, receipt, decision="approve"):
    page = browser.get(receipt["review_path"])
    assert page.status_code == 200, page.text
    csrf = re.search(r'name="csrf" value="([^"]+)"', page.text)[1]
    response = browser.post(
        receipt["review_path"].replace("/review", "/decision"), data={"csrf": csrf, "decision": decision}
    )
    assert response.status_code == 200, response.text


def test_edit_validation_revision_and_git_history(instance):
    app, _, tree, _, _ = instance
    original = result(instance, "validate_project")
    branch = result(instance, "create_branch", name="agent/change")
    assert set(branch) == {"id", "project", "branch"}
    saved = seed(instance)
    assert saved["commit"] != original["commit"]
    assert result(instance, "validate_project")["valid"]
    assert result(instance, "read_flow", section="nodes")["items"][0]["id"] == "answer"
    stale = call(
        instance,
        "write_sql",
        node="answer",
        sql="-- @output result\nSELECT 0 AS value;",
        revision=original["revision"],
    )
    assert stale["error"]["status"] == 409
    invalid = call(
        instance,
        "edit_flow",
        revision=saved["revision"],
        edges=[{"operation": "connect", "id": "bad", "source": "missing", "target": "answer"}],
    )
    assert invalid["error"]["status"] == 422
    assert invalid["error"]["details"]
    assert result(instance, "validate_project")["commit"] == saved["commit"]
    unknown = call(instance, "edit_flow", revision=saved["revision"], unexpected=True)
    assert unknown["error"]["status"] == 422
    history = result(instance, "read_history")
    assert saved["commit"] in json.dumps(history)
    snapshot = app.state.services.projects.snapshot(tree["id"])
    assert snapshot["bundle"]["flow"]["edges"] == []


def test_permissions_tokens_and_hidden_projects(instance):
    app, browser, tree, actor, token = instance
    seed(instance)
    other = browser.post("/api/projects", json={"name": "Private"}).json()
    listed = result(instance, "list_projects")
    assert [p["id"] for p in listed["items"]] == [tree["project"]]
    assert call(instance, "read_flow", worktree=other["id"], section="nodes")["error"]["status"] == 404
    revision = result(instance, "validate_project")["revision"]
    app.state.access.member(tree["project"], actor["id"], "reader")
    for name, args in [
        ("create_branch", {"name": "forbidden"}),
        ("edit_flow", {"revision": revision, "nodes": []}),
        ("request_run", {}),
        ("launch_approved_run", {"approval": "unknown"}),
        ("cancel_run", {"run": "unknown"}),
    ]:
        assert call(instance, name, **args)["error"]["status"] == 403
    assert result(instance, "validate_project")["valid"]
    app.state.services.store.delete("api_token", token["id"])
    assert (
        browser.get("/api/agent/tools", headers={"Authorization": "Bearer " + token["token"]}).status_code
        == 401
    )
    assert browser.get("/api/agent/tools").status_code == 401


def test_approval_is_human_only_bound_and_consumed(instance):
    app, browser, _, _, token = instance
    seed(instance)
    pending = result(instance, "request_run", environment="prod")
    assert pending["plan"]["confirm_before_run"]
    assert call(instance, "launch_approved_run", approval=pending["id"])["error"]["status"] == 403
    assert (
        browser.get(pending["review_path"], headers={"Authorization": "Bearer " + token["token"]}).status_code
        == 403
    )
    assert (
        browser.post(
            pending["review_path"].replace("/review", "/decision"), data={"decision": "approve"}
        ).status_code
        == 403
    )
    approve(browser, pending)
    current = result(instance, "validate_project")
    result(
        instance,
        "write_sql",
        node="answer",
        sql="-- @output result\nSELECT 43 AS value;",
        revision=current["revision"],
    )
    refused = call(instance, "launch_approved_run", approval=pending["id"])
    assert refused["error"]["status"] == 409
    assert result(instance, "read_approval", approval=pending["id"])["consumed"]
    declined = result(instance, "request_run")
    approve(browser, declined, "decline")
    assert call(instance, "launch_approved_run", approval=declined["id"])["error"]["status"] == 403
    app.state.agent_api.pending[declined["id"]]["expires"] = 0
    assert call(instance, "read_approval", approval=declined["id"])["error"]["status"] == 404


def test_busy_cancellation_and_replay(instance, monkeypatch):
    app, browser, _, _, _ = instance
    seed(instance)
    entered, release = threading.Event(), threading.Event()
    execute = app.state.services.engine.runs._execute

    def pause(*args):
        entered.set()
        assert release.wait(10)
        execute(*args)

    monkeypatch.setattr(app.state.services.engine.runs, "_execute", pause)
    first, second = result(instance, "request_run"), result(instance, "request_run")
    approve(browser, first)
    approve(browser, second)
    try:
        run = result(instance, "launch_approved_run", approval=first["id"])
        assert entered.wait(5)
        assert result(instance, "launch_approved_run", approval=first["id"])["id"] == run["id"]
        assert call(instance, "launch_approved_run", approval=second["id"])["error"]["status"] == 409
        assert result(instance, "cancel_run", run=run["id"])["status"] in ("canceling", "canceled")
    finally:
        release.set()
    assert result(instance, "wait_for_run", run=run["id"], seconds=10)["status"] == "canceled"


def test_secrets_redacted_in_definitions_results_and_errors(instance):
    app, browser, _, _, _ = instance
    store = app.state.services.store
    secret = "private-connection-password"
    # A retained secret stays private even when its connector no longer declares that parameter.
    store.put(
        "connection",
        "private",
        {
            "id": "private",
            "name": "Secret",
            "connector": "local",
            "secret_fields": ["password"],
            "environments": {"dev": {"password": secret}},
        },
    )
    seed(instance, f"-- @output result\nSELECT '{secret}' AS value;")
    assert secret not in json.dumps(result(instance, "read_sql", node="answer"))
    assert "[redacted]" in json.dumps(result(instance, "read_sql", node="answer"))
    tail = result(instance, "read_file", path="nodes/answer.sql", offset=33)
    assert "connection-password" not in tail["text"]
    error = call(instance, "write_sql", node=secret, sql="SELECT 1;", revision="bad")
    assert secret not in json.dumps(error)
    pending = result(instance, "request_run")
    approve(browser, pending)
    run = result(instance, "launch_approved_run", approval=pending["id"])
    assert result(instance, "wait_for_run", run=run["id"], seconds=10)["status"] == "success"
    assert secret not in json.dumps(result(instance, "preview_output", node="answer"))


def test_approval_token_binding_and_environment_change(instance):
    app, browser, _, actor, _ = instance
    seed(instance)
    pending = result(instance, "request_run")
    second = app.state.auth.create_api_token(actor, actor["id"], "Another client")
    other = (*instance[:4], second)
    assert call(other, "read_approval", approval=pending["id"])["error"]["status"] == 404
    approve(browser, pending)
    store = app.state.services.store
    environment = store.get("environment", pending["plan"]["environment"])
    environment["confirm_before_run"] = not environment["confirm_before_run"]
    store.put("environment", environment["id"], environment)
    assert call(instance, "launch_approved_run", approval=pending["id"])["error"]["status"] == 409


def test_numeric_secret_redaction_preserves_json():
    from duckpad.agent_tools import redact

    assert redact({"rows": [42, "value 42"]}, ["42"]) == {"rows": ["[redacted]", "value [redacted]"]}


@contextlib.contextmanager
def served(app):
    """The application on a real local port, as MCP hosts reach it."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        http_server = uvicorn.Server(uvicorn.Config(app, log_level="critical", lifespan="off"))
        thread = threading.Thread(target=http_server.run, kwargs={"sockets": [listener]})
        thread.start()
        try:
            deadline = time.monotonic() + 10
            while not http_server.started and time.monotonic() < deadline:
                time.sleep(0.01)
            assert http_server.started
            yield f"http://127.0.0.1:{listener.getsockname()[1]}"
        finally:
            http_server.should_exit = True
            thread.join(15)
            assert not thread.is_alive()


async def agent_workflow(session, instance):
    """Discover, branch, edit, validate, run after a human decision, then read results and lineage."""
    app, browser, tree, actor, _ = instance
    await session.initialize()
    listing = await session.list_tools()
    assert {"edit_flow", "request_run", "explain_value"} <= {t.name for t in listing.tools}
    worktree = tree["id"]

    async def tool(name, /, **arguments):
        value = await session.call_tool(name, {"worktree": worktree, **arguments})
        assert not value.isError, value
        return value.structuredContent["result"]

    assert (await tool("list_projects"))["items"][0]["id"] == tree["project"]
    worktree = (await tool("create_branch", name="agent/" + uuid.uuid4().hex[:8]))["id"]
    revision = (await tool("validate_project"))["revision"]
    await tool(
        "edit_flow",
        revision=revision,
        nodes=[
            {"operation": "add", "id": "source", "sql": "-- @output result\nSELECT 21 AS value;"},
            {
                "operation": "add",
                "id": "answer",
                "sql": "-- @input input\n-- @param factor: number = 1\n-- @output result\n"
                "SELECT value * {{ factor }} AS value FROM {{ input }};",
                "params": {"factor": 2},
            },
        ],
        edges=[{"operation": "connect", "id": "input", "source": "source", "target": "answer"}],
    )
    assert (await tool("validate_project"))["valid"]
    pending = await tool("request_run")
    approve(browser, pending)
    run = await tool("launch_approved_run", approval=pending["id"])
    assert (await tool("wait_for_run", run=run["id"], seconds=10))["status"] == "success"
    assert (await tool("read_schemas"))["items"]
    output = await tool("preview_output", node="answer")
    assert "42" in json.dumps(output)
    lineage = await tool("explain_value", dataset=output["id"], row=output["rows"][0]["id"], column="value")
    assert lineage["contributions"]
    app.state.access.member(tree["project"], actor["id"], "reader")
    try:
        refused = await session.call_tool("request_run", {"worktree": worktree})
        assert refused.isError
        assert refused.structuredContent["error"]["status"] == 403
    finally:
        app.state.access.member(tree["project"], actor["id"], "editor")
    return pending, worktree


def test_streamable_http_workflow_and_denied_access(instance):
    app, browser, _, _, token = instance
    with served(app) as address:
        endpoint = address + "/api/agent/mcp"

        async def workflow():
            headers = {"Authorization": "Bearer " + token["token"]}
            async with (
                httpx.AsyncClient(headers=headers, timeout=30) as client,
                streamable_http_client(endpoint, http_client=client) as (read, write, _),
                ClientSession(read, write) as session,
            ):
                return await agent_workflow(session, instance)

        pending, _ = asyncio.run(workflow())
        assert "review_url" not in pending
        listing = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        accept = {"Accept": "application/json, text/event-stream"}
        # Only API tokens reach the tools: no browser session, no cross-site request.
        assert httpx.post(endpoint, json=listing, headers=accept).status_code == 401
        signed_in = {**accept, "Cookie": "duckpad_session=" + browser.cookies["duckpad_session"]}
        refused = httpx.post(endpoint, json=listing, headers=signed_in)
        assert refused.status_code == 401
        assert "API token" in refused.json()["error"]
        bearer = {**accept, "Authorization": "Bearer " + token["token"]}
        assert httpx.post(endpoint, json=listing, headers=bearer).status_code == 200
        cross_site = httpx.post(endpoint, json=listing, headers={**bearer, "Origin": "https://example.com"})
        assert cross_site.status_code == 403
        # Stateless: no session stream to open or delete.
        assert httpx.get(endpoint, headers=bearer).status_code == 405
        assert httpx.delete(endpoint, headers=bearer).status_code == 405
        large = httpx.post(endpoint, content=b" " * (300 * 1024), headers=bearer)
        assert (large.status_code, large.json()["error"]) == (413, "Requests are limited to 256 KiB")
        app.state.services.store.delete("api_token", token["id"])
        assert httpx.post(endpoint, json=listing, headers=bearer).status_code == 401


def test_real_stdio_workflow_and_cli(instance, tmp_path):
    app, _, _, _, token = instance
    # The API and the stdio adapter are separate processes, as in a real MCP host.
    with served(app) as address:
        token_file = tmp_path / "token"
        token_file.write_text(token["token"])

        async def workflow():
            params = StdioServerParameters(
                command=sys.executable,
                args=["-m", "duckpad.cli", "mcp", "--server", address, "--token-file", str(token_file)],
            )
            async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
                return await agent_workflow(session, instance)

        pending, worktree = asyncio.run(workflow())
        assert pending["review_url"] == address + pending["review_path"]
        command = [sys.executable, "-m", "duckpad.cli", "validate", worktree, "--server", address]
        check = subprocess.run(
            [*command, "--token-file", str(token_file)], capture_output=True, text=True, timeout=30
        )
        assert check.returncode == 0, check.stderr
        assert json.loads(check.stdout)["result"]["valid"]
