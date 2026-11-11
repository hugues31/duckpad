"""Assistant save units, attribution, permission boundaries and durable inverse merges."""

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import asgi_client, assert_responsive
from pydantic_ai.messages import ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from pydantic_ai.models.test import TestModel
from test_assistant import configure, conversation, dependencies, project, turn
from test_assistant import instance as instance
from test_project_save_atomicity import observe_after_quiet_period

from duckpad.assistant.arguments import AddNode, RemoveNode, UpdateNode
from duckpad.assistant.editing import WRITE_TOOLS, edit_flow
from duckpad.assistant.runs import RUN_TOOLS
from duckpad.bundle import bundle_to_files
from duckpad.git.command import GitTimeout
from duckpad.util import Problem
from duckpad.validation import validate

SQL = "-- @output result\nSELECT 1 AS value;\n"
BAR = {"mark": "bar", "encoding": {"x": {"field": "value", "type": "quantitative"}}}
CONSUMER = "-- @input input\n-- @output result\nSELECT * FROM {{ input }};"
LINE = {"mark": "line", "encoding": {"y": {"field": "value", "type": "quantitative"}}}
EXISTING_NODE_IDS = ["keep.rows", "kept rows / 日本語", "n" * 101]


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


def variable(**change):
    """An edit_variable call: one operation-specific change."""
    return ("edit_variable", {"change": change})


def chart(**change):
    """An edit_chart call: one operation-specific change."""
    return ("edit_chart", {"change": change})


def flow(*nodes, edges=None):
    """An edit_flow call: operation-specific node and edge changes."""
    return ("edit_flow", {"nodes": list(nodes), **({"edges": edges} if edges is not None else {})})


def documentation(**entry):
    """A write_documentation call: one section-specific entry."""
    return ("write_documentation", {"entry": entry})


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
        documentation(section="project", text="Overview"),
        documentation(section="nodes", node="first", text="Source"),
        documentation(section="datasets", node="first", output="result", text="Results"),
        documentation(section="columns", node="first", output="result", column="value", text="An integer"),
        variable(operation="create", name="limit", definition={"type": "number", "default": 5}),
        variable(operation="update", name="region", definition={"default": "South"}),
        variable(operation="rename", name="region", new_name="area"),
        variable(operation="delete", name="region"),
        ("group_nodes", {"nodes": ["first", "second"], "name": "Together"}),
        chart(operation="create", node="first", output="result", name="Trend", spec=BAR),
        chart(operation="update", node="first", output="result", name="Values", spec=LINE),
        chart(operation="rename", node="first", output="result", name="Values", new_name="Sums"),
        chart(operation="delete", node="first", output="result", name="Values"),
    ],
)
def test_each_write_is_one_attributed_commit_and_can_be_undone(instance, name, args):
    app, client = instance
    worktree, context = seed(app, client)
    if name == "edit_chart":
        change(app, worktree, lambda b: b.update(charts={"first:result": [{"name": "Values", "spec": BAR}]}))
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


def test_a_project_write_never_delays_other_conversations(instance, monkeypatch):
    app, client = instance
    worktree, context = seed(app, client)
    projects = app.state.services.projects
    save, writing, proceed = projects.write, threading.Event(), threading.Event()
    released = None
    changed = "-- @output result\nSELECT 2 AS value;\n"

    def slow(*args, **kwargs):
        # The writing conversation holds its lock, and the repository's, meanwhile.
        nonlocal released
        writing.set()
        proceed.wait(5)
        released = time.monotonic()
        return save(*args, **kwargs)

    async def stream(messages, info):
        prompts = [p.content for m in messages for p in m.parts if isinstance(p, UserPromptPart)]
        if "Change the first node" in prompts and not any(
            isinstance(p, ToolReturnPart) for p in messages[-1].parts
        ):
            args = json.dumps({"node": "first", "sql": changed})
            yield {0: DeltaToolCall(name="write_sql", json_args=args, tool_call_id="edit")}
        else:
            yield "Done."

    monkeypatch.setattr(projects, "write", slow)
    app.state.assistant.configuration.model_override = FunctionModel(stream_function=stream)
    writer, reader = conversation(client, context), conversation(client, context)

    async def scenario():
        headers = {"authorization": "Bearer " + client.cookies["duckpad_session"]}
        async with asgi_client(app, headers=headers) as http:

            def send(identity, message):
                return http.post(
                    f"/api/assistant/conversations/{identity}/messages",
                    json={"message": message, "provider": "primary", "model": "test", "context": context},
                )

            edit = asyncio.create_task(send(writer, "Change the first node"))
            assert await asyncio.to_thread(writing.wait, 5)
            try:
                other = await send(reader, "Explain this flow")
                assert released is None, "The other conversation waited for the write"
                await assert_responsive(lambda: released is None)
            finally:
                proceed.set()
            return other, await edit

    other, edit = (json.loads(r.text.splitlines()[-1])["turn"] for r in asyncio.run(scenario()))
    assert other["status"] == "complete" and other["text"] == "Done."
    assert edit["status"] == "complete" and edit["tools"][0]["action"]["status"] == "applied"
    assert projects.snapshot(worktree["id"])["files"]["nodes/first.sql"] == changed


@pytest.mark.parametrize("failure", ["index_lock", "timeout"])
def test_failed_assistant_save_leaves_no_project_change_or_action(instance, monkeypatch, failure):
    app, client = instance
    worktree, context = seed(app, client)
    projects = app.state.services.projects
    before = projects.snapshot(worktree["id"])
    git = projects.git

    def timeout(path, *args, **options):
        if args[0] == "commit":
            raise GitTimeout
        return git(path, *args, **options)

    with monkeypatch.context() as fault:
        if failure == "index_lock":
            lock = Path(git(worktree["path"], "rev-parse", "--absolute-git-dir")) / "index.lock"
            lock.touch()
        else:
            fault.setattr(projects, "git", timeout)
        try:
            _, result = write_turn(
                app, client, context, [("write_sql", {"node": "first", "sql": SQL.replace("1", "2")})]
            )
        finally:
            if failure == "index_lock":
                lock.unlink()
    card = result["tools"][0]
    assert card["status"] == "error"
    assert "action" not in card
    after = projects.snapshot(worktree["id"])
    assert after["commit"] == before["commit"]
    assert after["files"] == before["files"]
    observe_after_quiet_period(projects, worktree)
    assert projects.snapshot(worktree["id"])["commit"] == before["commit"]


