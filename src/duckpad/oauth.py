"""OAuth 2.1 for the agent API, so web MCP connectors such as claude.ai and ChatGPT can sign in.

Duckpad is both the authorization server and the protected resource, following the MCP
authorization specification. Apps identify themselves with a client ID metadata document (an
HTTPS address) or register dynamically (RFC 7591). A signed-in person approves every
authorization in Duckpad; the app then exchanges a single-use code, bound to a PKCE S256
challenge, for a short-lived access token and a rotating refresh token. Both are stored as
hashes and only open `/api/agent` on the origin they were issued for (RFC 8707), with the
account's current roles.
"""

import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import ssl
import threading
import time
from urllib.parse import parse_qsl, unquote_plus, urlencode, urlsplit

from .auth import OAUTH_TOKEN_PREFIX, session_key
from .util import Problem, uid

SCOPE = "agent"
# Accepted and echoed for clients that ask for it; refresh tokens are always issued.
OFFLINE = "offline_access"
ACCESS_PREFIX = OAUTH_TOKEN_PREFIX
REFRESH_PREFIX = "dpr_"
ACCESS_LIFETIME = 3600
# Sliding: each refresh extends the authorization, so an app used at least monthly stays connected.
REFRESH_LIFETIME = 30 * 24 * 3600
CODE_LIFETIME = 300
# A used refresh token revokes its authorization, except right after its rotation: an app that
# refreshes twice concurrently is not replaying a stolen token.
REUSE_LEEWAY = 30
# Registrations and metadata documents nobody authorized for this long are deleted.
IDLE_CLIENT = 30 * 24 * 3600
MAX_CLIENTS = 10000
REGISTRATIONS = 30
REGISTRATION_WINDOW = 3600
DOCUMENT_TTL = 3600
DOCUMENT_STALE = 7 * 24 * 3600
DOCUMENT_BYTES = 8 * 1024
DOCUMENT_TIMEOUT = 5
AUTH_METHODS = ("none", "client_secret_post", "client_secret_basic")
LOOPBACK = ("localhost", "127.0.0.1", "::1")

AGENT_PREFIX = "/api/agent/"
MCP_PATH = "/api/agent/mcp"
AUTHORIZE_PATH = "/oauth/authorize"
TOKEN_PATH = "/api/oauth/token"
REGISTER_PATH = "/api/oauth/register"
REVOKE_PATH = "/api/oauth/revoke"
RESOURCE_METADATA = "/.well-known/oauth-protected-resource"
SERVER_METADATA = "/.well-known/oauth-authorization-server"
HTTPS_REQUIRED = (
    "Apps can only connect over HTTPS. Serve Duckpad over HTTPS, or behind a reverse proxy "
    "listed in FORWARDED_ALLOW_IPS or with DUCKPAD_SECURE_COOKIES=1 (see the installation guide)."
)
HOST = re.compile(r"(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?")
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]")


class OAuthError(Exception):
    """An error answered in the OAuth format: `{"error", "error_description"}`."""

    def __init__(self, error, description, status=400):
        super().__init__(description)
        self.error, self.description, self.status = error, description, status

    def body(self):
        return {"error": self.error, "error_description": self.description}


def origin(request):
    """The public origin clients use for this instance, or None when OAuth cannot be offered.

    Behind a reverse proxy, the scheme comes from the X-Forwarded-Proto header of proxies listed
    in FORWARDED_ALLOW_IPS, or from DUCKPAD_SECURE_COOKIES=1. OAuth needs HTTPS except on loopback.
    """
    host = request.headers.get("host", "").lower()
    if not HOST.fullmatch(host):
        return None
    secure = request.url.scheme == "https" or os.environ.get("DUCKPAD_SECURE_COOKIES") == "1"
    try:
        parts = urlsplit("//" + host)
        port = parts.port
    except ValueError:
        return None
    if not parts.hostname or not (secure or parts.hostname in LOOPBACK):
        return None
    netloc = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname.rstrip(".")
    if port and port != (443 if secure else 80):
        netloc += f":{port}"
    return f"{'https' if secure else 'http'}://{netloc}"


def resource(base):
    """The protected resource, and so the audience of every token issued on this origin."""
    return base + MCP_PATH


