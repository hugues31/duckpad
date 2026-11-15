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


def scripted(*calls):
    """A model that makes the given tool calls, one per request, then answers.

    A call is a tool name, its arguments and, for a provider that reuses call IDs, its ID.
    """

    async def stream(messages, info):
        answered = 0
        for message in reversed(messages):
            if any(isinstance(part, UserPromptPart) for part in message.parts):
                break
            answered += sum(isinstance(part, ToolReturnPart) for part in message.parts)
        if answered < len(calls):
            name, arguments, *call = calls[answered]
            call = call[0] if call else f"call-{answered}"
            yield {0: DeltaToolCall(name=name, json_args=json.dumps(arguments), tool_call_id=call)}
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
    identity = conversation(client)
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
    # Results, unlike definitions, are rechecked against the branch's grants on later turns.
    read = ctx.deps.reads["call"][sales["id"]]
    assert read["project_name"] == "Sales" and read["results"] is True
    preview = preview_output(ctx, "source", worktree=sales["id"])
    assert preview["rows"][0]["values"] == ["Sales"]
    assert read_schemas(ctx, "source", worktree=sales["id"])["items"][0]["columns"][0]["name"] == "origin"
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
    sales, opened = project(app, admin, "Sales", ["files"])
    feature = admin.post(f"/api/worktrees/{sales['id']}/branches", json={"name": "feature"}).json()
    page = {"page": "projects"}
    access, assistant = app.state.access, app.state.assistant

    def lost(client, identity):
        response = message(client, identity, page)
        return response.status_code == 409 and response.json()["error"] == LOST_ACCESS

    def asked(client, *calls):
        assistant.configuration.model_override = scripted(*calls)
        identity = conversation(client)
        assert turn(client, identity, page)[-1]["turn"]["status"] == "complete"
        return identity

    run = app.state.services.engine.launch(sales["id"], "dev")
    assert join_run(app.state.services.store, run["id"])["status"] == "success"
    with member(app, "analyst", sales["project"], role="editor") as (user, analyst):
        definitions = asked(analyst, ("read_flow", {"section": "nodes", "worktree": sales["id"]}))
        results = asked(analyst, ("read_schemas", {"worktree": sales["id"]}))
        inspected = asked(analyst, ("inspect_run", {"run": run["id"]}))
        removed = asked(analyst, ("read_flow", {"section": "nodes", "worktree": feature["id"]}))
        # An edit is a read too: its result holds diffs and diagnostics of its branch.
        entry = {"section": "project", "text": "Edited by the analyst"}
        assistant.configuration.model_override = scripted(("write_documentation", {"entry": entry}))
        edited = conversation(analyst)
        assert turn(analyst, edited, opened)[-1]["turn"]["tools"][0]["action"]["status"] == "applied"
        # A revoked connection grant withholds the results read under it, never the definitions.
        # A run that retention removed since is still a result of its branch.
        app.state.services.store.delete("run", run["id"])
        access.grant_connections(sales["project"], [])
        assert turn(analyst, definitions, page)[-1]["turn"]["status"] == "complete"
        assert lost(analyst, results) and lost(analyst, inspected)
        access.grant_connections(sales["project"], ["files"])
        assert turn(analyst, results, page)[-1]["turn"]["status"] == "complete"
        # Lost membership of the project it read.
        access.member(sales["project"], user["id"], None)
        assert lost(analyst, definitions) and lost(analyst, results) and lost(analyst, edited)
        access.member(sales["project"], user["id"], "reader")
        assert turn(analyst, definitions, page)[-1]["turn"]["status"] == "complete"

        # Lost during a response: its next tool call ends it, before what earlier turns read
        # returns to the provider.
        async def revoked(messages, info):
            access.member(sales["project"], user["id"], None)
            yield {0: DeltaToolCall(name="list_projects", json_args="{}", tool_call_id="later")}

        assistant.configuration.model_override = FunctionModel(stream_function=revoked)
        ended = turn(analyst, definitions, page)[-1]["turn"]
        assert (ended["status"], ended["error"], ended["tools"][0]["status"]) == (
            "error",
            LOST_ACCESS,
            "stopped",
        )
        assistant.configuration.model_override = scripted()
        access.member(sales["project"], user["id"], "reader")
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
        identity = conversation(analyst)
        result = turn(analyst, identity, page)[-1]["turn"]
        # The refusal ended the turn before its tool result event.
        assert (result["status"], result["tools"][0]["status"]) == ("error", "stopped")
        assert result["tools"][0]["reads"][0]["project"] == sales["project"]
        app.state.access.member(sales["project"], user["id"], None)
        response = message(analyst, identity, page)
        assert response.status_code == 409 and response.json()["error"] == LOST_ACCESS


