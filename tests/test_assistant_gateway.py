"""Exercise the real SDK against an OAuth2 gateway with buffered or JSON replies."""

import asyncio
import base64
import json
from urllib.parse import parse_qs, quote_plus

import httpx2
import pytest
from pydantic_ai import models
from pydantic_ai.models.function import FunctionModel
from test_assistant import configure, conversation, dependencies, project, turn
from test_assistant import instance as instance
from test_assistant_runs import decide, final

from duckpad.assistant import gateway
from duckpad.assistant.config import ProviderSettings, provider_error
from duckpad.assistant.gateway import TURN_TIMEOUT

SECRET = "gateway-secret:+ café"
PROVIDER = {
    "id": "primary",
    "kind": "custom",
    "base_url": "https://gateway.example.invalid/v1",
    "auth": "oauth2",
    "token_url": "https://auth.example.invalid/token",
    "client_id": "client:+ café",
    "client_secret": SECRET,
    "scope": "chat models",
    "streaming": False,
    "models": ["test"],
}


@pytest.mark.parametrize("finish", [None, "length", "content_filter"])
def test_split_text_choices_keep_order_and_finish_reason(finish):
    from openai.types.chat import ChatCompletion
    from pydantic_ai.providers.openai import OpenAIProvider

    model = gateway.GatewayChatModel("test", provider=OpenAIProvider(api_key="test-key"))
    data = {
        "id": "response-text",
        "object": "chat.completion",
        "created": 1700000000,
        "model": "test",
        "choices": [
            {
                "index": 1,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "Second."}]},
                "finish_reason": None,
            },
            {"index": 0, "message": {"role": "assistant", "content": "First."}, "finish_reason": None},
            # Pydantic AI defaults only the first listed choice to "stop" before validation.
            {"index": 2, "message": {"role": "assistant", "content": "Third."}, "finish_reason": finish},
        ],
    }
    response = model._process_response(ChatCompletion.model_construct(**data))
    assert [part.content for part in response.parts] == ["First.\n\nSecond.\n\nThird."]
    assert response.finish_reason == (finish or "stop")


def test_single_choice_validation_matches_the_standard_model():
    from openai.types.chat import ChatCompletion
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    provider = OpenAIProvider(api_key="test-key")
    response = ChatCompletion.model_validate(
        {
            "id": "response-single",
            "object": "chat.completion",
            "created": 1700000000,
            "model": "test",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "length",
                    "message": {"role": "assistant", "content": "Unchanged.", "refusal": "metadata"},
                }
            ],
            "usage": {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12},
        }
    )
    original = response.model_dump()
    standard = OpenAIChatModel("test", provider=provider)._validate_completion(response)
    custom = gateway.GatewayChatModel("test", provider=provider)._validate_completion(response)
    assert custom == standard
    assert response.model_dump() == original