@pytest.mark.parametrize("reference", ["binding", "expression", "path", "view"])
def test_deleting_a_used_variable_is_refused_without_a_commit(instance, reference):
    from duckpad.assistant.tools import read_variables

    app, client = instance
    worktree, context = seed(app, client)

    def use(bundle):
        if reference == "view":
            bundle["views"] = {"first:result": [{"name": "North", "filter": "value = {{ var.region }}"}]}
            return
        parameter_type, value = {
            "binding": ("text", {"$var": "region"}),
            "expression": ("expression", "{{ var.region }} = 'North'"),
            "path": ("file", "orders/{{ var.region }}.csv"),
        }[reference]
        bundle["node_sql"]["nodes/first.sql"] = f"-- @param location: {parameter_type}\n" + SQL
        bundle["flow"]["nodes"][0]["params"]["location"] = value

    before = change(app, worktree, use)
    ctx = dependencies(app, client, context)
    usages = read_variables(ctx, "region", "usages")
    assert usages["total"] == 1
    if reference == "view":
        assert usages["items"][0]["view"] == "North"
    else:
        assert usages["items"][0]["node"] == "first"
    assert read_variables(ctx, "region")["items"][0]["usage_count"] == 1
    _, result = write_turn(app, client, context, [variable(operation="delete", name="region")])
    card = result["tools"][0]
    assert card["status"] == "error"
    assert "still in use" in card["summary"]
    assert "action" not in card
    after = app.state.services.projects.snapshot(worktree["id"])
    assert after["commit"] == before["commit"]
    assert after["files"] == before["files"]


def test_variable_environment_updates_preserve_other_values_and_can_restore_inheritance(instance):
    app, client = instance
    worktree, context = seed(app, client)
    change(
        app, worktree, lambda b: b["variables"]["region"].update(environments={"dev": "West", "prod": "East"})
    )
    calls = [
        variable(operation="update", name="region", definition={"environments": {"dev": "South"}}),
        variable(operation="update", name="region", remove_environments=["dev"]),
    ]
    identity, result = write_turn(app, client, context, calls)
    projects = app.state.services.projects
    assert all(t["status"] == "complete" for t in result["tools"])
    assert projects.snapshot(worktree["id"])["bundle"]["variables"]["region"] == {
        "type": "text",
        "default": "North",
        "environments": {"prod": "East"},
    }
    undo(client, identity, result, context, result["tools"][1]["id"])
    assert projects.snapshot(worktree["id"])["bundle"]["variables"]["region"]["environments"] == {
        "dev": "South",
        "prod": "East",
    }


def test_variable_can_switch_to_computed_and_back_without_running_its_source(instance):
    app, client = instance
    worktree, context = seed(app, client)
    calls = [
        variable(
            operation="update",
            name="region",
            remove_fields=["default", "environments"],
            definition={"type": "number", "from": {"node": "first", "port": "result", "column": "value"}},
        ),
    ]
    _, result = write_turn(app, client, context, calls)
    assert result["tools"][0]["status"] == "complete", result
    projects = app.state.services.projects
    assert (
        projects.snapshot(worktree["id"])["bundle"]["variables"]["region"]
        == calls[0][1]["change"]["definition"]
    )
    assert app.state.services.engine.pool.find(worktree["id"], "dev") is None
    _, result = write_turn(
        app,
        client,
        context,
        [variable(operation="update", name="region", remove_fields=["from"], definition={"default": 2})],
    )
    assert result["tools"][0]["status"] == "complete", result
    assert projects.snapshot(worktree["id"])["bundle"]["variables"]["region"] == {
        "type": "number",
        "default": 2,
    }


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"operation": "delete", "name": "missing"}, "Variable not found"),
        ({"operation": "rename", "name": "missing", "new_name": "area"}, "not found"),
        ({"operation": "create", "name": "region", "definition": {"type": "text"}}, "already exists"),
        ({"operation": "update", "name": "region", "definition": {"environments": {"dev": 42}}}, "invalid"),
    ],
)
def test_variable_edits_the_project_refuses_preserve_saved_files(instance, change, message):
    app, client = instance
    worktree, context = seed(app, client)
    before = app.state.services.projects.snapshot(worktree["id"])
    _, result = write_turn(app, client, context, [variable(**change)])
    assert result["tools"][0]["status"] == "error", result
    assert message in result["tools"][0]["summary"]
    assert "action" not in result["tools"][0]
    assert app.state.services.projects.snapshot(worktree["id"])["files"] == before["files"]


@pytest.mark.parametrize(
    ("change", "field"),
    [
        ({"operation": "delete", "name": "region", "definition": {"default": "South"}}, "definition"),
        (
            {"operation": "update", "name": "region"},
            "Provide definition, remove_fields or remove_environments",
        ),
        ({"operation": "update", "name": "region", "definition": {}}, "Provide definition"),
        ({"operation": "create", "name": "new", "definition": {}}, "definition"),
        ({"operation": "rename", "name": "region", "new_name": ""}, "new_name"),
        ({"operation": "move", "name": "region"}, "operation"),
        ({"operation": "delete", "name": ""}, "name"),
    ],
)
def test_rejected_variable_arguments_save_nothing(instance, change, field):
    app, client = instance
    worktree, context = seed(app, client)
    before = app.state.services.projects.snapshot(worktree["id"])
    _, result = write_turn(app, client, context, [variable(**change)])
    card = result["tools"][0]
    assert card["status"] == "error", result
    assert field in card["summary"]
    assert "action" not in card
    after = app.state.services.projects.snapshot(worktree["id"])
    assert after["commit"] == before["commit"]
    assert after["files"] == before["files"]


