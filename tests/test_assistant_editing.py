"""Assistant save units, attribution, permission boundaries and durable inverse merges."""

import json

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from pydantic_ai.models.test import TestModel
from test_assistant import configure, conversation, dependencies, project, turn
from test_assistant import instance as instance

from duckpad.assistant.editing import WRITE_TOOLS, NodeEdit, edit_flow
from duckpad.bundle import bundle_to_files
from duckpad.util import Problem

SQL = "-- @output result\nSELECT 1 AS value;\n"


def seed(app, client):
    configure(client)
    worktree, context = project(client)
    projects = app.state.services.projects
    snapshot = projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"] = [{"id": name, "params": {}} for name in ("first", "second")]
    bundle["node_sql"] = {f"nodes/{name}.sql": SQL for name in ("first", "second")}
    bundle["variables"] = {"region": {"type": "text", "default": "North"}}
    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    return worktree, context


def scripted(app, calls, before=None, fail=False):
    index = 0

    async def stream(messages, info):
        nonlocal index
        if index < len(calls):
            if before:
                before(index)
            name, args = calls[index]
            index += 1
            yield {0: DeltaToolCall(name=name, json_args=json.dumps(args), tool_call_id=f"edit-{index}")}
        elif fail:
            raise RuntimeError("Provider stopped after saving")
        else:
            yield "Saved."

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=stream)


def write_turn(app, client, context, calls, **options):
    identity = conversation(client, context)
    scripted(app, calls, **options)
    events = turn(client, identity, context, "Make the requested change")
    result = events[-1]["turn"]
    assert result["status"] == ("error" if options.get("fail") else "complete"), events
    return identity, result


def undo(client, identity, result, context, action=""):
    response = client.post(
        f"/api/assistant/conversations/{identity}/undo",
        json={
            "turn": result["id"],
            "action": action,
            "context": context,
        },
    )
    assert response.status_code == 200, response.text
    return next(t for t in response.json()["turns"] if t["id"] == result["id"])


def change(app, worktree, callback):
    projects = app.state.services.projects
    snapshot = projects.snapshot(worktree["id"])
    callback(snapshot["bundle"])
    return projects.write(worktree["id"], snapshot["revision"], bundle_to_files(snapshot["bundle"]))


@pytest.mark.parametrize(
    ("name", "args"),
    [
        ("edit_flow", {"nodes": [{"operation": "add", "id": "added", "label": "Added", "sql": SQL}]}),
        ("edit_flow", {"nodes": [{"operation": "remove", "id": "second"}]}),
        (
            "edit_flow",
            {
                "nodes": [
                    {"operation": "update", "id": "first", "label": "Renamed", "position": {"x": 10, "y": 20}}
                ]
            },
        ),
        ("write_sql", {"node": "first", "sql": SQL.replace("1", "2")}),
        (
            "write_sql",
            {"template": "filter", "sql": "-- @input input\n-- @output result\nSELECT * FROM {{ input }};"},
        ),
        ("write_documentation", {"section": "project", "text": "Overview"}),
        ("write_documentation", {"section": "nodes", "node": "first", "text": "Source"}),
        (
            "write_documentation",
            {"section": "datasets", "node": "first", "output": "result", "text": "Results"},
        ),
        (
            "write_documentation",
            {
                "section": "columns",
                "node": "first",
                "output": "result",
                "column": "value",
                "text": "An integer",
            },
        ),
        (
            "edit_variable",
            {"operation": "create", "name": "limit", "definition": {"type": "number", "default": 5}},
        ),
        ("edit_variable", {"operation": "update", "name": "region", "definition": {"default": "South"}}),
        ("edit_variable", {"operation": "rename", "name": "region", "new_name": "area"}),
        ("group_nodes", {"nodes": ["first", "second"], "name": "Together"}),
    ],
)
def test_each_write_is_one_attributed_commit_and_can_be_undone(instance, name, args):
    app, client = instance
    worktree, context = seed(app, client)
    projects = app.state.services.projects
    before = projects.snapshot(worktree["id"])
    identity, result = write_turn(app, client, context, [(name, args)])
    assert result["tools"][0]["status"] == "complete", result
    action = result["tools"][0]["action"]
    assert action["status"] == "applied"
    assert action["before"] == before["commit"]
    assert projects.git(worktree["path"], "rev-list", "--count", before["commit"] + "..HEAD") == "1"
    author = app.state.auth.commit_identity(app.state.auth.check(client.cookies.get("duckpad_session")))
    metadata = projects.git(worktree["path"], "show", "-s", "--format=%an%n%ae%n%B", action["commit"])
    assert metadata.startswith(author["name"] + "\n" + author["email"] + "\n")
    assert f"Duckpad-Assistant: {identity}" in metadata
    assert projects.versioning.history(worktree["id"])["items"][0]["assistant"] == identity
    # The API receipt is durable, not merely an event from the response stream.
    resumed = client.get(f"/api/assistant/conversations/{identity}").json()["turns"][0]
    assert resumed["tools"][0]["action"] == action
    updated = undo(client, identity, resumed, context)
    assert updated["tools"][0]["action"]["status"] == "undone"
    assert projects.snapshot(worktree["id"])["files"] == before["files"]
    head = projects.snapshot(worktree["id"])["commit"]
    undo(client, identity, resumed, context)
    assert projects.snapshot(worktree["id"])["commit"] == head