def decide(client, identity, pending, approved):
    """Answer the confirmation a turn waits for; return the turn once its response has ended."""
    card = next(card for card in pending["tools"] if card["status"] == "awaiting_approval")
    response = client.post(
        f"/api/assistant/conversations/{identity}/approvals",
        json={"turn": pending["id"], "tool": card["id"], "approved": approved},
    )
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines()][-1]["turn"]


def test_an_edit_after_a_read_elsewhere_waits_for_its_confirmation(instance):
    app, client = instance
    configure(client)
    projects = app.state.services.projects
    mine, context = project(app, client, "Mine")
    sales, elsewhere = project(app, client, "Sales")
    feature = client.post(f"/api/worktrees/{mine['id']}/branches", json={"name": "feature"}).json()
    versions = iter(range(20))

    def readme():
        return projects.snapshot(mine["id"])["files"]["README.md"]

    def ask(*reads, identity=None, size=1):
        """A turn sent from the branch of Mine that reads, then writes its documentation."""
        text = f"Version {next(versions)}\n" * size
        entry = {"section": "project", "text": text}
        calls = (*reads, ("write_documentation", {"entry": entry}))
        app.state.assistant.configuration.model_override = scripted(*calls)
        identity = identity or conversation(client)
        return identity, turn(client, identity, context)[-1]["turn"], text

    foreign = ("read_flow", {"section": "nodes", "worktree": sales["id"]})
    # Another branch of the same project is open to the same members, and names tell nothing.
    same = ("read_flow", {"section": "nodes", "worktree": feature["id"]})
    _, result, text = ask(same, ("list_projects", {}), ("read_connections", {}))
    assert result["status"] == "complete" and result["tools"][-1]["action"]["status"] == "applied"
    assert readme() == text
    # After content of another project, or connection settings, the edit shows its exact changes
    # and waits; nothing is saved meanwhile.
    for outside in (foreign, ("read_connections", {"details": True})):
        before = readme()
        identity, pending, text = ask(outside)
        approval = pending["tools"][-1]["approval"]
        assert pending["status"] == "awaiting_approval" and "action" not in pending["tools"][-1]
        assert (approval["kind"], approval["decision"]) == ("edit", None)
        assert [d["path"] for d in approval["diffs"]] == ["README.md"]
        assert f"+{text}" in approval["diffs"][0]["diff"]
        assert readme() == before
        assert message(client, identity, context).status_code == 409
        applied = decide(client, identity, pending, True)
        assert applied["status"] == "complete" and applied["tools"][-1]["action"]["status"] == "applied"
        assert readme() == text
    # An edit too large to be shown in full is not offered for confirmation.
    before = readme()
    _, result, _ = ask(foreign, size=5000)
    assert result["status"] == "complete" and "too large to confirm" in result["tools"][-1]["summary"]
    assert readme() == before
    # What the save derives is confirmed with the change: a spreadsheet reader enables Excel.
    reader = {"operation": "add", "id": "sheet", "template": "load_xlsx"}
    app.state.assistant.configuration.model_override = scripted(foreign, ("edit_flow", {"nodes": [reader]}))
    identity = conversation(client)
    pending = turn(client, identity, context)[-1]["turn"]
    assert [d["path"] for d in pending["tools"][-1]["approval"]["diffs"]] == ["extensions.json", "flow.json"]
    action = decide(client, identity, pending, True)["tools"][-1]["action"]
    assert action["status"] == "applied"
    assert set(projects.git(mine["path"], "show", "--name-only", "--format=", action["commit"]).split()) == {
        "extensions.json",
        "flow.json",
    }
    # A change the project would refuse is reported at once, not after its confirmation.
    invalid = ("write_sql", {"node": "source", "sql": "-- @unknown directive\nSELECT 1;"})
    app.state.assistant.configuration.model_override = scripted(foreign, invalid)
    refused = turn(client, conversation(client), context)[-1]["turn"]
    assert refused["status"] == "complete" and "changes are invalid" in refused["tools"][-1]["summary"]
    # A declined edit saves nothing, and the conversation continues.
    before = readme()
    identity, pending, _ = ask(foreign)
    declined = decide(client, identity, pending, False)
    assert declined["status"] == "complete" and declined["tools"][-1]["approval"]["decision"] is False
    assert readme() == before and "action" not in declined["tools"][-1]
    # Every later edit of that conversation waits too.
    _, pending, _ = ask(identity=identity)
    assert pending["status"] == "awaiting_approval"
    # A branch that changed since the confirmation gets another change than the confirmed one:
    # nothing is saved, and the change must be asked again.
    identity, pending, text = ask(foreign)
    snapshot = projects.snapshot(mine["id"])
    projects.write(mine["id"], snapshot["revision"], {**snapshot["files"], "README.md": "Edited meanwhile"})
    refused = decide(client, identity, pending, True)
    assert (
        refused["tools"][-1]["status"] == "error"
        and "differs from the confirmed" in refused["tools"][-1]["summary"]
    )
    assert readme() == "Edited meanwhile"
    # The page a message is sent from decides: what an earlier turn read on the branch of Sales
    # is content of another project once the conversation edits Mine.
    app.state.assistant.configuration.model_override = scripted(("read_flow", {"section": "nodes"}))
    moved = conversation(client)
    assert turn(client, moved, elsewhere)[-1]["turn"]["status"] == "complete"
    _, pending, _ = ask(identity=moved)
    assert pending["status"] == "awaiting_approval"
    stayed = conversation(client)
    assert turn(client, stayed, context)[-1]["turn"]["status"] == "complete"
    _, result, _ = ask(identity=stayed)
    assert result["status"] == "complete"
    # An edit of Sales is a read of Sales: its result holds diffs of that branch.
    entry = {"section": "project", "text": "Sales documentation"}
    app.state.assistant.configuration.model_override = scripted(("write_documentation", {"entry": entry}))
    edited = conversation(client)
    assert turn(client, edited, elsewhere)[-1]["turn"]["tools"][0]["action"]["status"] == "applied"
    _, pending, _ = ask(identity=edited)
    assert pending["status"] == "awaiting_approval"


