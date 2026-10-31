"""A deterministic model injected by tests, never selected by production configuration."""

from pydantic_ai.messages import ModelResponse, TextPart, ToolReturnPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel


def reply(messages, info):
    return ModelResponse(parts=[TextPart("OK")])


async def stream(messages, info):
    if info.function_tools and not any(isinstance(p, ToolReturnPart) for p in messages[-1].parts):
        yield {0: DeltaToolCall(name="read_flow", json_args='{"section":"nodes"}', tool_call_id="read-flow")}
    else:
        yield "The flow contains "
        yield "read-only project nodes.\n\n```sql\nSELECT 1;\n```"


def test_model():
    return FunctionModel(reply, stream_function=stream)