@pytest.mark.parametrize(
    ("args", "field"),
    [
        *[
            (flow({"operation": "add", "id": node_id, "template": "filter"}), "id")
            for node_id in EXISTING_NODE_IDS
        ],
        (flow({"operation": "add", "id": ""}), "id"),
        (flow({"operation": "update", "id": "", "label": "Renamed"}), "id"),
        (flow({"operation": "remove", "id": ""}), "id"),
        (flow({"operation": "add", "id": "added", "sql": SQL, "template": "filter"}), "Choose one of"),
        (flow({"operation": "add", "id": "added", "remove_parameters": ["x"]}), "remove_parameters"),
        (flow({"operation": "update", "id": "first", "sql": SQL}), "sql"),
        (flow({"operation": "update", "id": "first"}), "Provide label"),
        (flow({"operation": "update", "id": "first", "position": {"x": 1}}), "Field required"),
        (flow({"operation": "update", "id": "first", "position": {"x": float("nan"), "y": 0}}), "finite"),
        (flow({"operation": "remove", "id": "second", "label": "Gone"}), "label"),
        (flow({"operation": "move", "id": "first"}), "operation"),
        (flow(edges=[{"operation": "connect", "id": "link"}]), "source"),
        (flow(edges=[{"operation": "connect", "id": "link", "source": "first", "target": ""}]), "target"),
        (flow(edges=[{"operation": "disconnect", "id": "link", "source": "first"}]), "source"),
    ],
)
def test_rejected_flow_arguments_save_nothing(instance, args, field):
    app, client = instance
    worktree, context = seed(app, client)
    before = app.state.services.projects.snapshot(worktree["id"])
    _, result = write_turn(app, client, context, [args])
    card = result["tools"][0]
    assert card["status"] == "error", result
    assert field in card["summary"]
    assert "action" not in card
    after = app.state.services.projects.snapshot(worktree["id"])
    assert (after["commit"], after["files"]) == (before["commit"], before["files"])


# One (rejected call, corrected call) pair per tool validated by operation-specific models.
CORRECTIONS = [
    (
        variable(operation="delete", name="region", definition={"default": "South"}),
        variable(operation="update", name="region", definition={"default": "South"}),
    ),
    (
        chart(operation="create", node="first", output="result", name="Trend"),
        chart(operation="create", node="first", output="result", name="Trend", spec=BAR),
    ),
    (
        flow({"operation": "update", "id": "first", "sql": SQL}),
        flow({"operation": "update", "id": "first", "label": "Renamed"}),
    ),
    (
        documentation(section="nodes", node="first", output="result", text="Source"),
        documentation(section="nodes", node="first", text="Source"),
    ),
]


@pytest.mark.parametrize(("bad", "good"), CORRECTIONS)
def test_rejected_arguments_can_be_corrected_twice_in_a_row(instance, bad, good):
    app, client = instance
    worktree, context = seed(app, client)
    projects = app.state.services.projects
    before = projects.snapshot(worktree["id"])
    _, result = write_turn(app, client, context, [bad, bad, good])
    assert [t["status"] for t in result["tools"]] == ["error", "error", "complete"], result
    assert projects.git(worktree["path"], "rev-list", "--count", before["commit"] + "..HEAD") == "1"
    assert projects.snapshot(worktree["id"])["files"] != before["files"]


@pytest.mark.parametrize(("bad", "good"), CORRECTIONS)
def test_three_rejected_calls_in_a_row_end_the_turn_without_saving(instance, bad, good):
    app, client = instance
    worktree, context = seed(app, client)
    before = app.state.services.projects.snapshot(worktree["id"])
    identity = conversation(client, context)
    scripted(app, [bad, bad, bad, good])
    result = turn(client, identity, context, "Make the requested change")[-1]["turn"]
    assert result["status"] == "error", result
    # The call that exhausts the retries gets no result: the turn stops at it.
    assert [t["status"] for t in result["tools"]] == ["error", "error", "stopped"], result
    after = app.state.services.projects.snapshot(worktree["id"])
    assert (after["commit"], after["files"]) == (before["commit"], before["files"])


@pytest.mark.parametrize(("bad", "good"), CORRECTIONS)
def test_losing_edit_rights_after_a_rejected_call_aborts_the_turn(instance, bad, good):
    app, admin = instance
    _, context = seed(app, admin)
    user = app.state.auth.create_user("editor", "editor-password-123")
    app.state.access.member(context["project"], user["id"], "editor")
    projects = app.state.services.projects
    before = projects.snapshot(context["worktree"])
    with TestClient(app) as client:
        client.post("/api/login", json={"username": "editor", "password": "editor-password-123"})
        identity = conversation(client, context)

        def demote(index):
            if index == 1:
                app.state.access.member(context["project"], user["id"], "reader")

        scripted(app, [bad, good], before=demote)
        result = turn(client, identity, context, "Make the requested change")[-1]["turn"]
    assert result["status"] == "error", result
    assert "action" not in result["tools"][-1]
    after = projects.snapshot(context["worktree"])
    assert (after["commit"], after["files"]) == (before["commit"], before["files"])


def test_null_variable_arguments_count_as_omitted(instance):
    app, client = instance
    worktree, context = seed(app, client)
    calls = [
        variable(
            operation="update",
            name="region",
            definition={"default": "South"},
            new_name=None,
            remove_fields=None,
            remove_environments=None,
        ),
        variable(operation="rename", name="region", new_name="area", definition=None, remove_fields=None),
        variable(operation="delete", name="area", definition=None, new_name=None, remove_environments=None),
    ]
    _, result = write_turn(app, client, context, calls)
    assert [t["status"] for t in result["tools"]] == ["complete"] * 3, result
    assert app.state.services.projects.snapshot(worktree["id"])["bundle"]["variables"] == {}