def test_reads_survive_reused_call_ids_and_conversations_started_on_a_branch(instance):
    app, client = instance
    configure(client)
    store = app.state.services.store
    _, context = project(app, client, "Mine")
    sales, elsewhere = project(app, client, "Sales")
    entry = {"section": "project", "text": "After the pause"}
    later = {"section": "project", "text": "Another change"}
    app.state.assistant.configuration.model_override = scripted(
        ("read_flow", {"section": "nodes", "worktree": sales["id"]}, "same"),
        ("write_documentation", {"entry": entry}, "edit"),
        # After the confirmation, the provider reuses the IDs of the earlier calls.
        ("read_flow", {"section": "nodes"}, "same"),
        ("write_documentation", {"entry": later}, "edit"),
    )
    identity = conversation(client)
    pending = turn(client, identity, context)[-1]["turn"]
    resumed = decide(client, identity, pending, True)
    read = next(card for card in resumed["tools"] if card["id"] == "same")
    assert {r["project_name"] for r in read["reads"]} == {"Sales", "Mine"}
    # One answer confirms one save: the second edit asks again.
    assert resumed["status"] == "awaiting_approval", resumed
    assert "+Another change" in resumed["tools"][-1]["approval"]["diffs"][0]["diff"]
    assert decide(client, identity, resumed, True)["status"] == "complete"
    assert app.state.services.projects.snapshot(context["worktree"])["files"]["README.md"] == "Another change"
    # A conversation started while tied to a branch recorded no read: it read that branch.
    app.state.assistant.configuration.model_override = scripted(("read_flow", {"section": "nodes"}))
    bound = conversation(client)
    assert turn(client, bound, elsewhere)[-1]["turn"]["status"] == "complete"
    record = store.get("assistant_conversation", bound)
    for card in record["turns"][0]["tools"]:
        card.pop("reads")
    record.update(project=sales["project"], worktree=sales["id"], branch="main")
    store.put("assistant_conversation", bound, record)
    entry = {"section": "project", "text": "From an earlier conversation"}
    app.state.assistant.configuration.model_override = scripted(("write_documentation", {"entry": entry}))
    assert turn(client, bound, context)[-1]["turn"]["status"] == "awaiting_approval"
    assert {"project", "worktree", "branch"}.isdisjoint(
        client.get(f"/api/assistant/conversations/{bound}").json()
    )


