"""The assistant across the instance: projects, branches and connections its user can open."""

import inspect
import json
import re
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import files_connection, join_run
from pydantic_ai.messages import ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from test_assistant import configure, conversation, dependencies, turn
from test_assistant import instance as instance

from duckpad.assistant.registry import TOOLS
from duckpad.assistant.runs import cancel_run, compare_run, inspect_run, read_run_sql, wait_for_run
from duckpad.assistant.tools import (
    LOST_ACCESS,
    preview_output,
    read_flow,
    read_runs,
    read_schemas,
    read_sql,
)
from duckpad.assistant.workspace import list_projects, read_connections
from duckpad.bundle import bundle_to_files
from duckpad.catalog import MASK
from duckpad.util import Problem

SETTINGS = {"page": "instanceSettings", "section": "connections"}


def scripted(*calls, offered=None):
    """A model that makes the given tool calls, one per request, then answers.

    `offered` receives the names of the tools of each request.
    """

    async def stream(messages, info):
        if offered is not None:
            offered.append({tool.name for tool in info.function_tools})
        answered = 0
        for message in reversed(messages):
            if any(isinstance(part, UserPromptPart) for part in message.parts):
                break
            answered += sum(isinstance(part, ToolReturnPart) for part in message.parts)
        if answered < len(calls):
            name, arguments = calls[answered]
            yield {
                0: DeltaToolCall(name=name, json_args=json.dumps(arguments), tool_call_id=f"call-{answered}")
            }
        else:
            yield "Done."

    return FunctionModel(stream_function=stream)


def project(app, client, name, connections=()):
    """A project with one node reading each given connection, and its branch page context."""
    worktree = client.post("/api/projects", json={"name": name}).json()
    projects = app.state.services.projects
    snapshot = projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"] = [{"id": "source", "params": {}}]
    declarations = "".join(f'-- @param {c}: connection = "{c}"\n' for c in connections)
    bundle["node_sql"] = {
        "nodes/source.sql": f"{declarations}-- @output result\nSELECT '{name}' AS origin FROM range(3);"
    }
    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    app.state.access.grant_connections(worktree["project"], list(connections))
    context = {
        "page": "pipelines",
        "tab": "flow",
        "project": worktree["project"],
        "worktree": worktree["id"],
        "branch": "main",
        "environment": "dev",
    }
    return worktree, context


@contextmanager
def member(app, username, *projects, role="reader"):
    user = app.state.auth.create_user(username, f"{username}-password-123")
    for identity in projects:
        app.state.access.member(identity, user["id"], role)
    with TestClient(app) as client:
        client.post("/api/login", json={"username": username, "password": f"{username}-password-123"})
        yield user, client


def message(client, identity, context, text="continue"):
    return client.post(
        f"/api/assistant/conversations/{identity}/messages",
        json={"message": text, "provider": "primary", "model": "test", "context": context},
    )


def test_a_settings_page_reads_a_named_project_and_the_connections(instance):
    app, client = instance
    configure(client)
    files_connection(app.state.services.catalog)
    sales, _ = project(app, client, "Sales", ["files"])
    project(app, client, "Finance")
    app.state.assistant.configuration.model_override = scripted(
        ("list_projects", {}),
        ("read_flow", {"section": "nodes", "worktree": sales["id"]}),
        ("read_sql", {"node": "source", "worktree": sales["id"]}),
        ("read_connections", {}),
        ("read_connections", {"connection": "files", "details": True}),
    )
    identity = conversation(client, SETTINGS)
    result = turn(client, identity, SETTINGS, "Which nodes of Sales use the Files connection?")[-1]["turn"]
    assert result["status"] == "complete", result
    listed, flow, sql, connections, details = result["tools"]
    assert [card["status"] for card in result["tools"]] == ["complete"] * 5
    assert {"Sales", "Finance"} <= {p["name"] for p in json.loads(listed["summary"])["items"]}
    assert "SELECT 'Sales' AS origin" in sql["summary"]
    # Each card keeps what it read outside the conversation's branch; names alone are no such read.
    scope = {"project": sales["project"], "worktree": sales["id"], "project_name": "Sales", "branch": "main"}
    assert flow["reads"] == sql["reads"] == [scope]
    assert details["reads"] == [{"instance": True}]
    assert "reads" not in listed and "reads" not in connections
    assert json.loads(connections["summary"])["items"] == [
        {
            "id": "files",
            "name": "Files",
            "family": "storage",
            "capabilities": ["read", "write"],
            "projects": [{"id": sales["project"], "name": "Sales"}],
        }
    ]
    assert '"root"' in details["summary"]
    # The conversation continues: nothing it read has changed hands.
    assert turn(client, identity, SETTINGS)[-1]["turn"]["status"] == "complete"