class Gateway:
    def __init__(self):
        self.requests = []
        self.tokens = 0
        self.sse = True
        self.token_status = 200
        self.reject = 0
        self.status = 200
        self.split = False
        self.invalid = False
        self.expected = dict(PROVIDER)

    async def handle(self, request):
        self.requests.append(request)
        if request.url.path == "/token":
            self.tokens += 1
            # Yield so concurrent callers really contend for token acquisition.
            await asyncio.sleep(0)
            assert request.extensions["timeout"]["read"] == 10
            assert parse_qs(request.content.decode()) == {
                "grant_type": ["client_credentials"],
                "scope": [self.expected["scope"]],
            }
            expected = ":".join(quote_plus(self.expected[k]) for k in ("client_id", "client_secret"))
            assert request.headers["authorization"] == "Basic " + base64.b64encode(expected.encode()).decode()
            if self.token_status == 0:
                raise httpx2.ConnectError(SECRET, request=request)
            if self.token_status != 200:
                return httpx2.Response(
                    self.token_status,
                    json={"error": "invalid_client", "message": SECRET},
                    headers={"Location": "https://redirect.example.invalid/stolen"},
                )
            return httpx2.Response(
                200, json={"access_token": f"token-{self.tokens}", "token_type": "Bearer", "expires_in": 3600}
            )
        assert request.headers["authorization"] == f"Bearer token-{self.tokens}"
        if self.reject:
            self.reject -= 1
            return httpx2.Response(401, json={"error": {"message": SECRET}})
        if self.status != 200:
            return httpx2.Response(self.status, json={"error": {"message": SECRET}})
        if request.url.path == "/v1/models":
            assert request.headers.get("accept") != "text/event-stream"
            return httpx2.Response(200, json={"data": [{"id": "test"}]})
        assert request.url.path == "/v1/chat/completions"
        assert request.extensions["timeout"]["read"] == TURN_TIMEOUT
        body = json.loads(request.content)
        messages = body["messages"]
        calls = []
        if body.get("tools") and messages[-1]["role"] != "tool":
            prompt = next(m["content"] for m in reversed(messages) if m["role"] == "user")
            calls = (
                [("launch_run", {})]
                if "Run" in prompt
                else [("read_flow", {"section": "nodes"}), ("read_documentation", {"section": "project"})]
            )
        message = {
            "role": "assistant",
            "content": None if calls else "Gateway response complete.",
            "tool_calls": [
                {
                    "id": f"call-{i}",
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)},
                }
                for i, (name, args) in enumerate(calls)
            ],
        }
        response = {
            "id": "response-1",
            "model": "test",
            "created": 1700000000,
            "object": "chat.completion",
            "choices": [{"index": 0, "message": message}],
            "usage": {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12},
        }
        assert "n" not in body
        if self.split and calls:
            response["choices"] = [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "I will inspect the flow."},
                    "finish_reason": "stop",
                },
                *reversed(
                    [
                        {
                            "index": i + 1,
                            "message": {"role": "assistant", "content": None, "tool_calls": [call]},
                            "finish_reason": None,
                        }
                        for i, call in enumerate(message["tool_calls"])
                    ]
                ),
            ]
        if self.invalid:
            response["choices"][0]["finish_reason"] = {"invalid": "response"}
        # This gateway ignores stream:true unless Accept requests SSE.
        if self.sse and request.headers.get("accept") == "text/event-stream":
            delta = dict(message)
            delta["tool_calls"] = [{"index": i, **call} for i, call in enumerate(message["tool_calls"])]
            chunks = [
                {
                    **response,
                    "object": "chat.completion.chunk",
                    "usage": None,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                },
                {
                    **response,
                    "object": "chat.completion.chunk",
                    "choices": [
                        {"index": 0, "delta": {}, "finish_reason": "tool_calls" if calls else "stop"}
                    ],
                },
            ]
            content = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
            return httpx2.Response(200, text=content, headers={"Content-Type": "text/event-stream"})
        return httpx2.Response(200, json=response)


@pytest.fixture
def remote(instance, monkeypatch):
    app, client = instance
    fake = Gateway()
    original = httpx2.AsyncClient

    class MockClient(original):
        def __init__(self, **kwargs):
            super().__init__(transport=httpx2.MockTransport(fake.handle), **kwargs)

    monkeypatch.setattr(httpx2, "AsyncClient", MockClient)
    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", True)
    app.state.assistant.configuration.model_override = None
    assert configure(client, providers=[PROVIDER]).status_code == 200
    return fake


@pytest.mark.parametrize(("streaming", "split"), [(False, False), (True, False), (False, True)])
def test_gateway_tools_approval_and_token_reuse_across_turns(instance, remote, streaming, split):
    app, client = instance
    remote.split = split
    assert configure(client, providers=[{**PROVIDER, "streaming": streaming}]).status_code == 200
    _, context = project(client)
    identity = conversation(client, context)
    result = turn(client, identity, context)[-1]["turn"]
    assert result["status"] == "complete", result
    preamble = "I will inspect the flow.\n\n" if split else ""
    assert result["text"] == preamble + "Gateway response complete."
    assert len(result["tools"]) == 2
    assert [t["name"] for t in result["tools"]] == ["read_flow", "read_documentation"]
    assert all(t["status"] == "complete" for t in result["tools"]), result
    history = app.state.services.store.get("assistant_conversation", identity)["messages"]
    responses = [m for m in history if m["kind"] == "response"]
    assert responses[-1]["provider_response_id"] == "response-1"
    assert responses[-1]["usage"]["output_tokens"] == 4
    requested = turn(client, identity, context, "Run the flow")[-1]["turn"]
    assert requested["status"] == "awaiting_approval", requested
    if split:
        assert requested["text"] == "I will inspect the flow."
    assert client.get("/api/runs").json() == []
    result = final(decide(client, identity, requested, tool="call-0"))
    assert result["status"] == "complete", result
    assert len(client.get("/api/runs").json()) == 1
    assert result["tools"][0]["run"]["id"]
    assert client.get("/api/assistant/models/primary").json()["models"] == ["test"]
    assert client.post("/api/assistant/test").json() == {"ok": True}
    assert remote.tokens == 1
    for request in remote.requests:
        if request.url.path.endswith("/chat/completions"):
            assert json.loads(request.content)["stream"] is streaming
            assert (request.headers["accept"] == "text/event-stream") is streaming


