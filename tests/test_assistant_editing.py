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

from duckpad.assistant.editing import WRITE_TOOLS, NodeEdit, edit_flow
from duckpad.assistant.runs import RUN_TOOLS
from duckpad.bundle import bundle_to_files
from duckpad.git.command import GitTimeout
from duckpad.util import Problem

SQL = "-- @output result\nSELECT 1 AS value;\n"
BAR = {"mark": "bar", "encoding": {"x": {"field": "value", "type": "quantitative"}}}
LINE = {"mark": "line", "encoding": {"y": {"field": "value", "type": "quantitative"}}}


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
        variable(operation="create", name="limit", definition={"type": "number", "default": 5}),
        variable(operation="update", name="region", definition={"default": "South"}),
        variable(operation="rename", name="region", new_name="area"),
        variable(operation="delete", name="region"),
        variable(operation="update", name="region", remove_fields=["default"]),
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
        (
            {"operation": "update", "name": "missing", "definition": {"default": "South"}},
            "Variable not found",
        ),
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
        ({"operation": "rename", "name": "region", "new_name": "area", "definition": {}}, "definition"),
        (
            {
                "operation": "create",
                "name": "new",
                "definition": {"type": "text"},
                "remove_fields": ["default"],
            },
            "remove_fields",
        ),
        (
            {"operation": "update", "name": "region", "new_name": "area", "definition": {"default": "South"}},
            "new_name",
        ),
        ({"operation": "delete", "name": "region", "new_name": "area"}, "new_name"),
        (
            {"operation": "update", "name": "region"},
            "Provide definition, remove_fields or remove_environments",
        ),
        ({"operation": "update", "name": "region", "definition": {}}, "Provide definition"),
        ({"operation": "create", "name": "new", "definition": {}}, "definition"),
        ({"operation": "create", "name": "new"}, "definition"),
        ({"operation": "rename", "name": "region", "new_name": ""}, "new_name"),
        ({"operation": "rename", "name": "region"}, "new_name"),
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


def test_rejected_variable_arguments_can_be_corrected_twice_in_a_row(instance):
    app, client = instance
    worktree, context = seed(app, client)
    projects = app.state.services.projects
    before = projects.snapshot(worktree["id"])
    bad = variable(operation="delete", name="region", definition={"default": "South"})
    good = variable(operation="update", name="region", definition={"default": "South"})
    _, result = write_turn(app, client, context, [bad, bad, good])
    assert [t["status"] for t in result["tools"]] == ["error", "error", "complete"], result
    assert projects.git(worktree["path"], "rev-list", "--count", before["commit"] + "..HEAD") == "1"
    assert projects.snapshot(worktree["id"])["bundle"]["variables"]["region"]["default"] == "South"


def test_three_rejected_variable_calls_in_a_row_end_the_turn_without_saving(instance):
    app, client = instance
    worktree, context = seed(app, client)
    before = app.state.services.projects.snapshot(worktree["id"])
    identity = conversation(client, context)
    bad = variable(operation="rename", name="region", new_name="")
    scripted(app, [bad, bad, bad, variable(operation="delete", name="region")])
    result = turn(client, identity, context, "Make the requested change")[-1]["turn"]
    assert result["status"] == "error", result
    # The call that exhausts the retries gets no result: the turn stops at it.
    assert [t["status"] for t in result["tools"]] == ["error", "error", "stopped"], result
    after = app.state.services.projects.snapshot(worktree["id"])
    assert (after["commit"], after["files"]) == (before["commit"], before["files"])


def test_losing_edit_rights_after_a_rejected_call_aborts_the_turn(instance):
    app, admin = instance
    configure(admin)
    _, context = project(admin)
    user = app.state.auth.create_user("editor", "editor-password-123")
    app.state.access.member(context["project"], user["id"], "editor")
    projects = app.state.services.projects
    before = projects.snapshot(context["worktree"])
    with TestClient(app) as client:
        client.post("/api/login", json={"username": "editor", "password": "editor-password-123"})
        identity = conversation(client, context)
        calls = [
            variable(operation="create", name="limit"),
            variable(operation="create", name="limit", definition={"type": "number", "default": 5}),
        ]

        def demote(index):
            if index == 1:
                app.state.access.member(context["project"], user["id"], "reader")

        scripted(app, calls, before=demote)
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


def test_conversations_with_flat_variable_calls_from_before_continue(instance):
    app, client = instance
    _, context = seed(app, client)
    identity, _ = write_turn(app, client, context, [variable(operation="delete", name="region")])
    store = app.state.services.store
    record = store.get("assistant_conversation", identity)
    flat = {"operation": "delete", "name": "region"}
    for message in record["messages"]:
        for part in message["parts"]:
            if part["part_kind"] == "tool-call" and part["tool_name"] == "edit_variable":
                part["args"] = json.dumps(flat)
    store.put("assistant_conversation", identity, record)
    replayed = []

    async def stream(messages, info):
        replayed.extend(
            p.args_as_dict()
            for m in messages
            for p in m.parts
            if p.part_kind == "tool-call" and p.tool_name == "edit_variable"
        )
        yield "Nothing else to change."

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=stream)
    result = turn(client, identity, context, "Anything else?")[-1]["turn"]
    assert result["status"] == "complete", result
    assert replayed == [flat]


@pytest.mark.parametrize("kind", ["openai", "anthropic", "google", "mistral", "deepseek", "ollama", "custom"])
def test_every_provider_receives_the_four_variable_and_chart_operations(instance, kind):
    from pydantic_ai import Tool
    from pydantic_ai.models import ModelRequestParameters

    from duckpad.assistant.editing import edit_chart, edit_variable

    app, _ = instance
    provider = {
        "kind": kind,
        "api_key": "test-key",
        "base_url": "http://localhost:1/v1" if kind == "custom" else "",
    }

    async def render():
        async with app.state.assistant.configuration.model(provider, "test-model") as model:
            tools = [Tool(edit_variable).tool_def, Tool(edit_chart).tool_def]
            parameters = ModelRequestParameters(function_tools=tools)
            return [
                t.parameters_json_schema
                for t in model.customize_request_parameters(parameters).function_tools
            ]

    def operations(schema):
        union = schema["properties"]["change"]
        variants = [
            schema["$defs"][v["$ref"].split("/")[-1]] if "$ref" in v else v
            for v in union.get("oneOf") or union.get("anyOf")
        ]
        return {
            (v["properties"]["operation"].get("const") or v["properties"]["operation"]["enum"][0]): (
                set(v["properties"]),
                v.get("additionalProperties"),
            )
            for v in variants
        }

    variable, chart = asyncio.run(render())
    assert operations(variable) == {
        "create": ({"operation", "name", "definition"}, False),
        "update": ({"operation", "name", "definition", "remove_fields", "remove_environments"}, False),
        "rename": ({"operation", "name", "new_name"}, False),
        "delete": ({"operation", "name"}, False),
    }
    target = {"operation", "node", "output", "name"}
    assert operations(chart) == {
        "create": (target | {"spec"}, False),
        "update": (target | {"spec"}, False),
        "rename": (target | {"new_name"}, False),
        "delete": (target, False),
    }


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
        {
            "file": "flow.json",
            "node": "other",
            "code": "missing_input",
            "port": "source",
            "message": "Connect input 'source' on Filter",
        }
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
            resumed.post("/api/login", json={"password": app.state.auth.initial_password}).status_code == 200
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