def test_connections_are_read_at_the_level_of_the_user(instance):
    app, admin = instance
    configure(admin)
    secret = {
        "id": "warehouse",
        "name": "Warehouse",
        "connector": "postgres",
        "environments": {"dev": {"host": "db.example.invalid", "password": "s3cret-value"}},
    }
    assert admin.put("/api/catalog/connection?create=true", json=secret).status_code == 200
    files_connection(app.state.services.catalog)
    sales, context = project(app, admin, "Sales", ["files"])
    finance, _ = project(app, admin, "Finance", ["warehouse"])
    unused = {"id": "spare", "name": "Spare", "connector": "folder", "environments": {"dev": {"root": ""}}}
    assert admin.put("/api/catalog/connection?create=true", json=unused).status_code == 200
    ctx = dependencies(app, admin, context)
    # An administrator sees every connection, and its settings only on request.
    listed = read_connections(ctx)
    assert {c["id"]: [p["name"] for p in c["projects"]] for c in listed["items"]} == {
        "warehouse": ["Finance"],
        "files": ["Sales"],
        "spare": [],
    }
    assert "db.example.invalid" not in json.dumps(listed) and ctx.deps.reads == {}
    assert [c["id"] for c in read_connections(ctx, project=sales["project"])["items"]] == ["files"]
    warehouse = read_connections(ctx, connection="warehouse", details=True)["items"][0]
    assert warehouse["connector"] == "postgres" and warehouse["family"] == "database"
    assert warehouse["environments"]["dev"] == {"host": "db.example.invalid", "password": MASK}
    assert "s3cret-value" not in json.dumps(read_connections(ctx, details=True))
    assert ctx.deps.reads == {"call": {"instance": {"instance": True}}}
    with member(app, "analyst", sales["project"]) as (_, analyst):
        ctx = dependencies(app, analyst, context)
        # Names and types of the projects the user can open, never parameter values.
        for details in (False, True):
            granted = read_connections(ctx, details=details)
            assert granted["items"] == [
                {
                    "id": "files",
                    "name": "Files",
                    "family": "storage",
                    "capabilities": ["read", "write"],
                    "projects": [{"id": sales["project"], "name": "Sales"}],
                }
            ]
            assert ("administrators only" in granted.get("details", "")) is details
        for hidden in ({"project": finance["project"]}, {"connection": "warehouse"}, {"connection": "spare"}):
            with pytest.raises(Problem, match="not found"):
                read_connections(ctx, **hidden)
        assert ctx.deps.reads == {}