def test_null_flow_arguments_count_as_omitted(instance):
    app, client = instance
    worktree, context = seed(app, client)
    calls = [
        (
            "edit_flow",
            {
                "nodes": [
                    {
                        "operation": "add",
                        "id": "added",
                        "label": None,
                        "position": None,
                        "params": None,
                        "template": None,
                        "component": None,
                        "sql": None,
                        "python": None,
                        "remove_parameters": None,
                    },
                    {"operation": "update", "id": "first", "label": "Renamed", "sql": None, "params": None},
                    {"operation": "remove", "id": "second", "label": None, "remove_parameters": None},
                ],
                "edges": None,
            },
        ),
        flow(
            {"operation": "add", "id": "consumer", "sql": CONSUMER, "template": None, "python": None},
            edges=[
                {
                    "operation": "connect",
                    "id": "link",
                    "source": "first",
                    "target": "consumer",
                    "source_port": None,
                    "target_port": None,
                },
            ],
        ),
    ]
    _, result = write_turn(app, client, context, calls)
    assert [t["status"] for t in result["tools"]] == ["complete"] * 2, result
    bundle = app.state.services.projects.snapshot(worktree["id"])["bundle"]
    assert [(n["id"], n.get("label")) for n in bundle["flow"]["nodes"]] == [
        ("first", "Renamed"),
        ("added", None),
        ("consumer", None),
    ]
    assert bundle["node_sql"]["nodes/added.sql"] == SQL
    assert [
        (e["source"], e["sourceHandle"], e["target"], e["targetHandle"]) for e in bundle["flow"]["edges"]
    ] == [("first", "result", "consumer", "input")]


@pytest.mark.parametrize(
    ("entry", "field"),
    [
        ({"section": "columns", "node": "first", "output": "result", "text": "An integer"}, "column"),
        ({"section": "columns", "node": "first", "output": "result", "column": "", "text": "X"}, "column"),
        ({"section": "datasets", "node": "first", "text": "Results"}, "output"),
        ({"section": "nodes", "node": "first", "column": "value", "text": "Source"}, "column"),
        ({"section": "project", "node": "first", "text": "Overview"}, "node"),
        ({"section": "variables", "text": "Overview"}, "section"),
    ],
)
def test_rejected_documentation_arguments_save_nothing(instance, entry, field):
    app, client = instance
    worktree, context = seed(app, client)
    before = app.state.services.projects.snapshot(worktree["id"])
    _, result = write_turn(app, client, context, [documentation(**entry)])
    card = result["tools"][0]
    assert card["status"] == "error", result
    assert field in card["summary"]
    assert "action" not in card
    after = app.state.services.projects.snapshot(worktree["id"])
    assert (after["commit"], after["files"]) == (before["commit"], before["files"])


def test_null_documentation_arguments_count_as_omitted(instance):
    app, client = instance
    worktree, context = seed(app, client)
    calls = [
        documentation(section="project", text="Overview", node=None, output=None, column=None),
        documentation(section="nodes", node="first", text="Source", output=None, column=None),
        documentation(section="datasets", node="first", output="result", text="Results", column=None),
    ]
    _, result = write_turn(app, client, context, calls)
    assert [t["status"] for t in result["tools"]] == ["complete"] * 3, result
    docs = app.state.services.projects.snapshot(worktree["id"])["bundle"]["documentation"]
    assert (docs["project"], docs["nodes"], docs["datasets"]) == (
        "Overview",
        {"first": "Source"},
        {"first:result": "Results"},
    )


def test_edges_connect_existing_nodes_whatever_their_id(instance):
    app, client = instance
    worktree, context = seed(app, client)

    def add_template_node(bundle):
        bundle["templates"]["filter"] = CONSUMER
        bundle["flow"]["nodes"].append({"id": "keep.rows", "params": {}, "template": "filter"})

    change(app, worktree, add_template_node)
    link = {"operation": "connect", "id": "link", "source": "first", "target": "keep.rows"}
    _, result = write_turn(app, client, context, [flow(edges=[link])])
    assert result["tools"][0]["status"] == "complete", result
    edges = app.state.services.projects.snapshot(worktree["id"])["bundle"]["flow"]["edges"]
    assert [(e["source"], e["target"]) for e in edges] == [("first", "keep.rows")]


def seed_existing_node(app, client, node_id, component):
    """A linked node between a source and another instance of the same template."""
    worktree, context = seed(app, client)

    def add_graph(bundle):
        bundle["templates"]["filter"] = (
            "-- @param minimum: number = 0\n-- @param maximum: number = 100\n"
            "-- @input input\n-- @output result\n"
            "SELECT * FROM {{ input }} WHERE value BETWEEN {{ minimum }} AND {{ maximum }};"
        )
        graph = bundle["flow"]
        if component:
            bundle["templates"]["constant"] = SQL
            graph = {"name": "Report", "nodes": [{"id": "first", "template": "constant"}], "edges": []}
            bundle["components"][component] = graph
            bundle["flow"]["nodes"].extend(
                {"id": name, "component": component} for name in ("summary", "other_summary")
            )
        graph["nodes"].extend(
            [
                {"id": node_id, "template": "filter", "params": {"minimum": 1, "maximum": 10}},
                {"id": "last", "template": "filter", "params": {}},
            ]
        )
        graph["edges"] = [
            {
                "id": name,
                "source": source,
                "target": target,
                "sourceHandle": "result",
                "targetHandle": "input",
            }
            for name, source, target in (("incoming", "first", node_id), ("outgoing", node_id, "last"))
        ]

    change(app, worktree, add_graph)
    return worktree, context