def canonical(value):
    """A resource URI as clients send it: lowercase scheme and host, no default port or final slash."""
    try:
        parts = urlsplit(value)
        port = parts.port
    except (ValueError, TypeError):
        return None
    if (
        not parts.hostname
        or parts.fragment
        or parts.username is not None
        or parts.scheme not in ("http", "https")
    ):
        return None
    netloc = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    if port and port != {"https": 443, "http": 80}[parts.scheme]:
        netloc += f":{port}"
    query = f"?{parts.query}" if parts.query else ""
    return f"{parts.scheme}://{netloc}{parts.path.rstrip('/')}{query}"


def challenge(request, *, token=False):
    """The WWW-Authenticate value of a 401 from the agent API: where to discover how to sign in."""
    params = ['error="invalid_token"'] if token else []
    if base := origin(request):
        params += [f'resource_metadata="{base}{RESOURCE_METADATA}{MCP_PATH}"', f'scope="{SCOPE}"']
    return "Bearer " + ", ".join(params) if params else "Bearer"


def resource_metadata(base):
    """RFC 9728 protected resource metadata."""
    return {
        "resource": resource(base),
        "authorization_servers": [base],
        "scopes_supported": [SCOPE],
        "bearer_methods_supported": ["header"],
        "resource_name": "Duckpad",
    }


def server_metadata(base):
    """RFC 8414 authorization server metadata."""
    return {
        "issuer": base,
        "authorization_endpoint": base + AUTHORIZE_PATH,
        "token_endpoint": base + TOKEN_PATH,
        "registration_endpoint": base + REGISTER_PATH,
        "revocation_endpoint": base + REVOKE_PATH,
        "scopes_supported": [SCOPE, OFFLINE],
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": list(AUTH_METHODS),
        "revocation_endpoint_auth_methods_supported": list(AUTH_METHODS),
        "client_id_metadata_document_supported": True,
        "authorization_response_iss_parameter_supported": True,
    }


def redirect_problem(uri):
    """Why a redirect URI is refused: only HTTPS, or HTTP on a loopback address, without fragment."""
    message = "Use HTTPS redirect URIs, or HTTP on localhost, 127.0.0.1 or [::1], without a fragment"
    if (
        not isinstance(uri, str)
        or not 0 < len(uri) <= 2000
        or CONTROL.search(uri)
        or " " in uri
        or "\\" in uri
    ):
        return message
    try:
        parts = urlsplit(uri)
        _ = parts.port
    except ValueError:
        return message
    if "#" in uri or parts.username is not None or not parts.hostname:
        return message
    if parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in LOOPBACK):
        return None
    return message


def redirect_matches(registered, requested):
    """Exact match, except that a loopback redirect may use any port (RFC 8252, section 7.3)."""
    if registered == requested:
        return True
    try:
        a, b = urlsplit(registered), urlsplit(requested)
        _ = b.port
    except ValueError:
        return False
    return (
        a.scheme == b.scheme == "http"
        and a.hostname in LOOPBACK
        and a.hostname == b.hostname
        and (a.path, a.query) == (b.path, b.query)
        and b.username is None
        and redirect_problem(requested) is None
    )


def with_query(uri, params):
    """Add response parameters to a redirect URI, keeping its own query."""
    separator = "" if uri.endswith("?") else "&" if urlsplit(uri).query else "?"
    return uri + separator + urlencode({k: v for k, v in params.items() if v is not None})


def single(pairs):
    """Parameters as a dict; OAuth forbids repeating one (RFC 6749, section 3.1)."""
    values = {}
    for key, value in pairs:
        if key in values:
            raise OAuthError("invalid_request", f"Repeated parameter: {key}")
        values[key] = value
    return values


def pkce_matches(verifier, expected):
    if not isinstance(verifier, str) or not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier):
        return False
    digest = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return hmac.compare_digest(digest, expected)


def granted_scope(requested):
    """Every authorization grants the agent API; unknown scopes are ignored (RFC 6749, section 3.3)."""
    return SCOPE + (" " + OFFLINE if OFFLINE in (requested or "").split() else "")


def display_name(value):
    """A client-supplied name, without control or direction characters, on one short line."""
    if not isinstance(value, str):
        return None
    return " ".join(CONTROL.sub("", value).split())[:80] or None