def test_reading_tools_reach_only_the_branches_their_user_can_open(instance):
    app, admin = instance
    configure(admin)
    sales, context = project(app, admin, "Sales")
    finance, _ = project(app, admin, "Finance")
    feature = admin.post(f"/api/worktrees/{sales['id']}/branches", json={"name": "feature"}).json()
    with member(app, "analyst", sales["project"]) as (user, analyst):
        for page in (context, {"page": "projects"}, {"page": "projectSettings", "project": sales["project"]}):
            ctx = dependencies(app, analyst, page)
            listed = list_projects(ctx)["items"]
            assert [(p["name"], p["role"]) for p in listed] == [("Sales", "reader")]
            assert listed[0]["branches"] == [
                {"worktree": sales["id"], "branch": "main"},
                {"worktree": feature["id"], "branch": "feature"},
            ]
            assert read_flow(ctx, "nodes", worktree=feature["id"])["items"][0]["id"] == "source"
            # The same answer for a missing branch and for a project the user cannot open.
            for unknown in (finance["id"], "worktree_missing"):
                with pytest.raises(Problem, match=r"Branch not found\. Use a worktree ID from list_projects"):
                    read_flow(ctx, "nodes", worktree=unknown)
            assert list(ctx.deps.reads["call"]) == [feature["id"]]
        # Without an open branch, a reading tool needs a worktree.
        with pytest.raises(Problem, match="No branch is open on this page"):
            read_flow(ctx, "nodes")
        # Access is rechecked on every call: the same turn reads nothing more after a revocation,
        # and nothing it read goes back to the provider.
        ctx = dependencies(app, analyst, {"page": "projects"})
        assert read_sql(ctx, node="source", worktree=feature["id"])["path"] == "nodes/source.sql"
        app.state.access.member(sales["project"], user["id"], None)
        for call in (lambda: read_sql(ctx, node="source", worktree=feature["id"]), ctx.deps.check):
            with pytest.raises(Problem, match="can no longer open") as refused:
                call()
            assert refused.value.status == 409
        ctx = dependencies(app, analyst, {"page": "projects"})
        with pytest.raises(Problem, match="Branch not found"):
            read_sql(ctx, node="source", worktree=sales["id"])
        assert list_projects(ctx)["items"] == []


def test_values_of_another_project_follow_its_grants_and_its_runs(instance):
    app, admin = instance
    configure(admin)
    services = app.state.services
    files_connection(services.catalog)
    sales, _ = project(app, admin, "Sales", ["files"])
    _, elsewhere = project(app, admin, "Finance")
    run = services.engine.launch(sales["id"], "dev")
    assert join_run(services.store, run["id"])["status"] == "success"
    ctx = dependencies(app, admin, elsewhere)
    assert read_runs(ctx, worktree=sales["id"])["items"][0]["id"] == run["id"]
    # A run names its branch: its tools need no worktree.
    assert inspect_run(ctx, run["id"])["status"] == "success"
    assert wait_for_run(ctx, run["id"], 0)["status"] == "success"
    assert compare_run(ctx, run["id"]) == {"run": run["id"], "previous": None}
    assert "origin" in json.dumps(read_run_sql(ctx, run["id"], "source"))
    read = ctx.deps.reads["call"][sales["id"]]
    assert read["project_name"] == "Sales" and "results" not in read
    preview = preview_output(ctx, "source", worktree=sales["id"])
    assert preview["rows"][0]["values"] == ["Sales"]
    assert read_schemas(ctx, "source", worktree=sales["id"])["items"][0]["columns"][0]["name"] == "origin"
    # Results, unlike definitions, are rechecked against the branch's grants on later turns.
    assert read["results"] is True
    # Cancelling is a change: it stays on the open branch.
    with pytest.raises(Problem, match="Only a run of the open branch can be cancelled"):
        cancel_run(ctx, run["id"])
    with (
        member(app, "analyst", elsewhere["project"]) as (_, analyst),
        pytest.raises(Problem, match="Execution not found"),
    ):
        inspect_run(dependencies(app, analyst, elsewhere), run["id"])
    # A missing grant elsewhere is reported to the model; it does not end the turn as a 403 would.
    services.engine.access.grant_connections(sales["project"], [])
    for refused in (
        lambda: preview_output(ctx, "source", worktree=sales["id"]),
        lambda: read_schemas(ctx, "source", worktree=sales["id"]),
        lambda: inspect_run(ctx, run["id"]),
    ):
        with pytest.raises(Problem, match="not granted to its project") as error:
            refused()
        assert error.value.status == 409
    assert read_flow(ctx, "nodes", worktree=sales["id"])["items"][0]["id"] == "source"
    configure(admin, allow_data=False)
    ctx = dependencies(app, admin, elsewhere)
    with pytest.raises(Problem, match="The assistant cannot read data"):
        preview_output(ctx, "source", worktree=sales["id"])


