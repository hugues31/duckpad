"""A deterministic model injected by tests, never selected by production configuration."""

import json
import re

from pydantic_ai.messages import ModelResponse, TextPart, ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel


def reply(messages, info):
    return ModelResponse(parts=[TextPart("OK")])


async def stream(messages, info):
    prompt = next(
        (p.content for m in reversed(messages) for p in m.parts if isinstance(p, UserPromptPart)), ""
    )
    named = (
        re.search(r"Which nodes does the project (.+) contain\?", prompt) if isinstance(prompt, str) else None
    )
    if named:
        # Find the named project, then read its main branch from whatever page is open.
        returns = [p for p in messages[-1].parts if isinstance(p, ToolReturnPart)]
        if not returns:
            yield {0: DeltaToolCall(name="list_projects", json_args="{}", tool_call_id="list-projects")}
        elif returns[0].tool_name == "list_projects":
            found = next(p for p in returns[0].content["items"] if p["name"] == named[1])
            arguments = {"section": "nodes", "worktree": found["branches"][0]["worktree"]}
            yield {
                0: DeltaToolCall(name="read_flow", json_args=json.dumps(arguments), tool_call_id="read-flow")
            }
        else:
            yield "Its nodes: " + ", ".join(node["id"] for node in returns[0].content["items"])
        return
    edit = None
    if isinstance(prompt, str) and "Run only node debug_source" in prompt:
        edit = ("launch_run", {"environment": "dev", "node": "debug_source"})
    elif isinstance(prompt, str) and "Help me debug this error" in prompt:
        match = re.search(r"Run: (run_[^. ]+)", prompt)
        if match:
            edit = ("inspect_run", {"run": match[1], "node": "debug_source"})
    if isinstance(prompt, str) and "ID assistant_source" in prompt:
        edit = (
            "edit_flow",
            {
                "nodes": [
                    {
                        "operation": "add",
                        "id": "assistant_source",
                        "label": "Assistant source",
                        "position": {"x": 100, "y": 600},
                        "sql": "-- @output result\nSELECT 1 AS value;\n",
                    }
                ]
            },
        )
    elif isinstance(prompt, str) and "editable_source to SELECT 2" in prompt:
        edit = ("write_sql", {"node": "editable_source", "sql": "-- @output result\nSELECT 2 AS value;\n"})
    elif isinstance(prompt, str) and "Explain Duckpad's @param" in prompt:
        edit = ("read_guide", {"topic": "sql"})
    elif isinstance(prompt, str) and "Delete the project variable obsolete" in prompt:
        edit = ("edit_variable", {"change": {"operation": "delete", "name": "obsolete"}})
    elif isinstance(prompt, str) and "Delete the project variable minimum" in prompt:
        edit = ("edit_variable", {"change": {"operation": "delete", "name": "minimum"}})
    elif isinstance(prompt, str) and "Remove only the dev environment override" in prompt:
        edit = (
            "edit_variable",
            {"change": {"operation": "update", "name": "minimum", "remove_environments": ["dev"]}},
        )
    if info.function_tools and not any(isinstance(p, ToolReturnPart) for p in messages[-1].parts):
        # Without an open branch, the page context names no worktree to read.
        name, args = edit or (
            ("read_guide", {"topic": "assistant"})
            if '"worktree": ""' in (info.instructions or "")
            else ("read_flow", {"section": "nodes"})
        )
        yield {0: DeltaToolCall(name=name, json_args=json.dumps(args), tool_call_id="tool-call")}
    elif edit and edit[0] == "read_guide":
        yield "Use -- @param minimum: number = 0, then SELECT {{ minimum }} AS value in an output block."
    elif edit and edit[0] in ("launch_run", "inspect_run", "edit_variable"):
        yield json.dumps([p.content for p in messages[-1].parts if isinstance(p, ToolReturnPart)])
    elif edit:
        yield "The requested change is saved."
    else:
        yield "The flow contains "
        yield "read-only project nodes.\n\n```sql\nSELECT 1;\n```"


def test_model():
    return FunctionModel(reply, stream_function=stream)
