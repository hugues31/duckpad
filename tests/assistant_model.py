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
    if info.function_tools and not any(isinstance(p, ToolReturnPart) for p in messages[-1].parts):
        name, args = edit or ("read_flow", {"section": "nodes"})
        yield {0: DeltaToolCall(name=name, json_args=json.dumps(args), tool_call_id="tool-call")}
    elif edit and edit[0] in ("launch_run", "inspect_run"):
        yield json.dumps([p.content for p in messages[-1].parts if isinstance(p, ToolReturnPart)])
    elif edit:
        yield "The requested change is saved."
    else:
        yield "The flow contains "
        yield "read-only project nodes.\n\n```sql\nSELECT 1;\n```"


def test_model():
    return FunctionModel(reply, stream_function=stream)