def test_a_conversation_stops_once_its_author_loses_what_it_read(instance):
    app, admin = instance
    configure(admin)
    files_connection(app.state.services.catalog)
    sales, _ = project(app, admin, "Sales", ["files"])
    feature = admin.post(f"/api/worktrees/{sales['id']}/branches", json={"name": "feature"}).json()
    page = {"page": "projects"}
    access, assistant = app.state.access, app.state.assistant

    def lost(client, identity):
        response = message(client, identity, page)
        return response.status_code == 409 and response.json()["error"] == LOST_ACCESS

    def asked(client, *calls):
        assistant.configuration.model_override = scripted(*calls)
        identity = conversation(client, page)
        assert turn(client, identity, page)[-1]["turn"]["status"] == "complete"
        return identity

    with member(app, "analyst", sales["project"]) as (user, analyst):
        definitions = asked(analyst, ("read_flow", {"section": "nodes", "worktree": sales["id"]}))
        results = asked(analyst, ("read_schemas", {"worktree": sales["id"]}))
        removed = asked(analyst, ("read_flow", {"section": "nodes", "worktree": feature["id"]}))
        # A revoked connection grant withholds the results read under it, never the definitions.
        access.grant_connections(sales["project"], [])
        assert turn(analyst, definitions, page)[-1]["turn"]["status"] == "complete"
        assert lost(analyst, results)
        access.grant_connections(sales["project"], ["files"])
        assert turn(analyst, results, page)[-1]["turn"]["status"] == "complete"
        # Lost membership of the project it read.
        access.member(sales["project"], user["id"], None)
        assert lost(analyst, definitions) and lost(analyst, results)
        access.member(sales["project"], user["id"], "reader")
        assert turn(analyst, definitions, page)[-1]["turn"]["status"] == "complete"
        # A branch deleted since never blocks the conversation while its project stays open.
        app.state.services.store.delete("worktree", feature["id"])
        assert turn(analyst, removed, page)[-1]["turn"]["status"] == "complete"
    # An instance administrator opens every project and reads connection settings.
    operator = app.state.auth.create_user("operator", "operator-password-123", "admin")
    with TestClient(app) as client:
        client.post("/api/login", json={"username": "operator", "password": "operator-password-123"})
        opened = asked(client, ("read_flow", {"section": "nodes", "worktree": sales["id"]}))
        settings = asked(client, ("read_connections", {"details": True}))
        names = asked(client, ("read_connections", {}), ("list_projects", {}))
        access.update_user(operator["id"], {"role": "member"})
        assert lost(client, opened) and lost(client, settings)
        # Names of projects and connections are not rechecked.
        assert turn(client, names, page)[-1]["turn"]["status"] == "complete"


def test_a_stopped_call_still_records_what_it_read(instance, monkeypatch):
    app, admin = instance
    configure(admin)
    sales, _ = project(app, admin, "Sales")
    page = {"page": "projects"}

    def refuse(*_):
        raise Problem("Refused after the branch was read", 403)

    monkeypatch.setattr(app.state.services.engine, "compile", refuse)
    with member(app, "analyst", sales["project"]) as (user, analyst):
        app.state.assistant.configuration.model_override = scripted(
            ("read_sql", {"node": "source", "compiled": True, "worktree": sales["id"]})
        )
        identity = conversation(analyst, page)
        result = turn(analyst, identity, page)[-1]["turn"]
        # The refusal ended the turn before its tool result event.
        assert (result["status"], result["tools"][0]["status"]) == ("error", "stopped")
        assert result["tools"][0]["reads"][0]["project"] == sales["project"]
        app.state.access.member(sales["project"], user["id"], None)
        response = message(analyst, identity, page)
        assert response.status_code == 409 and response.json()["error"] == LOST_ACCESS