def test_reader_has_no_write_tools_and_forced_write_or_undo_is_denied(instance):
    app, admin = instance
    worktree, context = seed(app, admin)
    user = app.state.auth.create_user("reader", "reader-password-123")
    app.state.access.member(worktree["project"], user["id"], "reader")
    with TestClient(app) as reader:
        reader.post("/api/login", json={"username": "reader", "password": "reader-password-123"})
        app.state.assistant.configuration.model_override = TestModel(
            call_tools=[], custom_output_text="Read only"
        )
        identity = conversation(reader, context)
        result = turn(reader, identity, context)[-1]["turn"]
        available = (
            app.state.assistant.configuration.model_override.last_model_request_parameters.function_tools
        )
        assert {t.name for t in available}.isdisjoint(t.__name__ for t in WRITE_TOOLS)
        with pytest.raises(Problem, match="role does not allow"):
            edit_flow(dependencies(app, reader, context), [NodeEdit(operation="add", id="forbidden")])
        response = reader.post(
            f"/api/assistant/conversations/{identity}/undo", json={"turn": result["id"], "context": context}
        )
        assert response.status_code == 403
        app.state.access.member(worktree["project"], user["id"], "editor")
        scripted(app, [("write_sql", {"node": "first", "sql": SQL.replace("1", "2")})])
        result = turn(reader, identity, context)[-1]["turn"]
        assert result["tools"][0]["action"]["commit"]
        app.state.access.member(worktree["project"], user["id"], "reader")
        response = reader.post(
            f"/api/assistant/conversations/{identity}/undo", json={"turn": result["id"], "context": context}
        )
        assert response.status_code == 403


def test_undo_preserves_later_node_edits_beyond_base_cache(instance):
    app, client = instance
    worktree, context = seed(app, client)
    identity, result = write_turn(
        app, client, context, [("write_sql", {"node": "first", "sql": SQL.replace("1", "2")})]
    )
    for i in range(34):
        change(
            app,
            worktree,
            lambda b, i=i: b["node_sql"].update({"nodes/second.sql": SQL.replace("1", str(i + 3))}),
        )
    projects = app.state.services.projects
    projects.revisions.clear()
    projects.commit_files.clear()
    undo(client, identity, result, context)
    files = projects.snapshot(worktree["id"])["files"]
    assert files["nodes/first.sql"] == SQL
    assert files["nodes/second.sql"] == SQL.replace("1", "36")


