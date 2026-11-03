"""Instance-owned provider credentials, never part of project definitions."""

import secrets
from contextlib import asynccontextmanager
from typing import Literal
from urllib.parse import urlsplit

import httpx2
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelHTTPError, UsageLimitExceeded
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.mistral import MistralModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.deepseek import DeepSeekProvider
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.mistral import MistralProvider
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai.providers.openai import OpenAIProvider

from ..util import Problem

ProviderKind = Literal["openai", "anthropic", "google", "mistral", "deepseek", "ollama", "custom"]
BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta",
    "mistral": "https://api.mistral.ai/v1",
    "deepseek": "https://api.deepseek.com",
    "ollama": "http://localhost:11434/v1",
}


class ProviderSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    kind: ProviderKind
    base_url: str = Field(default="", max_length=2048)
    api_key: SecretStr | None = None
    models: list[str] = Field(default_factory=list, max_length=100)


class ConnectionCheck(BaseModel):
    """Unsaved provider settings to try; without them, the saved default is tested."""

    model_config = ConfigDict(extra="forbid")
    provider: ProviderSettings | None = None
    model: str = Field(default="", max_length=200)


class QuickPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    label: str = Field(min_length=1, max_length=100)
    prompt: str = Field(min_length=1, max_length=4000)


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    allow_data: bool = True
    max_rows: int = Field(default=50, ge=1, le=500)
    providers: list[ProviderSettings] = Field(default_factory=list, max_length=20)
    default_provider: str = ""
    default_model: str = Field(default="", max_length=200)
    # None selects translated built-ins; an empty list deliberately hides all prompts.
    quick_prompts: list[QuickPrompt] | None = Field(default=None, max_length=30)


def provider_error(error):
    """Never stringify SDK errors: they can contain request bodies, URLs and keys."""
    status = error.status_code if isinstance(error, ModelHTTPError) else getattr(error, "status_code", None)
    if isinstance(error, httpx2.HTTPStatusError):
        status = error.response.status_code
    if isinstance(error, UsageLimitExceeded):
        return "The assistant reached its limit for this turn. Try a narrower question."
    if status in (401, 403):
        return "The provider refused the API key. Ask an instance administrator to check it."
    if status == 429:
        return "The provider quota or rate limit was reached. Try again later."
    if status in (400, 404, 422):
        return "The model is unavailable or does not support this request. Check the configured model."
    if isinstance(error, TimeoutError):
        return "The assistant timed out. Try a narrower question."
    return "Could not reach the assistant provider. Check the connection and model, then try again."