def test_a_conversation_that_read_outside_its_project_no_longer_edits(instance):
    app, client = instance
    configure(client)
    projects = app.state.services.projects
    mine, context = project(app, client, "Mine")
    sales, _ = project(app, client, "Sales")
    feature = client.post(f"/api/worktrees/{mine['id']}/branches", json={"name": "feature"}).json()
    texts = iter(range(10))
    editing = {name for name, spec in TOOLS.items() if spec.needs == "edit"}

    def ask(*reads):
        """A turn that reads, then writes the project documentation."""
        offered = []
        entry = {"section": "project", "text": f"Version {next(texts)}"}
        calls = (*reads, ("write_documentation", {"entry": entry}))
        app.state.assistant.configuration.model_override = scripted(*calls, offered=offered)
        identity = conversation(client, context)
        return identity, turn(client, identity, context)[-1]["turn"], offered

    # Another branch of the same project is open to the same members: edits continue.
    before = projects.snapshot(mine["id"])["commit"]
    _, result, offered = ask(("read_flow", {"section": "nodes", "worktree": feature["id"]}))
    assert result["tools"][1]["action"]["commit"] != before and editing <= offered[-1]
    # So do names of projects and connections.
    _, result, _ = ask(("list_projects", {}), ("read_connections", {}))
    assert result["tools"][2]["action"]["status"] == "applied"
    # Content of another project, or connection settings, ends the edits of the turn that read them.
    for outside in (
        ("read_flow", {"section": "nodes", "worktree": sales["id"]}),
        ("read_connections", {"details": True}),
    ):
        before = projects.snapshot(mine["id"])["commit"]
        identity, result, offered = ask(outside)
        refused = result["tools"][1]
        assert refused["status"] == "error" and "no longer edits" in refused["summary"]
        assert "action" not in refused and projects.snapshot(mine["id"])["commit"] == before
        assert editing <= offered[0]
        # Later turns are not offered editing tools; runs keep their approval.
        offered.clear()
        assert turn(client, identity, context)[-1]["turn"]["status"] == "complete"
        assert offered[0].isdisjoint(editing) and {"launch_run", "read_flow"} <= offered[0]


def test_only_the_open_branch_is_edited_or_run():
    writing = {name for name, spec in TOOLS.items() if spec.needs in ("run", "edit")}
    assert writing == {
        "edit_flow",
        "write_sql",
        "write_documentation",
        "edit_variable",
        "group_nodes",
        "edit_chart",
        "launch_run",
        "cancel_run",
    }
    assert [name for name, spec in TOOLS.items() if spec.approval] == ["launch_run"]
    # No tool that changes or runs a branch can name another one.
    for name in writing:
        assert "worktree" not in inspect.signature(TOOLS[name].function).parameters, name


def test_page_context_names_the_project_and_keeps_only_a_known_environment(instance):
    app, client = instance
    configure(client)
    sales, _ = project(app, client, "Sales")
    page = {"page": "projectSettings", "project": sales["project"], "environment": "removed"}
    app.state.assistant.configuration.model_override = scripted()
    result = turn(client, conversation(client, page), page)[-1]["turn"]
    assert result["context"]["project_name"] == "Sales"
    assert result["context"]["environment"] == ""
    # Results of another branch are read in the first environment when the page selects none.
    ctx = dependencies(app, client, page)
    assert ctx.deps.branch(sales["id"]).environment == "dev"
    ctx = dependencies(app, client, {**page, "environment": "prod"})
    assert ctx.deps.branch(sales["id"]).environment == "prod"


LABELS = Path(__file__).resolve().parents[1] / "frontend/src/AssistantMessage.tsx"


@pytest.mark.skipif(not LABELS.exists(), reason="Source archives ship no frontend sources")
def test_every_tool_has_a_chat_label():
    """The chat names each tool call by a translated label: a new tool needs one."""
    source = LABELS.read_text()
    table = source[source.index("const toolLabels") : source.index("};")]
    assert set(re.findall(r"^\s*(\w+):", table, re.MULTILINE)) == set(TOOLS)