@pytest.mark.parametrize("node_id", EXISTING_NODE_IDS)
@pytest.mark.parametrize("component", ["", "report"])
@pytest.mark.parametrize("operation", ["update", "remove"])
def test_existing_node_edits_keep_shared_templates_and_support_undo(instance, node_id, component, operation):
    app, client = instance
    worktree, context = seed_existing_node(app, client, node_id, component)
    projects = app.state.services.projects
    before = projects.snapshot(worktree["id"])
    assert validate(before["bundle"]) == []
    edit = {"operation": operation, "id": node_id}
    edges = []
    if operation == "update":
        edit.update(
            label="Filtered rows",
            position={"x": 20, "y": 40},
            params={"minimum": 2},
            remove_parameters=["maximum"],
        )
    else:
        # Removing the middle node must clear both incident edges before reconnecting its consumer.
        edges = [{"operation": "connect", "id": "bypass", "source": "first", "target": "last"}]
    identity, result = write_turn(
        app, client, context, [("edit_flow", {"component": component, "nodes": [edit], "edges": edges})]
    )
    card = result["tools"][0]
    assert card["status"] == "complete", result
    assert card["action"]["status"] == "applied"
    assert card["action"]["before"] == before["commit"]
    after = projects.snapshot(worktree["id"])
    assert card["action"]["commit"] == after["commit"]
    assert projects.git(worktree["path"], "rev-list", "--count", before["commit"] + "..HEAD") == "1"
    bundle = after["bundle"]
    assert validate(bundle) == []
    assert bundle["templates"] == before["bundle"]["templates"]
    assert bundle["node_sql"] == before["bundle"]["node_sql"]
    graph = bundle["components"][component] if component else bundle["flow"]
    if component:
        assert bundle["flow"] == before["bundle"]["flow"]
    if operation == "update":
        assert next(n for n in graph["nodes"] if n["id"] == node_id) == {
            "id": node_id,
            "template": "filter",
            "label": "Filtered rows",
            "position": {"x": 20, "y": 40},
            "params": {"minimum": 2},
        }
        assert [e["id"] for e in graph["edges"]] == ["incoming", "outgoing"]
    else:
        assert node_id not in {n["id"] for n in graph["nodes"]}
        assert [(e["id"], e["source"], e["target"]) for e in graph["edges"]] == [("bypass", "first", "last")]
    assert next(n for n in graph["nodes"] if n["id"] == "last")["template"] == "filter"
    undone = undo(client, identity, result, context)
    assert undone["tools"][0]["action"]["status"] == "undone"
    assert projects.snapshot(worktree["id"])["files"] == before["files"]


@pytest.mark.parametrize("component", ["", "report"])
@pytest.mark.parametrize(
    ("edit", "message"),
    [
        ({"operation": "update", "id": "missing.node", "label": "Missing"}, "Node not found"),
        ({"operation": "remove", "id": "missing.node"}, "Node not found"),
        (
            {"operation": "update", "id": "keep.rows", "params": {"minimum": {"$var": "missing"}}},
            "diagnostics",
        ),
        ({"operation": "remove", "id": "keep.rows"}, "missing_input"),
    ],
)
def test_rejected_existing_node_edits_save_nothing(instance, component, edit, message):
    app, client = instance
    worktree, context = seed_existing_node(app, client, "keep.rows", component)
    projects = app.state.services.projects
    before = projects.snapshot(worktree["id"])
    _, result = write_turn(app, client, context, [("edit_flow", {"component": component, "nodes": [edit]})])
    card = result["tools"][0]
    assert card["status"] == "error", result
    assert message in card["summary"]
    assert "action" not in card
    after = projects.snapshot(worktree["id"])
    assert (after["commit"], after["files"]) == (before["commit"], before["files"])


CHART = {"operation", "node", "output", "name"}
NODE = {"operation", "id", "label", "position", "params"}


# One (tool, argument, operation fields) tuple per argument validated by operation-specific models.
@pytest.mark.parametrize(
    ("tool", "argument", "expected"),
    [
        (
            "edit_variable",
            "change",
            {
                "create": {"operation", "name", "definition"},
                "update": {"operation", "name", "definition", "remove_fields", "remove_environments"},
                "rename": {"operation", "name", "new_name"},
                "delete": {"operation", "name"},
            },
        ),
        (
            "edit_chart",
            "change",
            {
                "create": CHART | {"spec"},
                "update": CHART | {"spec"},
                "rename": CHART | {"new_name"},
                "delete": CHART,
            },
        ),
        (
            "edit_flow",
            "nodes",
            {
                "add": NODE | {"template", "component", "sql", "python"},
                "update": NODE | {"remove_parameters"},
                "remove": {"operation", "id"},
            },
        ),
        (
            "edit_flow",
            "edges",
            {
                "connect": {"operation", "id", "source", "target", "source_port", "target_port"},
                "disconnect": {"operation", "id"},
            },
        ),
        (
            "write_documentation",
            "entry",
            {
                "project": {"section", "text"},
                "nodes": {"section", "node", "text"},
                "datasets": {"section", "node", "output", "text"},
                "columns": {"section", "node", "output", "column", "text"},
            },
        ),
    ],
)
@pytest.mark.parametrize("kind", ["openai", "anthropic", "google", "mistral", "deepseek", "ollama", "custom"])
def test_every_provider_receives_each_operation_with_only_its_own_fields(
    instance, kind, tool, argument, expected
):
    from pydantic_ai import Tool
    from pydantic_ai.models import ModelRequestParameters

    app, _ = instance
    provider = {
        "kind": kind,
        "api_key": "test-key",
        "base_url": "http://localhost:1/v1" if kind == "custom" else "",
    }
    function = next(t for t in WRITE_TOOLS if t.__name__ == tool)

    async def render():
        async with app.state.assistant.configuration.model(provider, "test-model") as model:
            parameters = ModelRequestParameters(function_tools=[Tool(function).tool_def])
            return model.customize_request_parameters(parameters).function_tools[0].parameters_json_schema

    schema = asyncio.run(render())

    def variants(node):
        if "$ref" in node:
            return variants(schema["$defs"][node["$ref"].split("/")[-1]])
        if union := node.get("oneOf") or node.get("anyOf"):
            return [v for n in union for v in variants(n)]
        if "items" in node:
            return variants(node["items"])
        return [] if node.get("type") == "null" else [node]

    def operation(variant):
        tag = variant["properties"].get("operation") or variant["properties"]["section"]
        return tag.get("const") or tag["enum"][0]

    received = {
        operation(v): (set(v["properties"]), v.get("additionalProperties"))
        for v in variants(schema["properties"][argument])
    }
    assert received == {name: (fields, False) for name, fields in expected.items()}


