"""OAuth2 and complete-response replay for OpenAI-compatible gateways."""

import asyncio
import math
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from time import monotonic
from urllib.parse import quote_plus

import httpx2
from openai.types import chat
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models import StreamedResponse
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.wrapper import WrapperModel

TURN_TIMEOUT = 120


class GatewayChatModel(OpenAIChatModel):
    """Normalize gateways that split a complete answer into one choice per block."""

    def _validate_completion(self, response: chat.ChatCompletion):
        # Duckpad never requests n: multiple choices are fragments of one answer.
        # Pydantic AI validates every choice but only consumes the first one.
        if len(response.choices) > 1:
            data = response.model_dump(warnings=False)
            choices = sorted(data["choices"], key=lambda choice: choice.get("index") or 0)
            texts, calls = [], []
            for choice in choices:
                message = choice.get("message") or {}
                content = message.get("content")
                if isinstance(content, list):
                    content = "".join(
                        part.get("text") or ""
                        for part in content
                        if isinstance(part, dict) and part.get("type") == "text"
                    )
                if isinstance(content, str) and content:
                    texts.append(content)
                calls.extend(message.get("tool_calls") or [])
            finish = (
                "tool_calls"
                if calls
                else next((c["finish_reason"] for c in choices if c.get("finish_reason")), "stop")
            )
            data["choices"] = [
                {
                    **choices[0],
                    "index": 0,
                    "finish_reason": finish,
                    "message": {
                        **(choices[0].get("message") or {}),
                        "role": "assistant",
                        "content": "\n\n".join(texts) or None,
                        "tool_calls": calls or None,
                    },
                }
            ]
            response = chat.ChatCompletion.model_construct(**data)
        return super()._validate_completion(response)


class TokenError(Exception):
    """A safe category, never a token endpoint's response or credentials."""

    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


class StreamingUnsupported(Exception):
    """The gateway returned JSON to a streaming request."""


@dataclass
class TokenState:
    token: str = field(default="", repr=False)
    expires: float = 0
    generation: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)


class ClientCredentialsAuth(httpx2.Auth):
    def __init__(self, provider, state: TokenState):
        self.provider, self.state = provider, state

    async def token(self, rejected_generation=None):
        state = self.state
        async with state.lock:
            if state.token and state.expires > monotonic() and state.generation != rejected_generation:
                return state.token, state.generation
            # Discard rejected/expired tokens even when renewal fails.
            state.token = ""
            provider = self.provider
            data = {"grant_type": "client_credentials"}
            if provider.get("scope"):
                data["scope"] = provider["scope"]
            # RFC 6749 section 2.3.1 requires form encoding before HTTP Basic.
            auth = httpx2.BasicAuth(quote_plus(provider["client_id"]), quote_plus(provider["client_secret"]))
            started = monotonic()
            try:
                async with httpx2.AsyncClient(timeout=10, follow_redirects=False) as client:
                    response = await client.post(provider["token_url"], data=data, auth=auth)
            except httpx2.HTTPError:
                raise TokenError("unreachable") from None
            if response.status_code in (400, 401, 403):
                raise TokenError("refused")
            if not response.is_success:
                raise TokenError("response")
            try:
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError
                if payload.get("error") == "invalid_client":
                    raise TokenError("refused")
                token = payload["access_token"]
                lifetime = float(payload.get("expires_in", 0))
                if (
                    not isinstance(token, str)
                    or not token
                    or len(token) > 16384
                    or any(ord(c) <= 32 or ord(c) >= 127 for c in token)
                    or str(payload.get("token_type", "")).lower() != "bearer"
                    or not math.isfinite(lifetime)
                    or lifetime < 0
                ):
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                raise TokenError("response") from None
            state.token = token
            state.expires = started + max(0, lifetime - 30)
            state.generation += 1
            return token, state.generation

    async def async_auth_flow(self, request):
        await request.aread()
        token, generation = await self.token()
        request.headers["Authorization"] = f"Bearer {token}"
        response = yield request
        if response.status_code == 401:
            await response.aread()
            token, generation = await self.token(rejected_generation=generation)
            request.headers["Authorization"] = f"Bearer {token}"
            response = yield request
            if response.status_code == 401:
                async with self.state.lock:
                    if self.state.generation == generation:
                        self.state.token = ""
                await response.aclose()
                raise TokenError("access")


@dataclass
class ReplayedStreamedResponse(StreamedResponse):
    """Expose a complete response through the same tool and approval event path."""

    _response: ModelResponse

    async def _get_event_iterator(self):
        self._usage = self._response.usage
        self.provider_response_id = self._response.provider_response_id
        self.provider_details = self._response.provider_details
        self.finish_reason = self._response.finish_reason
        self.canonical_system = self._response.canonical_system
        self.metadata = self._response.metadata
        self.state = self._response.state
        for index, part in enumerate(self._response.parts):
            vendor_id = part.tool_call_id if isinstance(part, ToolCallPart) else index
            yield self._parts_manager.handle_part(vendor_part_id=vendor_id, part=part)

    @property
    def model_name(self) -> str:
        return self._response.model_name or ""

    @property
    def provider_name(self) -> str | None:
        return self._response.provider_name

    @property
    def provider_url(self) -> str | None:
        return self._response.provider_url

    @property
    def timestamp(self) -> datetime:
        return self._response.timestamp


class NonStreamingModel(WrapperModel):
    @asynccontextmanager
    async def request_stream(self, messages, model_settings, model_request_parameters, run_context=None):
        response = await self.request(messages, model_settings, model_request_parameters)
        yield ReplayedStreamedResponse(model_request_parameters=model_request_parameters, _response=response)