def host_of(uri):
    parts = urlsplit(uri)
    return parts.netloc.rpartition("@")[2].lower()


def document_problem(url):
    """Why a client ID cannot name a metadata document: HTTPS on port 443, with a path, nothing else."""
    message = "The app's client ID must be an HTTPS address with a path, without query, fragment or port"
    if len(url) > 2000 or CONTROL.search(url) or " " in url or "\\" in url:
        return message
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return message
    segments = parts.path.split("/")
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username is not None
        or port not in (None, 443)
        or parts.query
        or "?" in url
        or "#" in url
        or parts.path in ("", "/")
        or any(s in (".", "..") or s.lower() in ("%2e", "%2e%2e", ".%2e", "%2e.") for s in segments)
    ):
        return message
    try:
        ipaddress.ip_address(parts.hostname)
    except ValueError:
        return None
    return message


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS to an address checked beforehand, verifying the certificate of the requested host."""

    def __init__(self, host, address, context, timeout):
        super().__init__(host, 443, timeout=timeout, context=context)
        self.address, self.pinned_context = address, context

    def connect(self):
        sock = socket.create_connection((self.address, 443), self.timeout)
        self.sock = self.pinned_context.wrap_socket(sock, server_hostname=self.host)


def public_address(value):
    address = ipaddress.ip_address(value.partition("%")[0])
    mapped = getattr(address, "ipv4_mapped", None)
    return address.is_global and (mapped is None or mapped.is_global)


def fetch_document(url):
    """Read a client metadata document from a public address only, without redirects (SSRF guard)."""
    host = urlsplit(url).hostname
    try:
        addresses = [info[4][0] for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)]
    except (OSError, UnicodeError):
        raise Problem(f"Could not resolve {host}, the address of the app's metadata document") from None
    if not addresses or not all(public_address(a) for a in addresses):
        raise Problem(
            f"{host} does not resolve to a public address; Duckpad only reads public metadata documents"
        )
    connection = PinnedHTTPSConnection(host, addresses[0], ssl.create_default_context(), DOCUMENT_TIMEOUT)
    deadline = time.monotonic() + 2 * DOCUMENT_TIMEOUT
    try:
        path = urlsplit(url).path
        connection.request("GET", path, headers={"Accept": "application/json", "User-Agent": "Duckpad"})
        response = connection.getresponse()
        if response.status != 200:
            raise Problem(f"The app's metadata document answered HTTP {response.status}")
        body = b""
        while chunk := response.read(1024):
            body += chunk
            if len(body) > DOCUMENT_BYTES or time.monotonic() > deadline:
                raise Problem("The app's metadata document is too large or too slow")
    except (OSError, http.client.HTTPException):
        raise Problem(f"Could not read the app's metadata document from {host}") from None
    finally:
        connection.close()
    try:
        return json.loads(body)
    except ValueError:
        raise Problem("The app's metadata document is not JSON") from None


def document_client(url, document):
    """The client a metadata document describes; such public clients authenticate with PKCE alone."""
    if not isinstance(document, dict) or document.get("client_id") != url:
        raise Problem("The app's metadata document does not name its own address as client_id")
    uris = document.get("redirect_uris")
    if not isinstance(uris, list) or not 1 <= len(uris) <= 20:
        raise Problem("The app's metadata document must list 1 to 20 redirect_uris")
    for uri in uris:
        if problem := redirect_problem(uri):
            raise Problem(f"The app's metadata document has an invalid redirect URI. {problem}")
    methods = document.get("token_endpoint_auth_methods_supported") or []
    method = document.get("token_endpoint_auth_method", "none")
    if not isinstance(methods, list) or "none" not in [method, *methods]:
        raise Problem(
            "This app authenticates with a key or a secret, which Duckpad does not support for metadata "
            "documents. Choose the app's public client or its automatic registration."
        )
    grants = document.get("grant_types", ["authorization_code"])
    if not isinstance(grants, list) or "authorization_code" not in grants:
        raise Problem("The app's metadata document does not allow the authorization code flow")
    return {"name": display_name(document.get("client_name")), "redirect_uris": uris}


class OAuth:
    def __init__(self, store, auth):
        self.store = store
        self.auth = auth
        self.lock = threading.Lock()
        self.registrations = {}
        # Replaced in tests; production reads documents from public addresses only.
        self.fetch = fetch_document

    # Apps

    def register(self, data, peer):
        """RFC 7591 dynamic registration: an identifier, plus a secret for confidential clients."""
        now = time.time()
        with self.lock:
            self.registrations = {
                address: recent
                for address, times in self.registrations.items()
                if (recent := [t for t in times if t > now - REGISTRATION_WINDOW])
            }
            recent = self.registrations.setdefault(peer, [])
            if len(recent) >= REGISTRATIONS:
                raise OAuthError("too_many_requests", "Too many registrations. Try again later.", 429)
            recent.append(now)
        if not isinstance(data, dict):
            raise OAuthError("invalid_client_metadata", "Send the client metadata as a JSON object")
        uris = data.get("redirect_uris")
        if not isinstance(uris, list) or not 1 <= len(uris) <= 10:
            raise OAuthError("invalid_redirect_uri", "Register 1 to 10 redirect_uris")
        for uri in uris:
            if problem := redirect_problem(uri):
                raise OAuthError("invalid_redirect_uri", problem)
        # Omitted or null fields take their RFC 7591 defaults.
        method = data.get("token_endpoint_auth_method") or "client_secret_basic"
        if method not in AUTH_METHODS:
            raise OAuthError(
                "invalid_client_metadata",
                "Supported token_endpoint_auth_method values: " + ", ".join(AUTH_METHODS),
            )
        grants = data.get("grant_types") or ["authorization_code"]
        if (
            not isinstance(grants, list)
            or "authorization_code" not in grants
            or not set(grants) <= {"authorization_code", "refresh_token"}
        ):
            raise OAuthError(
                "invalid_client_metadata", "Only authorization_code and refresh_token grants are supported"
            )
        responses = data.get("response_types") or ["code"]
        if not isinstance(responses, list) or set(responses) != {"code"}:
            raise OAuthError("invalid_client_metadata", "Only the code response type is supported")
        secret = None if method == "none" else secrets.token_urlsafe(32)
        client = {
            "id": uid("oauth_client_"),
            "name": display_name(data.get("client_name")),
            "redirect_uris": uris,
            "auth_method": method,
            "secret_hash": session_key(secret) if secret else None,
            "document": False,
            "created": now,
            "fetched": None,
            "last_used": now,
        }
        with self.store.transaction():
            self.store.purge_oauth(now, now - IDLE_CLIENT)
            if self.store.count_oauth_clients() >= MAX_CLIENTS:
                raise OAuthError("too_many_requests", "Too many registered apps. Try again later.", 429)
            self.store.put("oauth_client", client["id"], client)
        response = {
            "client_id": client["id"],
            "client_id_issued_at": int(now),
            "redirect_uris": uris,
            "token_endpoint_auth_method": method,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": SCOPE,
        }
        if client["name"]:
            response["client_name"] = client["name"]
        if secret:
            response.update(client_secret=secret, client_secret_expires_at=0)
        return response

    def client(self, client_id):
        """A registered app, or the app a metadata document describes, read again once an hour.

        Documents are only fetched for signed-in people who opened an authorization request.
        """
        if not client_id.startswith("https://"):
            record = self.store.get("oauth_client", client_id)
            if not record or record["document"]:
                raise Problem(
                    "This app is not registered with this Duckpad instance. Remove the connection in the app "
                    "and add it again."
                )
            return record
        if problem := document_problem(client_id):
            raise Problem(problem)
        record = self.store.get("oauth_client", client_id)
        now = time.time()
        if record and now - record["fetched"] < DOCUMENT_TTL:
            return record
        try:
            described = document_client(client_id, self.fetch(client_id))
        except Problem:
            # Keep a recent copy while its publisher is unreachable.
            if record and now - record["fetched"] < DOCUMENT_STALE:
                return record
            raise
        record = {
            "id": client_id,
            **described,
            "auth_method": "none",
            "secret_hash": None,
            "document": True,
            "created": record["created"] if record else now,
            "fetched": now,
            "last_used": now,
        }
        with self.store.transaction():
            self.store.put("oauth_client", client_id, record)
        return record

    def authenticate(self, values, authorization):
        """The app calling the token or revocation endpoint, with its secret when it has one."""
        scheme, _, credentials = authorization.partition(" ")
        if "client_assertion" in values:
            raise OAuthError("invalid_client", "Client assertions are not supported", 401)
        if scheme.lower() == "basic":
            try:
                decoded = base64.b64decode(credentials, validate=True).decode()
            except ValueError:
                raise OAuthError("invalid_client", "Malformed Basic credentials", 401) from None
            client_id, separator, secret = decoded.partition(":")
            client_id, secret = unquote_plus(client_id), unquote_plus(secret)
            if not separator or values.get("client_id", client_id) != client_id or "client_secret" in values:
                raise OAuthError("invalid_client", "Malformed client credentials", 401)
        else:
            client_id, secret = values.get("client_id"), values.get("client_secret")
        client = self.store.get("oauth_client", client_id) if client_id else None
        if not client:
            # Apps that registered dynamically register again on this error.
            raise OAuthError("invalid_client", "Unknown client. Register again.", 401)
        if client["secret_hash"]:
            if secret is None or not hmac.compare_digest(session_key(secret), client["secret_hash"]):
                raise OAuthError("invalid_client", "Invalid client secret", 401)
        elif secret is not None:
            raise OAuthError("invalid_client", "This client has no secret", 401)
        return client

    @staticmethod
    def public_client(client):
        document = client["document"]
        hosts = sorted({host_of(uri) for uri in client["redirect_uris"]})
        return {
            "id": client["id"],
            "name": client["name"] or (host_of(client["id"]) if document else ", ".join(hosts)),
            "document": document,
            "host": host_of(client["id"]) if document else None,
            "redirect_hosts": hosts,
        }

    # Authorization

    def request(self, query, base, user):
        """Check an authorization request for the consent page of a signed-in person.

        Returns the consent details, or `{"redirect"}` to send an error back to the app. Requests
        whose app or redirect URI cannot be trusted raise instead: their errors stay on Duckpad.
        """
        if base is None:
            raise Problem(HTTPS_REQUIRED)
        if user.get("auth_method") == "service":
            raise Problem("Service accounts cannot authorize apps", 403)
        pairs = parse_qsl(query, keep_blank_values=True, max_num_fields=50)
        keys = [key for key, _ in pairs]
        values = dict(pairs)
        for key in ("client_id", "redirect_uri"):
            if keys.count(key) > 1:
                raise Problem(f"This authorization request repeats {key}")
        if not values.get("client_id"):
            raise Problem("This authorization request does not name an app (client_id)")
        client = self.client(values["client_id"])
        redirect = values.get("redirect_uri")
        if redirect is None:
            if len(client["redirect_uris"]) != 1:
                raise Problem("This authorization request needs a redirect_uri")
            redirect = client["redirect_uris"][0]
        elif not any(redirect_matches(uri, redirect) for uri in client["redirect_uris"]):
            raise Problem("This app did not register the address this request returns to (redirect_uri)")
        state = values.get("state")

        def refuse(error, description):
            details = {"error": error, "error_description": description, "state": state, "iss": base}
            return {"redirect": with_query(redirect, details)}

        if len(keys) != len(values):
            return refuse("invalid_request", "A parameter is repeated")
        if values.get("response_type") != "code":
            return refuse("unsupported_response_type", "Only the authorization code flow is supported")
        if "request" in values or "request_uri" in values:
            return refuse("request_not_supported", "Request objects are not supported")
        challenge = values.get("code_challenge", "")
        if values.get("code_challenge_method") != "S256" or not re.fullmatch(r"[A-Za-z0-9_-]{43}", challenge):
            return refuse("invalid_request", "PKCE is required: send an S256 code_challenge")
        if "resource" in values and canonical(values["resource"]) != resource(base):
            return refuse("invalid_target", f"This server only issues tokens for {resource(base)}")
        return {
            "client": self.public_client(client),
            "client_id": client["id"],
            "redirect_uri": redirect,
            # Omitted redirect URIs must stay omitted in the token request.
            "explicit_redirect": "redirect_uri" in values,
            "redirect_host": host_of(redirect),
            "local": urlsplit(redirect).hostname in LOOPBACK,
            "account": user["username"],
            "scope": granted_scope(values.get("scope")),
            "state": state,
            "challenge": challenge,
        }

    @staticmethod
    def consent(checked):
        """What the consent page shows: never the PKCE challenge or the state."""
        if "redirect" in checked:
            return checked
        return {key: checked[key] for key in ("client", "redirect_host", "local", "account", "scope")}

    def decide(self, query, base, user, approve):
        """Record a person's decision and return the redirect that brings it to the app."""
        checked = self.request(query, base, user)
        if "redirect" in checked:
            return checked
        if not approve:
            details = {
                "error": "access_denied",
                "error_description": "The request was declined",
                "state": checked["state"],
                "iss": base,
            }
            return {"redirect": with_query(checked["redirect_uri"], details)}
        code = secrets.token_urlsafe(32)
        now = time.time()
        with self.store.transaction():
            account = self.store.get("user", user["id"])
            if not self.auth.usable(account):
                raise Problem("Authentication required", 401)
            client = self.store.get("oauth_client", checked["client_id"])
            if not client:
                raise Problem("This app is no longer registered. Connect it again from the app.")
            self.store.put("oauth_client", client["id"], {**client, "last_used": now})
            self.store.put(
                "oauth_code",
                session_key(code),
                {
                    "client": client["id"],
                    "user": user["id"],
                    "redirect_uri": checked["redirect_uri"] if checked["explicit_redirect"] else "",
                    "challenge": checked["challenge"],
                    "scope": checked["scope"],
                    "resource": resource(base),
                    "expires": now + CODE_LIFETIME,
                    "grant": None,
                },
            )
        return {
            "redirect": with_query(
                checked["redirect_uri"], {"code": code, "state": checked["state"], "iss": base}
            )
        }

    # Tokens

    def token(self, values, authorization, base):
        """The token endpoint: exchange a code, or rotate a refresh token."""
        if base is None:
            raise OAuthError("invalid_request", HTTPS_REQUIRED)
        client = self.authenticate(values, authorization)
        grant_type = values.get("grant_type")
        if grant_type == "authorization_code":
            return self.exchange(values, client)
        if grant_type == "refresh_token":
            return self.refresh(values, client)
        raise OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token")

    def issue(self, grant, now):
        access = ACCESS_PREFIX + secrets.token_urlsafe(32)
        refresh = REFRESH_PREFIX + secrets.token_urlsafe(32)
        for secret, kind, lifetime in (
            (access, "access", ACCESS_LIFETIME),
            (refresh, "refresh", REFRESH_LIFETIME),
        ):
            self.store.put(
                "oauth_token",
                session_key(secret),
                {"grant": grant["id"], "kind": kind, "expires": now + lifetime, "used": None},
            )
        return {
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": ACCESS_LIFETIME,
            "refresh_token": refresh,
            "scope": grant["scope"],
        }

    @staticmethod
    def check_target(values, expected):
        if "resource" in values and canonical(values["resource"]) != expected:
            raise OAuthError("invalid_target", f"Tokens of this authorization are for {expected}")

    def exchange(self, values, client):
        code, verifier = values.get("code"), values.get("code_verifier")
        if not code or not verifier:
            raise OAuthError("invalid_request", "Send code and code_verifier")
        now = time.time()
        replayed = False
        with self.store.transaction():
            record = self.store.get("oauth_code", session_key(code))
            if not record or record["client"] != client["id"] or record["expires"] <= now:
                raise OAuthError("invalid_grant", "Invalid or expired authorization code")
            if record["grant"] is not None:
                # A replayed code may have leaked: revoke what it produced (RFC 6749, section 4.1.2).
                self.store.delete("oauth_grant", record["grant"])
                replayed = True
            else:
                expected = record["redirect_uri"]
                if expected and values.get("redirect_uri") != expected:
                    raise OAuthError("invalid_grant", "redirect_uri does not match the authorization request")
                if (
                    not expected
                    and values.get("redirect_uri", client["redirect_uris"][0]) not in client["redirect_uris"]
                ):
                    raise OAuthError("invalid_grant", "redirect_uri does not match the authorization request")
                if not pkce_matches(verifier, record["challenge"]):
                    raise OAuthError("invalid_grant", "PKCE verification failed")
                self.check_target(values, record["resource"])
                if not self.auth.usable(self.store.get("user", record["user"])):
                    raise OAuthError("invalid_grant", "The account is no longer active")
                # Authorizing an app again replaces its previous authorization for this account.
                self.store.delete_oauth_grants(record["user"], client["id"])
                grant = {
                    "id": uid("oauth_grant_"),
                    "user": record["user"],
                    "client": client["id"],
                    "scope": record["scope"],
                    "resource": record["resource"],
                    "created": now,
                    "last_used": None,
                    "expires": now + REFRESH_LIFETIME,
                }
                self.store.put("oauth_grant", grant["id"], grant)
                self.store.put("oauth_code", session_key(code), {**record, "grant": grant["id"]})
                self.store.put("oauth_client", client["id"], {**client, "last_used": now})
                tokens = self.issue(grant, now)
                self.store.purge_oauth(now, now - IDLE_CLIENT)
        if replayed:
            raise OAuthError(
                "invalid_grant", "This authorization code was already used; its tokens are revoked"
            )
        return tokens

    def refresh(self, values, client):
        secret = values.get("refresh_token")
        if not secret:
            raise OAuthError("invalid_request", "Send refresh_token")
        now = time.time()
        replayed = False
        with self.store.transaction():
            token = self.store.get("oauth_token", session_key(secret))
            grant = (
                self.store.get("oauth_grant", token["grant"])
                if token and token["kind"] == "refresh"
                else None
            )
            if not grant or grant["client"] != client["id"]:
                raise OAuthError("invalid_grant", "Invalid refresh token")
            if token["used"] is not None:
                if now - token["used"] <= REUSE_LEEWAY:
                    raise OAuthError("invalid_grant", "This refresh token was just rotated")
                # Rotation means a used token in other hands: revoke the whole authorization.
                self.store.delete("oauth_grant", grant["id"])
                replayed = True
            else:
                if token["expires"] <= now or grant["expires"] <= now:
                    raise OAuthError("invalid_grant", "The authorization expired. Connect the app again.")
                if not set(values.get("scope", grant["scope"]).split()) <= set(grant["scope"].split()):
                    raise OAuthError("invalid_scope", "A refresh cannot add scopes")
                self.check_target(values, grant["resource"])
                if not self.auth.usable(self.store.get("user", grant["user"])):
                    raise OAuthError("invalid_grant", "The account is no longer active")
                self.store.put("oauth_token", token["id"], {**token, "used": now})
                grant = {**grant, "expires": now + REFRESH_LIFETIME, "last_used": now}
                self.store.put("oauth_grant", grant["id"], grant)
                tokens = self.issue(grant, now)
        if replayed:
            raise OAuthError(
                "invalid_grant", "This refresh token was already used; the authorization is revoked"
            )
        return tokens

    def revoke(self, values, authorization):
        """RFC 7009: revoking any token of an authorization revokes the whole authorization."""
        client = self.authenticate(values, authorization)
        secret = values.get("token")
        if not secret:
            raise OAuthError("invalid_request", "Send token")
        with self.store.transaction():
            token = self.store.get("oauth_token", session_key(secret))
            grant = self.store.get("oauth_grant", token["grant"]) if token else None
            if grant and grant["client"] == client["id"]:
                self.store.delete("oauth_grant", grant["id"])

    # Authorized apps of an account

    def grants(self, actor, identity):
        self.auth.token_account(actor, identity)
        now = time.time()
        result = []
        for grant in self.store.oauth_grants(identity):
            client = self.store.get("oauth_client", grant["client"])
            if grant["expires"] > now and client:
                result.append(
                    {
                        "id": grant["id"],
                        "client": self.public_client(client),
                        **{key: grant[key] for key in ("scope", "created", "last_used", "expires")},
                    }
                )
        return result

    def revoke_grant(self, actor, identity, grant_id):
        with self.store.transaction():
            self.auth.token_account(actor, identity)
            grant = self.store.get("oauth_grant", grant_id)
            if not grant or grant["user"] != identity:
                raise Problem("Authorized app not found", 404)
            self.store.delete("oauth_grant", grant_id)
