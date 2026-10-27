"""Single-provider OIDC code flow with server-side, browser-bound transactions."""

import hmac
import re
import secrets
import time
from urllib.parse import urlsplit

import httpx2
from authlib.integrations.httpx_client import OAuth2Client
from authlib.oauth2 import OAuth2Error
from authlib.oidc.core import CodeIDToken
from joserfc import jwt
from joserfc.errors import JoseError
from joserfc.jwk import KeySet
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from .auth import SESSION_LIFETIME, session_key
from .util import Problem, uid

CALLBACK_PATH = "/api/oidc/callback"
TRANSACTION_LIFETIME = 600
SIGNING_ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"]
DEFAULTS = {
    "enabled": False,
    "label": "Single sign-on",
    "issuer": "",
    "client_id": "",
    "public_url": "",
    "allow_signup": True,
}


class OIDCSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    label: str = Field(default="Single sign-on", min_length=1, max_length=80)
    issuer: str = Field(default="", max_length=2048)
    client_id: str = Field(default="", max_length=512)
    public_url: str = Field(default="", max_length=2048)
    # Omitted or blank preserves the existing secret; it is never returned.
    client_secret: SecretStr | None = None
    allow_signup: bool = True


def validate_url(value, *, local=False):
    try:
        if not isinstance(value, str):
            raise ValueError
        parsed = urlsplit(value)
        if (
            not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or parsed.query
            or "\\" in value
            or any(ord(c) <= 32 for c in value)
            or (parsed.scheme != "https" and not (local and is_loopback_url(value)))
        ):
            raise ValueError
        _ = parsed.port
    except (ValueError, TypeError) as error:
        raise Problem(
            "Use an HTTPS URL without credentials, query or fragment (HTTP is allowed on loopback)."
        ) from error
    return parsed


def is_loopback_url(value):
    parsed = urlsplit(value)
    return parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")