def add_component_instance(app, worktree):
    """A Summary instance of a Report component, whose ranked output is its inner rank node's result."""

    def callback(bundle):
        bundle["components"]["report"] = {
            "name": "Report",
            "nodes": [{"id": "rank", "params": {}}],
            "edges": [],
            "outputs": {"ranked": {"node": "rank", "port": "result"}},
        }
        bundle["node_sql"]["components/report/rank.sql"] = SQL
        bundle["flow"]["nodes"].append({"id": "summary", "component": "report", "params": {}})

    change(app, worktree, callback)


def test_charts_are_created_under_the_stored_output_key_and_committed_one_by_one(instance):
    app, client = instance
    worktree, context = seed(app, client)
    add_component_instance(app, worktree)
    calls = [
        chart(operation="create", node="first", output="result", name="Values", spec=BAR),
        chart(operation="create", node="summary", output="ranked", name="Trend", spec=LINE),
    ]
    identity, result = write_turn(app, client, context, calls)
    assert [t["status"] for t in result["tools"]] == ["complete", "complete"], result
    projects = app.state.services.projects
    assert projects.snapshot(worktree["id"])["bundle"]["charts"] == {
        "first:result": [{"name": "Values", "spec": BAR}],
        "summary::rank:result": [{"name": "Trend", "spec": LINE}],
    }
    undo(client, identity, result, context, result["tools"][1]["id"])
    assert projects.snapshot(worktree["id"])["bundle"]["charts"] == {
        "first:result": [{"name": "Values", "spec": BAR}],
    }


@pytest.mark.parametrize(
    ("args", "message"),
    [
        ({"node": "missing", "output": "result", "name": "New", "spec": BAR}, "Node not found"),
        ({"node": "first", "output": "missing", "name": "New", "spec": BAR}, "Output port not found"),
        ({"node": "summary", "output": "result", "name": "New", "spec": BAR}, "Output port not found"),
        ({"node": "first", "output": "result", "name": "Values", "spec": BAR}, "already exists"),
        (
            {
                "node": "first",
                "output": "result",
                "name": "New",
                "spec": {"mark": "bar", "encoding": {"x": {"field": "value", "aggregate": "sum"}}},
            },
            "charts.json: chart New of first:result: encoding.x.aggregate is not allowed",
        ),
    ],
)
def test_invalid_chart_creations_preserve_saved_files(instance, args, message):
    app, client = instance
    worktree, context = seed(app, client)
    add_component_instance(app, worktree)
    change(app, worktree, lambda b: b.update(charts={"first:result": [{"name": "Values", "spec": BAR}]}))
    before = app.state.services.projects.snapshot(worktree["id"])
    _, result = write_turn(app, client, context, [chart(operation="create", **args)])
    assert result["tools"][0]["status"] == "error", result
    assert message in result["tools"][0]["summary"]
    assert app.state.services.projects.snapshot(worktree["id"])["files"] == before["files"]


AGGREGATE = {"mark": "bar", "encoding": {"x": {"field": "value", "aggregate": "sum"}}}


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (
            {"operation": "create", "name": "New", "spec": AGGREGATE},
            "chart New of first:result: encoding.x.aggregate",
        ),
        (
            {"operation": "update", "name": "Values", "spec": AGGREGATE},
            "chart Values of first:result: encoding.x.aggregate",
        ),
        ({"operation": "create", "name": " ", "spec": BAR}, "needs a name of 1 to 100 characters"),
        ({"operation": "rename", "name": "Values", "new_name": "x" * 101}, "needs a name of 1 to 100"),
    ],
)
def test_requested_charts_are_checked_even_when_another_chart_is_invalid(instance, args, message):
    app, client = instance
    worktree, context = seed(app, client)
    broken = {"name": "Broken", "spec": {"mark": "bar", "encoding": None}}
    change(
        app, worktree, lambda b: b.update(charts={"first:result": [broken, {"name": "Values", "spec": BAR}]})
    )
    before = app.state.services.projects.snapshot(worktree["id"])
    _, result = write_turn(app, client, context, [chart(node="first", output="result", **args)])
    assert result["tools"][0]["status"] == "error", result
    assert message in result["tools"][0]["summary"]
    after = app.state.services.projects.snapshot(worktree["id"])
    assert after["files"] == before["files"]
    assert after["commit"] == before["commit"]


def test_charts_can_be_edited_beside_an_existing_invalid_chart(instance):
    app, client = instance
    worktree, context = seed(app, client)
    broken = {"name": "Broken", "spec": {"mark": "bar", "encoding": None}}
    change(
        app, worktree, lambda b: b.update(charts={"first:result": [broken, {"name": "Values", "spec": BAR}]})
    )
    target = {"node": "first", "output": "result"}
    calls = [
        chart(operation="create", **target, name="New", spec=BAR),
        chart(operation="update", **target, name="Values", spec=LINE),
        chart(operation="rename", **target, name="Values", new_name="Totals"),
    ]
    _, result = write_turn(app, client, context, calls)
    assert [t["status"] for t in result["tools"]] == ["complete"] * 3, result