def test_undo_conflict_is_durable_and_resolution_preserves_independent_edits(instance):
    app, client = instance
    worktree, context = seed(app, client)
    projects = app.state.services.projects
    identity, result = write_turn(
        app, client, context, [("write_sql", {"node": "first", "sql": SQL.replace("1", "2")})]
    )
    current = change(
        app,
        worktree,
        lambda b: b["node_sql"].update(
            {"nodes/first.sql": SQL.replace("1", "3"), "nodes/second.sql": SQL.replace("1", "4")}
        ),
    )
    updated = undo(client, identity, result, context)
    action = updated["tools"][0]["action"]
    assert action["status"] == "undo_conflict"
    conflict = app.state.services.store.get("conflict", action["conflict"])
    assert conflict["base"]["nodes/first.sql"] == SQL.replace("1", "2")
    assert conflict["proposal"]["nodes/first.sql"] == SQL
    assert conflict["proposal"]["nodes/second.sql"] == SQL.replace("1", "4")
    assert projects.snapshot(worktree["id"])["commit"] == current["commit"]
    undo(client, identity, result, context)
    assert len(projects.snapshot(worktree["id"])["conflicts"]) == 1
    # A further independent change while the conflict dialog is open is retained too.
    change(app, worktree, lambda b: b["documentation"].update(project="Later documentation"))
    endpoint = f"/api/conflicts/{conflict['id']}/resolve"
    assert client.post(endpoint, json={"choice": "proposal"}).status_code == 409
    response = client.post(endpoint, json={"choice": "proposal"})
    assert response.status_code == 200, response.text
    files = projects.snapshot(worktree["id"])["files"]
    assert files["nodes/first.sql"] == SQL
    assert files["nodes/second.sql"] == SQL.replace("1", "4")
    assert files["README.md"] == "Later documentation"
    saved = client.get(f"/api/assistant/conversations/{identity}").json()["turns"][0]
    assert saved["tools"][0]["action"]["status"] == "undone"


def test_undo_a_turn_runs_in_reverse_order_and_survives_provider_failure(instance):
    app, client = instance
    worktree, context = seed(app, client)
    identity, result = write_turn(
        app,
        client,
        context,
        [
            ("write_sql", {"node": "first", "sql": SQL.replace("1", "2")}),
            ("write_sql", {"node": "first", "sql": SQL.replace("1", "3")}),
        ],
        fail=True,
    )
    assert len([t for t in result["tools"] if t.get("action")]) == 2
    updated = undo(client, identity, result, context)
    assert all(t["action"]["status"] == "undone" for t in updated["tools"])
    assert app.state.services.projects.snapshot(worktree["id"])["files"]["nodes/first.sql"] == SQL


def test_concurrent_forward_merge_records_only_the_assistant_change(instance):
    app, client = instance
    worktree, context = seed(app, client)
    identity, result = write_turn(
        app,
        client,
        context,
        [("write_sql", {"node": "first", "sql": SQL.replace("1", "2")})],
        before=lambda _: change(
            app, worktree, lambda b: b["node_sql"].update({"nodes/second.sql": SQL.replace("1", "5")})
        ),
    )
    action = result["tools"][0]["action"]
    assert [c["id"] for c in action["changes"]] == ["node/first"]
    undo(client, identity, result, context)
    assert app.state.services.projects.snapshot(worktree["id"])["files"]["nodes/second.sql"] == SQL.replace(
        "1", "5"
    )


def test_forward_conflict_and_invalid_bundle_never_overwrite(instance):
    app, client = instance
    worktree, context = seed(app, client)
    identity, result = write_turn(
        app,
        client,
        context,
        [("write_sql", {"node": "first", "sql": SQL.replace("1", "2")})],
        before=lambda _: change(
            app, worktree, lambda b: b["node_sql"].update({"nodes/first.sql": SQL.replace("1", "5")})
        ),
    )
    action = result["tools"][0]["action"]
    assert action["status"] == "conflict" and not action["commit"]
    assert (
        client.post(f"/api/conflicts/{action['conflict']}/resolve", json={"choice": "proposal"}).status_code
        == 200
    )
    saved = client.get(f"/api/assistant/conversations/{identity}").json()["turns"][0]
    assert saved["tools"][0]["action"]["status"] == "applied"
    undo(client, identity, saved, context)
    projects = app.state.services.projects
    assert projects.snapshot(worktree["id"])["files"]["nodes/first.sql"] == SQL.replace("1", "5")
    before = projects.snapshot(worktree["id"])["commit"]
    _, invalid = write_turn(
        app,
        client,
        context,
        [
            (
                "edit_flow",
                {"edges": [{"operation": "connect", "id": "bad", "source": "missing", "target": "first"}]},
            )
        ],
    )
    assert invalid["tools"][0]["status"] == "error"
    assert "diagnostics" in invalid["tools"][0]["summary"]
    assert projects.snapshot(worktree["id"])["commit"] == before