def test_a_run_read_is_rechecked_under_the_grants_it_ran_with(instance):
    app, client = instance
    configure(client)
    services = app.state.services
    files_connection(services.catalog)
    sales, _ = project(app, client, "Sales", ["files"])
    page = {"page": "projects"}
    run = services.engine.launch(sales["id"], "dev")
    assert join_run(services.store, run["id"])["status"] == "success"
    # The card of a reused call ID keeps the arguments of its first call: the read names the run.
    app.state.assistant.configuration.model_override = scripted(
        ("read_flow", {"section": "nodes", "worktree": sales["id"]}, "same"),
        ("inspect_run", {"run": run["id"]}, "same"),
    )
    identity = conversation(client)
    card = turn(client, identity, page)[-1]["turn"]["tools"][0]
    assert card["args"] == {"section": "nodes", "worktree": sales["id"]}
    assert [read.get("runs") for read in card["reads"]] == [None, [run["id"]]]
    # The branch stops using the connection, whose grant is then revoked: only the run used it.
    snapshot = services.projects.snapshot(sales["id"])
    snapshot["bundle"]["node_sql"]["nodes/source.sql"] = "-- @output result\nSELECT 1 AS value;"
    services.projects.write(sales["id"], snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert message(client, identity, page).status_code == 200
    app.state.access.grant_connections(sales["project"], [])
    response = message(client, identity, page)
    assert response.status_code == 409 and response.json()["error"] == LOST_ACCESS


def test_a_conversation_follows_its_author_and_undoes_on_the_branch_it_edited(instance):
    app, client = instance
    configure(client)
    projects = app.state.services.projects
    mine, context = project(app, client, "Mine")
    _, elsewhere = project(app, client, "Sales")
    entry = {"section": "project", "text": "Written by the assistant"}
    app.state.assistant.configuration.model_override = scripted(("write_documentation", {"entry": entry}))
    identity = conversation(client)
    edited = turn(client, identity, context)[-1]["turn"]
    assert edited["tools"][0]["action"]["status"] == "applied"
    # The same conversation continues from other pages.
    app.state.assistant.configuration.model_override = scripted()
    for page in (elsewhere, {"page": "instanceSettings", "section": "connections"}):
        assert turn(client, identity, page)[-1]["turn"]["status"] == "complete"

    def undo(page):
        return client.post(
            f"/api/assistant/conversations/{identity}/undo",
            json={"turn": edited["id"], "action": "", "context": page},
        )

    # A change is undone from the branch it was made on.
    for page in (elsewhere, {"page": "projects"}):
        response = undo(page)
        assert response.status_code == 409 and "Open the branch of this change" in response.text
    assert projects.snapshot(mine["id"])["files"]["README.md"] == entry["text"]
    assert undo(context).status_code == 200
    assert projects.snapshot(mine["id"])["files"]["README.md"] != entry["text"]


def test_only_the_open_branch_is_edited_or_run():
    writing = {name for name, spec in TOOLS.items() if spec.needs == "write"}
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
    result = turn(client, conversation(client), page)[-1]["turn"]
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