def test_chart_updates_replace_the_spec_renames_stay_on_the_output_and_last_deletes_drop_the_key(instance):
    app, client = instance
    worktree, context = seed(app, client)
    charts = {"first:result": [{"name": "Values", "spec": BAR}, {"name": "Trend", "spec": BAR}]}
    change(
        app, worktree, lambda b: b.update(charts={**charts, "second:result": [{"name": "Only", "spec": BAR}]})
    )
    target = {"node": "first", "output": "result"}
    calls = [
        chart(operation="update", **target, name="Values", spec=LINE),
        # Null arguments of other operations count as omitted.
        chart(operation="rename", **target, name="Values", new_name="Lines", spec=None),
        chart(operation="delete", **target, name="Trend", new_name=None),
        chart(operation="delete", node="second", output="result", name="Only"),
    ]
    _, result = write_turn(app, client, context, calls)
    assert [t["status"] for t in result["tools"]] == ["complete"] * 4, result
    assert app.state.services.projects.snapshot(worktree["id"])["bundle"]["charts"] == {
        "first:result": [{"name": "Lines", "spec": LINE}],
    }


@pytest.mark.parametrize(
    ("args", "message"),
    [
        ({"operation": "update", "name": "Missing", "spec": LINE}, "Chart not found"),
        ({"operation": "rename", "name": "Missing", "new_name": "Lines"}, "Chart not found"),
        ({"operation": "rename", "name": "Values", "new_name": "Trend"}, "already exists"),
        ({"operation": "delete", "name": "Missing"}, "Chart not found"),
    ],
)
def test_invalid_chart_changes_preserve_saved_files(instance, args, message):
    app, client = instance
    worktree, context = seed(app, client)
    charts = {"first:result": [{"name": "Values", "spec": BAR}, {"name": "Trend", "spec": BAR}]}
    change(app, worktree, lambda b: b.update(charts=charts))
    before = app.state.services.projects.snapshot(worktree["id"])
    target = {"node": "first", "output": "result"}
    _, result = write_turn(app, client, context, [chart(**target, **args)])
    assert result["tools"][0]["status"] == "error", result
    assert message in result["tools"][0]["summary"]
    assert app.state.services.projects.snapshot(worktree["id"])["files"] == before["files"]


@pytest.mark.parametrize(
    ("args", "field"),
    [
        ({"operation": "create", "name": "New"}, "spec"),
        ({"operation": "update", "name": "Values"}, "spec"),
        ({"operation": "rename", "name": "Values"}, "new_name"),
        ({"operation": "rename", "name": "Values", "new_name": ""}, "new_name"),
        ({"operation": "rename", "name": "Values", "new_name": "Lines", "spec": LINE}, "spec"),
        ({"operation": "delete", "name": "Values", "spec": LINE}, "spec"),
        ({"operation": "create", "name": "Lines", "spec": LINE, "new_name": "Other"}, "new_name"),
        ({"operation": "update", "name": "Values", "spec": LINE, "new_name": "Lines"}, "new_name"),
        ({"operation": "delete", "name": "Values", "new_name": "Lines"}, "new_name"),
        ({"operation": "create", "name": "", "spec": LINE}, "name"),
        ({"operation": "move", "name": "Values"}, "operation"),
    ],
)
def test_rejected_chart_arguments_save_nothing(instance, args, field):
    app, client = instance
    worktree, context = seed(app, client)
    change(app, worktree, lambda b: b.update(charts={"first:result": [{"name": "Values", "spec": BAR}]}))
    before = app.state.services.projects.snapshot(worktree["id"])
    _, result = write_turn(app, client, context, [chart(node="first", output="result", **args)])
    card = result["tools"][0]
    assert card["status"] == "error", result
    assert field in card["summary"]
    assert "action" not in card
    after = app.state.services.projects.snapshot(worktree["id"])
    assert (after["commit"], after["files"]) == (before["commit"], before["files"])


def test_saved_charts_report_fields_the_materialized_output_lacks(instance):
    from helpers import join_run

    app, client = instance
    worktree, context = seed(app, client)
    misspelled = {
        "mark": "bar",
        "encoding": {"x": {"field": "value"}, "y": {"field": "vaule"}},
        "layer": [{"mark": "rule", "encoding": {"tooltip": [{"field": "value"}, {"field": "missing"}]}}],
    }

    def save(operation, name, spec):
        args = {"operation": operation, "node": "first", "output": "result", "name": name, "spec": spec}
        _, result = write_turn(app, client, context, [chart(**args)])
        assert result["tools"][0]["status"] == "complete", result
        return json.loads(result["tools"][0]["summary"])

    assert "unknown_fields" not in save("create", "Before the run", misspelled)
    run = app.state.services.engine.launch(worktree["id"], "dev")
    assert join_run(app.state.services.store, run["id"])["status"] == "success"
    assert save("create", "Misspelled", misspelled)["unknown_fields"] == ["vaule", "missing"]
    assert "unknown_fields" not in save("create", "Correct", BAR)
    retyped = {"mark": "line", "encoding": {"y": {"field": "valeu", "type": "quantitative"}}}
    assert save("update", "Correct", retyped)["unknown_fields"] == ["valeu"]
    names = [
        c["name"]
        for c in app.state.services.projects.snapshot(worktree["id"])["bundle"]["charts"]["first:result"]
    ]
    assert names == ["Before the run", "Misspelled", "Correct"]


def test_chart_field_warnings_ignore_flow_errors_elsewhere_in_the_project(instance):
    from helpers import join_run

    app, client = instance
    worktree, context = seed(app, client)
    run = app.state.services.engine.launch(worktree["id"], "dev")
    assert join_run(app.state.services.store, run["id"])["status"] == "success"
    change(
        app,
        worktree,
        lambda b: b["flow"]["nodes"].append({"id": "broken", "component": "gone", "params": {}}),
    )
    misspelled = {"mark": "bar", "encoding": {"x": {"field": "vaule"}}}
    args = {"operation": "create", "node": "first", "output": "result", "name": "Typo", "spec": misspelled}
    _, result = write_turn(app, client, context, [chart(**args)])
    assert result["tools"][0]["status"] == "complete", result
    assert json.loads(result["tools"][0]["summary"])["unknown_fields"] == ["vaule"]