def test_unreadable_gateway_reply_has_its_own_error_and_warning(instance, remote, caplog):
    _, client = instance
    remote.invalid = True
    _, context = project(client)
    result = turn(client, conversation(client, context), context)[-1]["turn"]
    assert result["status"] == "error"
    assert result["error"] == (
        "The provider returned a response the assistant could not read. Check the server logs."
    )
    warnings = [r for r in caplog.records if r.name == "duckpad.assistant"]
    assert len(warnings) == 1
    assert warnings[0].getMessage() == (
        "Assistant turn failed: provider=primary model=test error=UnexpectedModelBehavior <- ValidationError"
    )
    assert warnings[0].exc_info is None


def test_connection_test_detects_json_and_empty_stream_then_works_without_streaming(instance, remote):
    _, client = instance
    remote.sse = False
    check = {"provider": {**PROVIDER, "streaming": True}, "model": "test"}
    response = client.post("/api/assistant/test", json=check)
    assert response.status_code == 502
    assert "Disable Streaming" in response.text
    check["provider"]["streaming"] = False
    assert client.post("/api/assistant/test", json=check).json() == {"ok": True}
    from pydantic_ai.exceptions import UnexpectedModelBehavior

    assert "Disable Streaming" in provider_error(
        UnexpectedModelBehavior("Streamed response ended without content or tool calls")
    )


def test_token_expiry_and_single_retry(instance, remote, monkeypatch):
    _, client = instance
    clock = [100.0]
    monkeypatch.setattr(gateway, "monotonic", lambda: clock[0])
    assert client.post("/api/assistant/test").status_code == 200
    clock[0] += 3569
    assert client.post("/api/assistant/test").status_code == 200
    assert remote.tokens == 1
    clock[0] += 1
    assert client.post("/api/assistant/test").status_code == 200
    assert remote.tokens == 2
    remote.reject = 1
    assert client.post("/api/assistant/test").status_code == 200
    assert remote.tokens == 3
    remote.reject = 10
    before = len(remote.requests)
    assert client.post("/api/assistant/test").status_code == 502
    assert remote.tokens == 4
    assert len(remote.requests) == before + 3  # request, token renewal, one replay


def test_concurrent_token_requests_share_a_lock(instance, remote):
    app, _ = instance
    config = app.state.assistant.configuration
    provider = config.get()["providers"][0]

    async def run():
        assert all(v["listed"] for v in await asyncio.gather(*(config.discover(provider) for _ in range(8))))
        assert remote.tokens == 1
        # All requests sent with the old token see the same renewal.
        auth = config.authentication(provider)
        generation = auth.state.generation
        await asyncio.gather(*(auth.token(rejected_generation=generation) for _ in range(8)))
        assert remote.tokens == 2

    asyncio.run(run())


@pytest.mark.parametrize(
    ("status", "message"),
    [
        (400, "refused the OAuth2"),
        (401, "refused the OAuth2"),
        (0, "Could not reach the OAuth2"),
        (302, "invalid response"),
        (500, "invalid response"),
    ],
)
def test_token_failures_are_safe_and_never_follow_redirects(instance, remote, status, message, caplog):
    _, client = instance
    remote.token_status = status
    response = client.post("/api/assistant/test")
    assert response.status_code == 502 and message in response.text, response.text
    assert len(remote.requests) == 1
    assert SECRET not in response.text + caplog.text


def test_server_errors_differ_from_network_failures(instance, remote):
    _, client = instance
    remote.status = 500
    response = client.post("/api/assistant/test")
    assert response.status_code == 502 and "server error" in response.text
    assert SECRET not in response.text
    assert "Could not reach" in provider_error(httpx2.ConnectError(SECRET))


