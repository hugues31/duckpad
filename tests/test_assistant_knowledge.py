"""Product guidance and variable discovery through the actual assistant tool boundary."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from test_assistant import configure, conversation, dependencies, project, turn
from test_assistant import instance as instance
from test_assistant_editing import change, seed

from duckpad.assistant.arguments import DeleteVariable
from duckpad.assistant.editing import edit_variable
from duckpad.assistant.knowledge import GUIDES, checkout_guides, guide_text, read_guide
from duckpad.assistant.registry import TOOLS
from duckpad.assistant.service import guarded
from duckpad.assistant.tools import read_variables
from duckpad.util import Problem

READING = {name for name, spec in TOOLS.items() if spec.needs == "read"}


def test_manual_is_available_without_a_project_and_instructions_reach_each_turn(instance):
    app, client = instance
    configure(client, allow_data=False)
    context = {"page": "projects"}
    identity = conversation(client)
    received = []

    async def stream(messages, info):
        received.append(info.instructions)
        # No branch is open: every reading tool is offered, none that returns values or edits.
        assert {t.name for t in info.function_tools} == READING
        if not any(isinstance(p, ToolReturnPart) for p in messages[-1].parts):
            yield {0: DeltaToolCall(name="read_guide", json_args='{"topic":"sql"}', tool_call_id="manual")}
        else:
            result = next(p.content for p in messages[-1].parts if isinstance(p, ToolReturnPart))
            assert result["source"] == "docs/SQL.md"
            yield "Declare a typed parameter with -- @param and reference it with {{ name }}."

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=stream)
    for question in ("What is @param?", "How do I use its value?"):
        result = turn(client, identity, context, question)[-1]["turn"]
        assert result["status"] == "complete", result
        assert result["tools"][0]["name"] == "read_guide"
    assert all("@param minimum: number = 0" in instructions for instructions in received)
    assert all('"$var":"minimum"' in instructions for instructions in received)
    charts = (
        "Charts in charts.json are Vega-Lite 6 specs on node outputs; they draw at most 5,000 rows, "
        "so aggregate in SQL before charting."
    )
    assert all(charts in " ".join((instructions or "").split()) for instructions in received)


def test_every_docs_guide_is_a_complete_paginated_topic(instance):
    app, client = instance
    configure(client)
    _, context = project(client)
    ctx = dependencies(app, client, context)
    docs = Path(__file__).parents[1] / "docs"
    assert set(GUIDES) == {path.stem.lower() for path in docs.glob("*.md")}
    for topic in GUIDES:
        content, offset = "", 0
        while offset is not None:
            result = read_guide(ctx, topic, offset)
            assert len(result["text"]) <= 12000
            content += result["text"]
            offset = result["next_offset"]
        assert content == (docs / result["source"].removeprefix("docs/")).read_text(encoding="utf-8")


def test_guides_cannot_read_arbitrary_paths_or_be_replaced_by_project_text(instance):
    app, client = instance
    worktree, context = seed(app, client)
    change(
        app, worktree, lambda b: b["documentation"].update(project="Made-up syntax: @param is unsupported.")
    )
    ctx = dependencies(app, client, context)
    assert "Made-up syntax" not in read_guide(ctx, "sql")["text"]
    for topic in ("../../README", "../variables", "README", "/etc/passwd"):
        with pytest.raises(Problem, match="Unknown Duckpad guide"):
            guide_text(topic)
    configure(client, enabled=False)
    with pytest.raises(Problem, match="settings changed"):
        read_guide(ctx, "sql")


def test_reader_can_page_variable_usages_but_cannot_delete(instance):
    app, admin = instance
    worktree, context = seed(app, admin)

    def populate(bundle):
        for node in bundle["flow"]["nodes"]:
            node["params"]["region"] = {"$var": "region"}
            bundle["node_sql"][f"nodes/{node['id']}.sql"] = (
                "-- @param region: text\n-- @output result\nSELECT {{ region }} AS region;"
            )
        bundle["views"] = {"first:result": [{"name": "Regional", "filter": "region = {{ var.region }}"}]}

    change(app, worktree, populate)
    user = app.state.auth.create_user("reader", "reader-password-123")
    app.state.access.member(worktree["project"], user["id"], "reader")
    with TestClient(app) as reader:
        reader.post("/api/login", json={"username": "reader", "password": "reader-password-123"})
        ctx = dependencies(app, reader, context)
        declaration = read_variables(ctx, "region")["items"][0]
        assert declaration["usage_count"] == 3
        assert declaration["values"]["dev"] == {"value": "North", "source": "default"}
        found = []
        for offset in range(3):
            result = read_variables(ctx, "region", "usages", offset, 1)
            assert result["total"] == 3
            assert result["next_offset"] == (offset + 1 if offset < 2 else None)
            found += result["items"]
        assert [u.get("node", u.get("view")) for u in found] == ["first", "second", "Regional"]
        with pytest.raises(Problem, match="role does not allow"):
            edit_variable(ctx, DeleteVariable(operation="delete", name="region"))
        app.state.access.member(worktree["project"], user["id"], None)
        with pytest.raises(Problem):
            read_variables(ctx, "region")


def test_variable_inspection_redacts_secrets_and_never_reads_computed_values(instance):
    app, client = instance
    worktree, context = seed(app, client)
    change(
        app,
        worktree,
        lambda b: b["variables"].update(
            {
                "region": {"type": "text", "default": "private-test-key"},
                "computed": {"type": "number", "from": {"node": "first", "column": "value"}},
            }
        ),
    )
    configure(client, allow_data=False)
    # Tool results reach the model through the wrapper, which redacts them.
    result = guarded(read_variables)(dependencies(app, client, context))
    assert "private-test-key" not in json.dumps(result)
    assert "[redacted]" in json.dumps(result)
    computed = next(v for v in result["items"] if v["name"] == "computed")
    assert "value" not in computed["values"]["dev"]
    assert app.state.services.engine.pool.find(worktree["id"], "dev") is None


def test_git_ignored_docs_are_not_guides(tmp_path):
    import subprocess

    def git(*args):
        subprocess.run(["git", "-C", str(tmp_path), *args], check=True, capture_output=True)

    git("init", "-q")
    (tmp_path / "docs").mkdir()
    for name in ("sql.md", "MULTICA.md", "notes.md"):
        (tmp_path / "docs" / name).write_text("# Guide\n")
    (tmp_path / ".gitignore").write_text("/docs/MULTICA.md\n/docs/notes.md\n")
    # An operator's checkout may even track an ignored file, as the build hook ignores it anyway.
    git("add", "-f", "docs/MULTICA.md")
    assert sorted(checkout_guides(tmp_path)) == ["sql"]
    (tmp_path / ".gitignore").unlink()
    assert sorted(checkout_guides(tmp_path)) == ["multica", "notes", "sql"]