def test_saved_problems_block_neither_unrelated_edits_nor_undo(instance):
    app, client = instance
    worktree, context = seed(app, client)
    # The canvas saves an added node before its input is connected.
    change(app, worktree, lambda b: b["flow"]["nodes"].append({"id": "pending", "template": "filter"}))
    identity, result = write_turn(
        app, client, context, [("write_sql", {"node": "first", "sql": SQL.replace("1", "2")})]
    )
    assert result["tools"][0]["action"]["commit"], result
    undo(client, identity, result, context)
    projects = app.state.services.projects
    assert projects.snapshot(worktree["id"])["files"]["nodes/first.sql"] == SQL
    before = projects.snapshot(worktree["id"])["commit"]
    _, invalid = write_turn(
        app,
        client,
        context,
        [("edit_flow", {"nodes": [{"operation": "add", "id": "other", "template": "filter"}]})],
    )
    # Only the problem the edit introduces is reported, and it is still rejected.
    assert json.loads(invalid["tools"][0]["summary"])["diagnostics"] == [
        {"file": "flow.json", "node": "other", "message": "Connect input 'source' on other"}
    ]
    assert projects.snapshot(worktree["id"])["commit"] == before


def test_template_impact_connections_parameters_and_variable_rename(instance):
    app, client = instance
    worktree, context = seed(app, client)
    change(
        app,
        worktree,
        lambda b: b["templates"].update(
            custom='-- @param region: text = "North"\n-- @output result\nSELECT {{ region }} AS value;\n'
        ),
    )
    _, result = write_turn(
        app,
        client,
        context,
        [
            (
                "edit_flow",
                {
                    "nodes": [
                        {
                            "operation": "add",
                            "id": "linked",
                            "template": "custom",
                            "params": {"region": {"$var": "region"}},
                        },
                        {"operation": "add", "id": "linked2", "template": "custom"},
                        {
                            "operation": "add",
                            "id": "consumer",
                            "sql": "-- @input input\n-- @output result\nSELECT * FROM {{ input }};",
                        },
                    ],
                    "edges": [
                        {"operation": "connect", "id": "link", "source": "first", "target": "consumer"}
                    ],
                },
            ),
            (
                "write_sql",
                {
                    "template": "custom",
                    "sql": '-- @param region: text = "East"\n-- @output result\nSELECT {{ region }} AS value;\n',
                },
            ),
            ("edit_variable", {"operation": "rename", "name": "region", "new_name": "area"}),
        ],
    )
    assert all(t["status"] == "complete" for t in result["tools"]), result
    assert result["tools"][1]["action"]["affected_nodes"] == 2
    bundle = app.state.services.projects.snapshot(worktree["id"])["bundle"]
    assert bundle["flow"]["nodes"][2]["params"]["region"] == {"$var": "area"}


def test_multiple_calls_in_one_model_response_are_sequential_and_restart_undoable(instance):
    from pydantic_ai.messages import ToolReturnPart

    from duckpad.app import create_app

    app, client = instance
    worktree, context = seed(app, client)
    identity = conversation(client, context)

    async def stream(messages, info):
        if any(isinstance(p, ToolReturnPart) for p in messages[-1].parts):
            yield "Saved both edits."
        else:
            yield {
                i: DeltaToolCall(
                    name="write_sql",
                    json_args=json.dumps(
                        {
                            "node": "first",
                            "sql": SQL.replace("1", str(i + 2)),
                        }
                    ),
                    tool_call_id=f"batch-{i}",
                )
                for i in range(2)
            }

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=stream)
    result = turn(client, identity, context)[-1]["turn"]
    assert result["status"] == "complete", result
    first, second = [t["action"] for t in result["tools"]]
    assert second["before"] == first["commit"]
    restarted = create_app(app.state.services.store.home, watch=False)
    with TestClient(restarted) as resumed:
        assert (
            resumed.post("/api/login", json={"password": app.state.auth.initial_password}).status_code == 200
        )
        saved = resumed.get(f"/api/assistant/conversations/{identity}").json()["turns"][0]
        updated = undo(resumed, identity, saved, context)
        assert all(t["action"]["status"] == "undone" for t in updated["tools"])
        assert restarted.state.services.projects.snapshot(worktree["id"])["files"]["nodes/first.sql"] == SQL