@pytest.mark.parametrize("field", ["base_url", "token_url", "client_id", "kind", "id"])
def test_client_secret_is_write_only_and_bound_to_endpoint_and_identity(instance, field):
    app, client = instance
    assert configure(client, providers=[PROVIDER]).status_code == 200
    config = app.state.assistant.configuration
    saved = client.get("/api/assistant/settings").json()
    item = saved["providers"][0]
    assert item.pop("has_secret") is True
    item.pop("has_key")
    assert "client_secret" not in item and SECRET not in json.dumps(saved)
    item["client_secret"] = ""
    assert client.put("/api/assistant/settings", json=saved).status_code == 200
    assert config.get()["providers"][0]["client_secret"] == SECRET
    item[field] = {"kind": "ollama", "id": "other", "client_id": "other-client"}.get(
        field, "https://other.example.invalid/path"
    )
    if field == "kind":
        item = {k: item[k] for k in ("id", "kind", "base_url", "models")}
    draft = config.draft(ProviderSettings(**item))
    assert not draft.get("client_secret")
    saved.update(enabled=False, providers=[item])
    assert client.put("/api/assistant/settings", json=saved).status_code == 200
    assert not config.get()["providers"][0].get("client_secret")


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.invalid/token",
        "https://user:password@example.invalid/token",
        "https://example.invalid/token?key=secret",
        "https://example.invalid/token#fragment",
        "https://example.invalid:bad/token",
        "https://example.invalid/\\evil",
        "https://example.invalid/\ntoken",
    ],
)
def test_token_url_is_validated_before_network_access(instance, url):
    _, client = instance
    response = client.post("/api/assistant/models", json={**PROVIDER, "token_url": url})
    assert response.status_code == 400 and "token URL" in response.text


def test_secret_redaction_covers_tools_and_fragmented_streams(instance):
    app, client = instance
    configure(client, providers=[PROVIDER])
    _, context = project(client)
    deps = dependencies(app, client, context).deps
    assert deps.safe({"text": f"echo {SECRET}"}) == {"text": "echo [redacted]"}

    async def stream(messages, info):
        for char in f"echo {SECRET} end":
            yield char

    app.state.assistant.configuration.model_override = FunctionModel(stream_function=stream)
    identity = conversation(client, context)
    events = turn(client, identity, context)
    assert events[-1]["turn"]["text"] == "echo [redacted] end"
    assert "gateway-secret" not in "".join(e.get("text", "") for e in events)


@pytest.mark.parametrize("kind", ["custom", "openai", "deepseek", "ollama"])
@pytest.mark.parametrize("streaming", [False, True])
def test_sse_accept_is_only_set_for_custom_streaming_requests(instance, monkeypatch, kind, streaming):
    from pydantic_ai import Agent

    app, _ = instance
    config = app.state.assistant.configuration
    config.model_override = None
    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", True)
    original, seen = httpx2.AsyncClient, []

    def handle(request):
        seen.append(request)
        assert request.headers["authorization"] == "Bearer static-key"
        return httpx2.Response(401, json={"error": {"message": "refused"}})

    class MockClient(original):
        def __init__(self, **kwargs):
            super().__init__(transport=httpx2.MockTransport(handle), **kwargs)

    monkeypatch.setattr(httpx2, "AsyncClient", MockClient)

    async def run():
        async with config.model(
            {
                "id": "p",
                "kind": kind,
                "api_key": "static-key",
                "base_url": "https://gateway.example.invalid/v1",
            },
            "test",
        ) as model:
            if streaming:
                async with Agent(model).run_stream_events("OK") as events:
                    async for _ in events:
                        pass
            else:
                await Agent(model).run("OK")

    from pydantic_ai.exceptions import ModelHTTPError

    with pytest.raises(ModelHTTPError):
        asyncio.run(run())
    assert len(seen) == 1
    assert (seen[0].headers["accept"] == "text/event-stream") is (kind == "custom" and streaming)


@pytest.mark.parametrize("field", ["id", "base_url", "token_url", "client_id", "client_secret", "scope"])
def test_token_cache_is_bound_to_credentials_endpoint_and_scope(instance, remote, field):
    _, client = instance
    assert client.post("/api/assistant/test").status_code == 200
    changed = {
        **PROVIDER,
        field: {
            "base_url": "https://other-gateway.example.invalid/v1",
            "token_url": "https://other-auth.example.invalid/token",
        }.get(field, "replacement"),
    }
    remote.expected = changed
    assert client.post("/api/assistant/test", json={"provider": changed, "model": "test"}).status_code == 200
    assert remote.tokens == 2