class Configuration:
    def __init__(self, store):
        self.store = store
        # Tests inject a model here; production has no environment or API switch.
        self.model_override = None

    def get(self):
        return {**Settings().model_dump(), "revision": "", **self.store.get("settings", "assistant", {})}

    def public(self):
        config = self.get()
        return {
            **{k: v for k, v in config.items() if k != "revision"},
            "providers": [
                {**{k: v for k, v in p.items() if k != "api_key"}, "has_key": bool(p.get("api_key"))}
                for p in config["providers"]
            ],
        }

    def options(self):
        config = self.get()
        return {
            "enabled": config["enabled"],
            "allow_data": config["allow_data"],
            "max_rows": config["max_rows"],
            "models": [
                {"provider": p["id"], "kind": p["kind"], "model": m}
                for p in config["providers"]
                for m in p["models"]
            ]
            if config["enabled"]
            else [],
            "default_provider": config["default_provider"],
            "default_model": config["default_model"],
            "quick_prompts": config["quick_prompts"],
        }

    @staticmethod
    def normalize(item: ProviderSettings, previous):
        """Validate a provider; a blank key keeps the saved one only for the same endpoint."""
        value = item.model_dump(exclude={"api_key"})
        value["base_url"] = item.base_url.strip().rstrip("/")
        if item.kind not in ("ollama", "custom"):
            value["base_url"] = ""
        if item.kind == "custom" and not value["base_url"]:
            raise Problem("Provide a base URL for the custom provider")
        if value["base_url"]:
            try:
                url = urlsplit(value["base_url"])
                if (
                    url.scheme not in ("http", "https")
                    or not url.hostname
                    or url.username
                    or url.password
                    or url.query
                    or url.fragment
                    or "\\" in value["base_url"]
                    or any(ord(c) <= 32 for c in value["base_url"])
                ):
                    raise ValueError
                _ = url.port
            except ValueError:
                raise Problem(
                    "Use an HTTP or HTTPS base URL without credentials, query or fragment"
                ) from None
        key = item.api_key.get_secret_value().strip() if item.api_key else ""
        if len(key) > 4096:
            raise Problem("API key is too long")
        old = previous.get(item.id, {})
        same = all(value[k] == old.get(k) for k in ("kind", "base_url"))
        value["api_key"] = key or (old.get("api_key", "") if same else "")
        value["models"] = list(dict.fromkeys(m.strip() for m in item.models if m.strip()))
        if any(len(m) > 200 or any(ord(c) < 32 for c in m) for m in value["models"]):
            raise Problem("Use model identifiers of at most 200 characters")
        return value

    def draft(self, item: ProviderSettings):
        """Resolve unsaved provider settings against the saved key, for discovery and tests."""
        return self.normalize(item, {p["id"]: p for p in self.get()["providers"]})

    def save(self, settings: Settings):
        previous = {p["id"]: p for p in self.get()["providers"]}
        config = settings.model_dump(exclude={"providers"})
        providers = [self.normalize(item, previous) for item in settings.providers]
        if len({p["id"] for p in providers}) != len(providers):
            raise Problem("Provider identifiers must be unique")
        config["providers"] = providers
        if settings.enabled:
            self.select(config, settings.default_provider, settings.default_model)
        config["revision"] = secrets.token_hex(16)
        self.store.put("settings", "assistant", config)
        return self.public()

    @staticmethod
    def select(config, provider, model):
        item = next((p for p in config["providers"] if p["id"] == provider), None)
        if not item or model not in item["models"]:
            raise Problem("Choose an allowed assistant model")
        Configuration.require_key(item)
        return item

    @staticmethod
    def require_key(provider):
        if provider["kind"] not in ("ollama", "custom") and not provider.get("api_key"):
            raise Problem("Provide an API key for this provider")

    @asynccontextmanager
    async def model(self, provider, name):
        if self.model_override is not None:
            yield self.model_override
            return

        # Explicit credentials prevent SDKs from reading the operator's environment.
        # No redirects: a custom endpoint must not redirect a key to another host.
        async def prepare_request(request):
            if not provider.get("api_key"):
                request.headers.pop("authorization", None)

        async with httpx2.AsyncClient(
            timeout=45, follow_redirects=False, event_hooks={"request": [prepare_request]}
        ) as client:
            key = provider.get("api_key") or "no-key"
            kind = provider["kind"]
            if kind == "anthropic":
                model = AnthropicModel(name, provider=AnthropicProvider(api_key=key, http_client=client))
            elif kind == "google":
                model = GoogleModel(name, provider=GoogleProvider(api_key=key, http_client=client))
            elif kind == "mistral":
                model = MistralModel(name, provider=MistralProvider(api_key=key, http_client=client))
            else:
                if kind == "deepseek":
                    sdk = DeepSeekProvider(api_key=key, http_client=client)
                elif kind == "ollama":
                    sdk = OllamaProvider(
                        base_url=provider["base_url"] or BASE_URLS[kind], api_key=key, http_client=client
                    )
                else:
                    sdk = OpenAIProvider(
                        base_url=provider["base_url"] or BASE_URLS[kind], api_key=key, http_client=client
                    )
                model = OpenAIChatModel(name, provider=sdk)
            yield model

    async def test(self, check: ConnectionCheck | None = None):
        if check and check.provider:
            provider, name = self.draft(check.provider), check.model.strip()
            if not name:
                raise Problem("Choose an allowed assistant model")
            self.require_key(provider)
        else:
            config = self.get()
            provider = self.select(config, config["default_provider"], config["default_model"])
            name = config["default_model"]
        try:
            async with self.model(provider, name) as model:
                await Agent(model).run("Reply with OK.", timeout=30, model_settings={"max_tokens": 64})
        except Exception as error:
            raise Problem(provider_error(error), 502) from None
        return {"ok": True}

    async def models(self, identity):
        provider = next((p for p in self.get()["providers"] if p["id"] == identity), None)
        if provider is None:
            raise Problem("Provider not found", 404)
        return await self.discover(provider)

    async def discover(self, provider):
        """List chat models; `listed` is false when the server has no model-list endpoint."""
        self.require_key(provider)
        kind, key = provider["kind"], provider.get("api_key", "")
        base = provider["base_url"] or BASE_URLS.get(kind, "")
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        # Anthropic and Google paginate; one large page covers their catalogs.
        params = {}
        if kind == "anthropic":
            headers, params = {"x-api-key": key, "anthropic-version": "2023-06-01"}, {"limit": 1000}
        elif kind == "google":
            headers, params = {"x-goog-api-key": key}, {"pageSize": 1000}
        try:
            async with httpx2.AsyncClient(timeout=15, follow_redirects=False) as client:
                response = await client.get(base + "/models", headers=headers, params=params)
                if response.status_code in (404, 405):
                    return {"models": [], "listed": False}
                response.raise_for_status()
                payload = response.json()
                values = payload.get("models" if kind == "google" else "data", [])
                names = [
                    v.get("id") or v.get("name", "").removeprefix("models/")
                    for v in values
                    if isinstance(v, dict) and chat_model(v)
                ]
                return {
                    "models": sorted({n for n in names if isinstance(n, str) and n})[:500],
                    "listed": True,
                }
        except Exception as error:
            raise Problem(provider_error(error), 502) from None


def chat_model(item):
    """Skip embedding-only and similar models when the provider describes capabilities."""
    methods = item.get("supportedGenerationMethods")
    if isinstance(methods, list) and "generateContent" not in methods:
        return False
    capabilities = item.get("capabilities")
    return not (isinstance(capabilities, dict) and capabilities.get("completion_chat") is False)