def test_editors_are_told_charts_are_vega_lite_even_without_data_reading(instance):
    app, client = instance
    _, context = seed(app, client)
    configure(client, allow_data=False)
    app.state.assistant.configuration.model_override = TestModel(call_tools=[], custom_output_text="Ready")
    turn(client, conversation(client, context), context)
    available = app.state.assistant.configuration.model_override.last_model_request_parameters.function_tools
    tool = next(t for t in available if t.name == "edit_chart")
    models = tool.parameters_json_schema["$defs"]
    for model in ("CreateChart", "UpdateChart"):
        spec = models[model]["properties"]["spec"]
        assert spec["description"] == "Vega-Lite 6 spec within Duckpad's chart allowlist"
    for promise in ("Vega-Lite 6", '"data": {"name": "data"}', "5,000 rows", "charts.json", "read_guide"):
        assert promise in (tool.description or "")


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
        for edit in (
            AddNode(operation="add", id="forbidden"),
            UpdateNode(operation="update", id="keep.rows", label="Forbidden"),
            RemoveNode(operation="remove", id="keep.rows"),
        ):
            with pytest.raises(Problem, match="role does not allow"):
                edit_flow(dependencies(app, reader, context), [edit])
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


def test_job_results_offer_no_write_or_run_tools_to_project_admins(instance):
    app, admin = instance
    worktree, context = seed(app, admin)
    projects = app.state.services.projects
    projects.versioning.create_tag(
        worktree["id"], "v1", projects.snapshot(worktree["id"])["commit"], "Accepted"
    )
    response = admin.post(
        f"/api/projects/{worktree['project']}/jobs",
        json={"slug": "daily", "name": "Daily", "environment": "dev", "target": {"kind": "tag", "ref": "v1"}},
    )
    assert response.status_code == 201, response.text
    job = response.json()["worktree"]
    context = {**context, "worktree": job, "branch": projects.get(job)["branch"]}
    app.state.assistant.configuration.model_override = TestModel(
        call_tools=[], custom_output_text="Read only"
    )
    turn(admin, conversation(admin, context), context)
    available = app.state.assistant.configuration.model_override.last_model_request_parameters.function_tools
    assert {t.name for t in available}.isdisjoint(t.__name__ for t in [*WRITE_TOOLS, *RUN_TOOLS])


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


def test_forward_conflict_never_overwrites(instance):
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
    assert result["tools"][0]["status"] == "error"
    endpoint = f"/api/conflicts/{action['conflict']}/resolve"
    from pydantic_ai import CancellationToken

    app.state.assistant.active[identity] = CancellationToken()
    response = client.post(endpoint, json={"choice": "proposal"})
    assert response.status_code == 409 and "Wait for the assistant response" in response.text
    app.state.assistant.active.clear()
    # An edit made outside Duckpad meanwhile is committed on its own, before the resolution.
    (Path(worktree["path"]) / "nodes/second.sql").write_text(SQL.replace("1", "6"))
    # The first attempt refreshes the conflict with that edit.
    assert client.post(endpoint, json={"choice": "proposal"}).status_code == 409
    assert client.post(endpoint, json={"choice": "proposal"}).status_code == 200
    saved = client.get(f"/api/assistant/conversations/{identity}").json()["turns"][0]
    assert saved["tools"][0]["action"]["status"] == "applied"
    assert [c["id"] for c in saved["tools"][0]["action"]["changes"]] == ["node/first"]
    undo(client, identity, saved, context)
    projects = app.state.services.projects
    assert projects.snapshot(worktree["id"])["files"]["nodes/first.sql"] == SQL.replace("1", "5")
    assert projects.snapshot(worktree["id"])["files"]["nodes/second.sql"] == SQL.replace("1", "6")


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
    diagnostics = json.loads(invalid["tools"][0]["summary"])["diagnostics"]
    assert [(d["node"], d["code"], d["port"]) for d in diagnostics] == [("other", "missing_input", "source")]
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
            variable(operation="rename", name="region", new_name="area"),
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
            resumed.post(
                "/api/login", json={"username": "admin", "password": app.state.auth.initial_password}
            ).status_code
            == 200
        )
        saved = resumed.get(f"/api/assistant/conversations/{identity}").json()["turns"][0]
        updated = undo(resumed, identity, saved, context)
        assert all(t["action"]["status"] == "undone" for t in updated["tools"])
        assert restarted.state.services.projects.snapshot(worktree["id"])["files"]["nodes/first.sql"] == SQL


def test_assistant_saves_resolve_dependencies_outside_the_repository_lock(instance, monkeypatch):
    app, client = instance
    _, context = seed(app, client)
    projects = app.state.services.projects
    resolve, held = projects._locked_dependencies, []

    def probe(record, proposal):
        # `uv lock` can run here for minutes: the project's other saves must not wait for it.
        lock, acquired = projects.repository(record["project"]), []

        def other_save():
            acquired.append(lock.acquire(timeout=1))
            if acquired[0]:
                lock.release()

        thread = threading.Thread(target=other_save)
        thread.start()
        thread.join()
        held.append(not acquired[0])
        return resolve(record, proposal)

    monkeypatch.setattr(projects, "_locked_dependencies", probe)
    identity, result = write_turn(
        app, client, context, [("write_sql", {"node": "first", "sql": SQL.replace("1", "2")})]
    )
    assert result["tools"][0]["action"]["status"] == "applied"
    assert undo(client, identity, result, context)["tools"][0]["action"]["status"] == "undone"
    assert held and not any(held)
