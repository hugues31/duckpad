"""Provider diagnostics retain useful traces without publishing credentials."""

import json
import logging

import httpx2
import pytest
from pydantic_ai.exceptions import UnexpectedModelBehavior
from pydantic_ai.models.function import FunctionModel
from test_assistant import configure, conversation, project, turn
from test_assistant import instance as instance

from duckpad.assistant.gateway import TokenState


@pytest.mark.parametrize("operation", ["turn", "connection test", "model discovery"])
@pytest.mark.parametrize("level", [logging.WARNING, logging.DEBUG])
def test_failure_logs_redact_saved_draft_and_token_secrets(instance, monkeypatch, caplog, operation, level):
    app, client = instance
    configure(client)
    config = app.state.assistant.configuration
    # Use escapes and overlapping values to exercise raw and SDK-rendered messages.
    api_key = "private-test-key"
    client_secret = 'draft-secret:" café\n'
    token = "private-test-key-token"
    config.tokens[("test",)] = TokenState(token=token)
    draft = {
        "id": "draft",
        "kind": "custom",
        "base_url": "https://gateway.example.invalid/v1",
        "auth": "oauth2",
        "token_url": "https://auth.example.invalid/token",
        "client_id": "client",
        "client_secret": client_secret,
        "streaming": False,
        "models": ["test"],
    }
    if operation == "turn":
        # Chat uses saved settings; test/discovery exercise unsaved credentials.
        configure(
            client,
            providers=[
                config.get()["providers"][0],
                {**draft, "client_secret": client_secret.rstrip()},
            ],
        )
        client_secret = client_secret.rstrip()
    exposed = [api_key, client_secret, token]
    message = "provider payload " + " ".join(
        form
        for secret in exposed
        for form in (secret, repr(secret), json.dumps(secret), json.dumps(secret, ensure_ascii=False))
    )

    def fail():
        try:
            raise ValueError(message)
        except ValueError as error:
            raise UnexpectedModelBehavior("unreadable provider response " + message) from error

    async def stream(messages, info):
        fail()
        yield "unreachable"

    config.model_override = FunctionModel(stream_function=stream)
    original = httpx2.AsyncClient

    class MockClient(original):
        def __init__(self, **kwargs):
            super().__init__(transport=httpx2.MockTransport(lambda request: fail()), **kwargs)

    if operation == "model discovery":
        # Avoid a token request: the transport failure is from model discovery itself.
        monkeypatch.setattr(config, "authentication", lambda provider: None)
        monkeypatch.setattr(httpx2, "AsyncClient", MockClient)
    with caplog.at_level(level, logger="duckpad.assistant"):
        if operation == "turn":
            _, context = project(client)
            result = turn(client, conversation(client, context), context)[-1]["turn"]
            assert result["status"] == "error"
            output = result["error"]
        else:
            response = (
                client.post("/api/assistant/test", json={"provider": draft, "model": "test"})
                if operation == "connection test"
                else client.post("/api/assistant/models", json=draft)
            )
            assert response.status_code == 502
            output = response.text
    assert "response the assistant could not read" in output
    records = [r for r in caplog.records if r.name == "duckpad.assistant"]
    warnings = [r for r in records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    provider = "primary" if operation == "turn" else "draft"
    model = "-" if operation == "model discovery" else "test"
    assert warnings[0].getMessage() == (
        f"Assistant {operation} failed: provider={provider} model={model} "
        "error=UnexpectedModelBehavior <- ValueError"
    )
    assert "provider payload" not in warnings[0].getMessage()
    assert all(r.exc_info is None for r in records)
    for secret in exposed:
        assert secret not in caplog.text + output
        assert repr(secret)[1:-1] not in caplog.text
        assert json.dumps(secret)[1:-1] not in caplog.text
    if level == logging.DEBUG:
        assert len(records) == 2
        trace = records[1].getMessage()
        assert "Traceback (most recent call last)" in trace
        assert "The above exception was the direct cause" in trace
        assert "ValueError: provider payload [redacted]" in trace
        assert "UnexpectedModelBehavior: unreadable provider response" in trace
        assert "in fail" in trace
    else:
        assert len(records) == 1
        assert "Traceback" not in caplog.text