class OIDC:
    def __init__(self, store, auth):
        self.store = store
        self.auth = auth

    def settings(self):
        return self.store.get("settings", "oidc", DEFAULTS.copy())

    def public_settings(self):
        config = self.settings()
        return {
            **{key: config[key] for key in DEFAULTS},
            "has_secret": bool(config.get("client_secret")),
            "redirect_uri": config["public_url"] + CALLBACK_PATH if config["public_url"] else "",
        }

    def save(self, data: OIDCSettings):
        config = data.model_dump(exclude={"client_secret"})
        for key in ("label", "issuer", "client_id", "public_url"):
            config[key] = config[key].strip()
        config["public_url"] = config["public_url"].rstrip("/")
        previous = self.settings()
        secret = data.client_secret.get_secret_value() if data.client_secret else ""
        if len(secret) > 4096:
            raise Problem("Client secret is too long")
        # Never silently send a saved credential to a different provider/client.
        same_client = all(config[k] == previous[k] for k in ("issuer", "client_id"))
        config["client_secret"] = secret or (previous.get("client_secret", "") if same_client else "")
        if not config["label"]:
            raise Problem("Provide a sign-in button label")
        if config["issuer"]:
            validate_url(config["issuer"], local=True)
        if config["public_url"] and validate_url(config["public_url"], local=True).path:
            raise Problem("The application URL must be an origin without a path")
        if config["enabled"]:
            if not all(config[k] for k in ("issuer", "client_id", "client_secret", "public_url")):
                raise Problem(
                    "Provide the issuer, client ID, client secret and application URL before enabling SSO"
                )
            self.discover(config)
        config["revision"] = secrets.token_hex(16)
        with self.store.lock:
            self.store.put("settings", "oidc", config)
            for key, _ in self.store.items("oidc_transaction"):
                self.store.delete("oidc_transaction", key)
        return self.public_settings()

    @staticmethod
    def get_json(url):
        with httpx2.Client(timeout=10, follow_redirects=False) as client:
            response = client.get(url)
            response.raise_for_status()
            return response.json()

    def discover(self, config):
        try:
            metadata = self.get_json(config["issuer"].rstrip("/") + "/.well-known/openid-configuration")
            if metadata["issuer"] != config["issuer"] or "code" not in metadata["response_types_supported"]:
                raise ValueError
            for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
                validate_url(metadata[key], local=is_loopback_url(config["issuer"]))
            methods = metadata.get("token_endpoint_auth_methods_supported", ["client_secret_basic"])
            metadata["auth_method"] = next(
                m for m in ("client_secret_basic", "client_secret_post") if m in methods
            )
            metadata["algorithms"] = [
                alg for alg in metadata["id_token_signing_alg_values_supported"] if alg in SIGNING_ALGORITHMS
            ]
            if not metadata["algorithms"]:
                raise ValueError
            if (
                "code_challenge_methods_supported" in metadata
                and "S256" not in metadata["code_challenge_methods_supported"]
            ):
                raise ValueError
        except (httpx2.HTTPError, ValueError, KeyError, TypeError, StopIteration, Problem) as error:
            raise Problem(
                "Could not validate OIDC discovery. Check the issuer and provider support for code flow, PKCE S256 and client secrets."
            ) from error
        return metadata

    @staticmethod
    def client(config, metadata):
        return OAuth2Client(
            config["client_id"],
            config["client_secret"],
            token_endpoint_auth_method=metadata["auth_method"],
            redirect_uri=config["public_url"] + CALLBACK_PATH,
            scope="openid profile email",
            code_challenge_method="S256",
            timeout=10,
            follow_redirects=False,
        )

    def start(self):
        config = self.settings()
        if not config["enabled"]:
            raise Problem("Single sign-on is disabled")
        metadata = self.discover(config)
        state, browser, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(4))
        with self.client(config, metadata) as client:
            url, _ = client.create_authorization_url(
                metadata["authorization_endpoint"],
                state=state,
                nonce=nonce,
                code_verifier=verifier,
                response_mode="query",
            )
        with self.store.lock:
            for key, value in self.store.items("oidc_transaction"):
                if value["expires"] < time.time():
                    self.store.delete("oidc_transaction", key)
            if len(self.store.items("oidc_transaction")) >= 1000:
                raise Problem("Too many pending sign-ins. Try again later.", 429)
            self.store.put(
                "oidc_transaction",
                session_key(state),
                {
                    "browser": session_key(browser),
                    "nonce": nonce,
                    "verifier": verifier,
                    "revision": config["revision"],
                    "metadata": metadata,
                    "expires": time.time() + TRANSACTION_LIFETIME,
                },
            )
        return url, browser

    def finish(self, params, browser):
        state = params.get("state", "")
        with self.store.lock:
            transaction = self.store.get("oidc_transaction", session_key(state))
            if (
                not browser
                or not transaction
                or not hmac.compare_digest(transaction["browser"], session_key(browser))
            ):
                raise Problem("Invalid sign-in state")
            # Consume before exchanging the code, including on provider errors.
            self.store.delete("oidc_transaction", session_key(state))
        config = self.settings()
        if (
            not config["enabled"]
            or config.get("revision") != transaction["revision"]
            or transaction["expires"] < time.time()
            or params.get("error")
            or not params.get("code")
            or (params.get("iss") and params["iss"] != config["issuer"])
        ):
            raise Problem("Sign-in expired or was declined")
        metadata = transaction["metadata"]
        try:
            with self.client(config, metadata) as client:
                token = client.fetch_token(
                    metadata["token_endpoint"], code=params["code"], code_verifier=transaction["verifier"]
                )
            keys = KeySet.import_key_set(self.get_json(metadata["jwks_uri"]))
            decoded = jwt.decode(token["id_token"], keys, algorithms=metadata["algorithms"])
            claims = CodeIDToken(
                decoded.claims,
                decoded.header,
                {
                    "iss": {"essential": True, "value": config["issuer"]},
                    "aud": {"essential": True, "value": config["client_id"]},
                },
                {
                    "nonce": transaction["nonce"],
                    "client_id": config["client_id"],
                    "access_token": token.get("access_token"),
                },
            )
            claims.validate(leeway=30)
            if not isinstance(claims["sub"], str) or not 1 <= len(claims["sub"]) <= 255:
                raise ValueError
        except (httpx2.HTTPError, OAuth2Error, JoseError, ValueError, KeyError, TypeError) as error:
            raise Problem("The identity provider response could not be verified") from error
        return self.create_session(config, claims)

    def create_session(self, config, claims):
        identity = {"issuer": config["issuer"], "subject": claims["sub"]}
        with self.store.lock:
            if self.settings().get("revision") != config["revision"]:
                raise Problem("SSO configuration changed; sign in again")
            user = next((u for u in self.store.all("user") if u.get("oidc") == identity), None)
            if user is None:
                if not config["allow_signup"]:
                    raise Problem("New SSO accounts are disabled")
                name = claims.get("preferred_username") or claims.get("name") or "user"
                name = re.sub(r"[^a-zA-Z0-9_.-]", "-", str(name))[:40].strip("-.") or "user"
                existing = {u["username"].casefold() for u in self.store.all("user")}
                while True:
                    username = name + "-sso-" + secrets.token_hex(4)
                    if username.casefold() not in existing:
                        break
                user = {
                    "id": uid("user_"),
                    "username": username,
                    "role": "member",
                    "active": True,
                    "oidc": identity,
                }
                self.store.put("user", user["id"], user)
            if not user["active"]:
                raise Problem("Account is inactive")
            token = secrets.token_urlsafe(32)
            self.auth._purge_expired(time.time())
            self.store.put(
                "session",
                session_key(token),
                {
                    "user": user["id"],
                    "oidc_revision": config["revision"],
                    "version": user.get("session_version", 0),
                    "expires": time.time() + SESSION_LIFETIME,
                },
            )
        return token
