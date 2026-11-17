"""OAuth 2.1 for web MCP connectors: discovery, consent, tokens, rotation, revocation and refusals."""

import asyncio
import base64
import hashlib
import secrets
import socket
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient
from mcp import ClientSession
from mcp.client.auth import OAuthClientProvider
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import OAuthClientMetadata
from test_mcp import approve, served

from duckpad import oauth
from duckpad.app import create_app
from duckpad.util import Problem

BASE = "https://duckpad.test"
MCP = BASE + "/api/agent/mcp"
REDIRECT = "https://app.test/callback"
LISTING = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
ACCEPT = {"Accept": "application/json, text/event-stream"}


def signed_in(app, base, username, password):
    browser = TestClient(app, base_url=base)
    assert browser.post("/api/login", json={"username": username, "password": password}).status_code == 200
    return browser


@pytest.fixture
def instance(tmp_path):
    app = create_app(tmp_path / "instance", watch=False, trusted_local=True)
    with TestClient(app, base_url=BASE) as admin:
        assert (
            admin.post(
                "/api/login", json={"username": "admin", "password": app.state.auth.initial_password}
            ).status_code
            == 200
        )
        tree = admin.post("/api/projects", json={"name": "Connector test"}).json()
        actor = app.state.auth.create_user("agent", "agent-test-password")
        app.state.access.member(tree["project"], actor["id"], "editor")
        person = signed_in(app, BASE, "agent", "agent-test-password")
        yield app, admin, tree, actor, person


def register(client, **metadata):
    response = client.post(
        "/api/oauth/register",
        json={
            "client_name": "Test app",
            "redirect_uris": [REDIRECT],
            "token_endpoint_auth_method": "none",
            **metadata,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def pkce():
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode()).digest()
    return verifier, base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def request_query(client_id, challenge, **params):
    values = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": "state-1",
        "resource": MCP,
        "scope": "agent",
        **params,
    }
    return urlencode({key: value for key, value in values.items() if value is not None})


def decide(browser, query, approve=True):
    response = browser.post("/api/oauth/authorization", json={"query": query, "approve": approve})
    assert response.status_code == 200, response.text
    redirect = response.json()["redirect"]
    return redirect, {key: values[0] for key, values in parse_qs(urlsplit(redirect).query).items()}


def authorize(browser, client_id, **params):
    """Approve on the consent page; return the code, its PKCE verifier and the consent details."""
    verifier, challenge = pkce()
    query = request_query(client_id, challenge, **params)
    consent = browser.get("/api/oauth/authorization?" + query)
    assert consent.status_code == 200, consent.text
    _, answer = decide(browser, query)
    assert (answer["state"], answer["iss"]) == ("state-1", BASE)
    return answer["code"], verifier, consent.json()


def token(client, **data):
    return client.post("/api/oauth/token", data=data)


def connect(browser, client_id, **params):
    code, verifier, _ = authorize(browser, client_id, **params)
    response = token(
        browser,
        grant_type="authorization_code",
        code=code,
        code_verifier=verifier,
        client_id=client_id,
        redirect_uri=REDIRECT,
        resource=MCP,
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def tools(client, access, tool="list_projects", /, **arguments):
    return client.post(
        "/api/agent/tools/" + tool, headers={"Authorization": "Bearer " + access}, json=arguments
    )


def refresh(client, client_id, refresh_token, **data):
    return token(client, grant_type="refresh_token", refresh_token=refresh_token, client_id=client_id, **data)


def test_discovery_documents_and_challenges(instance, monkeypatch):
    app, *_ = instance
    anonymous = TestClient(app, base_url=BASE)
    refused = anonymous.post("/api/agent/mcp", json=LISTING, headers=ACCEPT)
    assert refused.status_code == 401
    metadata = BASE + "/.well-known/oauth-protected-resource/api/agent/mcp"
    assert refused.headers["www-authenticate"] == f'Bearer resource_metadata="{metadata}", scope="agent"'
    invalid = anonymous.post(
        "/api/agent/mcp", json=LISTING, headers={**ACCEPT, "Authorization": "Bearer dpo_unknown"}
    )
    assert invalid.status_code == 401
    assert invalid.headers["www-authenticate"].startswith('Bearer error="invalid_token", resource_metadata=')
    for path in (
        "/.well-known/oauth-protected-resource/api/agent/mcp",
        "/.well-known/oauth-protected-resource",
    ):
        document = anonymous.get(path)
        assert document.headers["cache-control"] == "no-store"
        assert document.json() == {
            "resource": MCP,
            "authorization_servers": [BASE],
            "scopes_supported": ["agent"],
            "bearer_methods_supported": ["header"],
            "resource_name": "Duckpad",
        }
    server = anonymous.get("/.well-known/oauth-authorization-server").json()
    assert server["issuer"] == BASE
    assert server["authorization_endpoint"] == BASE + "/oauth/authorize"
    assert server["token_endpoint"] == BASE + "/api/oauth/token"
    assert server["registration_endpoint"] == BASE + "/api/oauth/register"
    assert server["code_challenge_methods_supported"] == ["S256"]
    assert server["client_id_metadata_document_supported"] is True
    assert server["authorization_response_iss_parameter_supported"] is True
    assert "none" in server["token_endpoint_auth_methods_supported"]
    # Other discovery documents do not exist, rather than answering with the interface.
    assert anonymous.get("/.well-known/openid-configuration").status_code == 404

    # OAuth needs HTTPS outside loopback: no discovery, and 401s do not point to it.
    plain = TestClient(app, base_url="http://duckpad.test")
    unavailable = plain.get("/.well-known/oauth-authorization-server")
    assert unavailable.status_code == 404
    assert "HTTPS" in unavailable.json()["error_description"]
    assert plain.post("/api/agent/mcp", json=LISTING, headers=ACCEPT).headers["www-authenticate"] == "Bearer"
    assert plain.post("/api/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code == 400
    local = TestClient(app, base_url="http://127.0.0.1:8765")
    assert local.get("/.well-known/oauth-authorization-server").json()["issuer"] == "http://127.0.0.1:8765"
    # A TLS proxy can also be declared; the host is normalized as clients canonicalize it.
    monkeypatch.setenv("DUCKPAD_SECURE_COOKIES", "1")
    proxied = plain.get("/.well-known/oauth-protected-resource", headers={"Host": "Duckpad.TEST:443"}).json()
    assert proxied["resource"] == MCP
    assert plain.get("/.well-known/oauth-protected-resource", headers={"Host": "bad/host"}).status_code == 404


def test_mcp_client_signs_in_with_oauth_and_runs_after_approval(instance):
    """An OAuth-compliant MCP client connects with only the endpoint URL."""
    app, admin, tree, actor, _ = instance
    with served(app) as address:
        endpoint = address + "/api/agent/mcp"
        person = signed_in(app, address, "agent", "agent-test-password")
        answer = {}

        async def redirect(url):
            parts = urlsplit(url)
            assert f"{parts.scheme}://{parts.netloc}{parts.path}" == address + "/oauth/authorize"
            consent = person.get("/api/oauth/authorization?" + parts.query)
            assert consent.status_code == 200, consent.text
            details = consent.json()
            assert details["client"]["name"] == "Test agent"
            assert (details["account"], details["redirect_host"], details["local"]) == (
                "agent",
                "127.0.0.1:9",
                True,
            )
            decision = person.post("/api/oauth/authorization", json={"query": parts.query, "approve": True})
            answer.update(parse_qs(urlsplit(decision.json()["redirect"]).query))

        async def callback():
            return answer["code"][0], answer["state"][0]

        class Memory:
            tokens = client = None

            async def get_tokens(self):
                return self.tokens

            async def set_tokens(self, tokens):
                self.tokens = tokens

            async def get_client_info(self):
                return self.client

            async def set_client_info(self, client):
                self.client = client

        storage = Memory()
        provider = OAuthClientProvider(
            endpoint,
            OAuthClientMetadata(client_name="Test agent", redirect_uris=["http://127.0.0.1:9/callback"]),
            storage,
            redirect,
            callback,
        )

        async def workflow():
            async with (
                httpx.AsyncClient(auth=provider, timeout=30) as client,
                streamable_http_client(endpoint, http_client=client) as (read, write, _),
                ClientSession(read, write) as session,
            ):
                await session.initialize()
                assert "request_run" in {t.name for t in (await session.list_tools()).tools}

                async def tool(name, /, **arguments):
                    value = await session.call_tool(name, {"worktree": tree["id"], **arguments})
                    assert not value.isError, value
                    return value.structuredContent["result"]

                assert (await tool("list_projects"))["items"][0]["id"] == tree["project"]
                revision = (await tool("validate_project"))["revision"]
                await tool(
                    "edit_flow",
                    revision=revision,
                    nodes=[
                        {"operation": "add", "id": "answer", "sql": "-- @output result\nSELECT 42 AS value;"}
                    ],
                )
                pending = await tool("request_run")
                # The token is bound to this origin, so the app gets a link it can show.
                assert pending["review_url"] == address + pending["review_path"]
                # Approvals stay human: the app's token cannot open the review page.
                review = await client.get(address + pending["review_path"])
                assert review.status_code == 403
                approve(admin, pending)
                run = await tool("launch_approved_run", approval=pending["id"])
                assert (await tool("wait_for_run", run=run["id"], seconds=10))["status"] == "success"
                return run

        run = asyncio.run(workflow())
        assert answer["iss"] == [address]
        assert storage.client.client_secret, "the SDK registered a confidential client"
        assert storage.tokens.refresh_token.startswith("dpr_")
        record = app.state.services.store.get("run", run["id"])
        assert record["requester"]["username"] == actor["username"]
        assert record["requester"]["token_name"] == "Test agent"


def test_app_tokens_only_open_the_agent_api_of_their_origin(instance):
    app, _, tree, _, person = instance
    client = register(person)
    tokens = connect(person, client["client_id"])
    assert tokens["token_type"] == "Bearer" and tokens["scope"] == "agent"
    assert tokens["access_token"].startswith("dpo_") and tokens["expires_in"] == 3600
    api = TestClient(app, base_url=BASE)
    assert tools(api, tokens["access_token"]).json()["ok"]
    bearer = {"Authorization": "Bearer " + tokens["access_token"]}
    listing = api.post("/api/agent/mcp", json=LISTING, headers={**ACCEPT, **bearer})
    assert listing.status_code == 200, listing.text
    for method, path in (
        ("GET", "/api/session"),
        ("GET", "/api/workspace"),
        ("GET", "/api/api-tokens"),
        ("POST", "/api/api-tokens"),
        ("GET", "/api/oauth/apps"),
        ("POST", f"/api/worktrees/{tree['id']}/runs"),
        ("GET", "/api/v1/jobs"),
        ("GET", "/api/missing"),
    ):
        response = api.request(method, path, headers=bearer, json=None if method == "GET" else {})
        assert response.status_code == 403, (method, path, response.text)
        assert "agent API" in response.json()["error"]
    # Bound to this origin's resource (RFC 8707): another address of the instance refuses it.
    elsewhere = TestClient(app, base_url="https://other.test")
    assert tools(elsewhere, tokens["access_token"]).status_code == 401
    plain = TestClient(app, base_url="http://duckpad.test")
    assert tools(plain, tokens["access_token"]).status_code == 401
    # The token keeps the account's current roles.
    app.state.access.member(tree["project"], app.state.services.store.find_user("agent")["id"], "reader")
    refused = tools(api, tokens["access_token"], "create_branch", worktree=tree["id"], name="agent/x").json()
    assert refused["error"]["status"] == 403
    # Requesting a token for another resource is refused.
    code, verifier, _ = authorize(person, client["client_id"])
    target = token(
        person,
        grant_type="authorization_code",
        code=code,
        code_verifier=verifier,
        client_id=client["client_id"],
        redirect_uri=REDIRECT,
        resource="https://other.test/api/agent/mcp",
    )
    assert (target.status_code, target.json()["error"]) == (400, "invalid_target")


def test_refresh_rotates_and_a_replay_revokes_the_authorization(instance, monkeypatch):
    _, _, tree, _, person = instance
    client = register(person, scope="agent offline_access")
    first = connect(person, client["client_id"], scope="agent offline_access")
    assert first["scope"] == "agent offline_access"
    request = tools(person, first["access_token"], "request_run", worktree=tree["id"]).json()["result"]
    second = refresh(person, client["client_id"], first["refresh_token"], resource=MCP)
    assert second.status_code == 200, second.text
    second = second.json()
    assert second["refresh_token"] != first["refresh_token"]
    assert second["access_token"] != first["access_token"]
    # Approvals follow the app's authorization, not each hourly access token.
    reread = tools(person, second["access_token"], "read_approval", approval=request["id"]).json()
    assert reread["ok"], reread
    # Concurrent refreshes do not revoke the authorization...
    raced = refresh(person, client["client_id"], first["refresh_token"])
    assert (raced.status_code, raced.json()["error"]) == (400, "invalid_grant")
    assert tools(person, second["access_token"]).json()["ok"]
    # ...a later replay of a rotated token does.
    monkeypatch.setattr(oauth, "REUSE_LEEWAY", -1)
    replayed = refresh(person, client["client_id"], first["refresh_token"])
    assert (replayed.status_code, replayed.json()["error"]) == (400, "invalid_grant")
    assert "revoked" in replayed.json()["error_description"]
    assert tools(person, second["access_token"]).status_code == 401
    assert refresh(person, client["client_id"], second["refresh_token"]).json()["error"] == "invalid_grant"
    # Scopes cannot grow on refresh, and another app cannot use the token.
    third = connect(person, client["client_id"])
    assert refresh(person, client["client_id"], third["refresh_token"], scope="admin").json()["error"] == (
        "invalid_scope"
    )
    other = register(person)
    assert refresh(person, other["client_id"], third["refresh_token"]).json()["error"] == "invalid_grant"


def test_codes_are_single_use_short_lived_and_bound_to_pkce(instance, monkeypatch):
    *_, person = instance
    client = register(person)
    client_id = client["client_id"]
    code, verifier, consent = authorize(person, client_id)
    assert consent == {
        "client": {
            "id": client_id,
            "name": "Test app",
            "document": False,
            "host": None,
            "redirect_hosts": ["app.test"],
        },
        "redirect_host": "app.test",
        "local": False,
        "account": "agent",
        "scope": "agent",
    }
    exchange = {"grant_type": "authorization_code", "client_id": client_id, "redirect_uri": REDIRECT}
    wrong = token(person, **exchange, code=code, code_verifier=pkce()[0])
    assert (wrong.status_code, wrong.json()["error"]) == (400, "invalid_grant")
    elsewhere = token(
        person, **{**exchange, "redirect_uri": REDIRECT + "/other"}, code=code, code_verifier=verifier
    )
    assert elsewhere.json()["error"] == "invalid_grant"
    first = token(person, **exchange, code=code, code_verifier=verifier)
    assert first.status_code == 200
    replay = token(person, **exchange, code=code, code_verifier=verifier)
    assert (replay.status_code, replay.json()["error"]) == (400, "invalid_grant")
    # A replayed code revokes the tokens it produced.
    assert tools(person, first.json()["access_token"]).status_code == 401
    monkeypatch.setattr(oauth, "CODE_LIFETIME", -1)
    late, late_verifier, _ = authorize(person, client_id)
    assert (
        token(person, **exchange, code=late, code_verifier=late_verifier).json()["error"] == "invalid_grant"
    )
    monkeypatch.undo()
    other = register(person)
    code, verifier, _ = authorize(person, client_id)
    stolen = token(person, **{**exchange, "client_id": other["client_id"]}, code=code, code_verifier=verifier)
    assert stolen.json()["error"] == "invalid_grant"

    _, challenge = pkce()
    # Requests that cannot be trusted stay on Duckpad.
    for params, message in (
        ({"client_id": "oauth_client_unknown"}, "not registered"),
        ({"redirect_uri": "https://attacker.test/callback"}, "did not register"),
        ({"redirect_uri": None}, None),
    ):
        response = person.get(
            "/api/oauth/authorization?"
            + request_query(params.pop("client_id", client_id), challenge, **params)
        )
        if message is None:
            # A single registered redirect URI may be omitted.
            assert response.status_code == 200
        else:
            assert response.status_code == 400 and message in response.json()["error"], response.text
    # Protocol errors return to the app, with its state and this issuer (RFC 9207).
    for params, error in (
        ({"code_challenge": None}, "invalid_request"),
        ({"code_challenge_method": "plain"}, "invalid_request"),
        ({"code_challenge": "short"}, "invalid_request"),
        ({"response_type": "token"}, "unsupported_response_type"),
        ({"resource": "https://other.test/api/agent/mcp"}, "invalid_target"),
    ):
        query = request_query(client_id, challenge, **params)
        checked = person.get("/api/oauth/authorization?" + query).json()
        answer = parse_qs(urlsplit(checked["redirect"]).query)
        assert checked["redirect"].startswith(REDIRECT + "?")
        assert (answer["error"], answer["state"], answer["iss"]) == ([error], ["state-1"], [BASE])
    repeated = request_query(client_id, challenge) + "&scope=agent"
    checked = person.get("/api/oauth/authorization?" + repeated).json()
    assert parse_qs(urlsplit(checked["redirect"]).query)["error"] == ["invalid_request"]
    assert parse_qs(urlsplit(decide(person, repeated)[0]).query)["error"] == ["invalid_request"]
    _, answer = decide(person, request_query(client_id, challenge), approve=False)
    assert (answer["error"], answer["state"], answer["iss"]) == ("access_denied", "state-1", BASE)


def test_registration_and_client_authentication(instance, monkeypatch):
    app, _, _, _, person = instance
    anonymous = TestClient(app, base_url=BASE)
    for uris in (
        ["http://app.test/callback"],
        ["javascript:alert(1)"],
        ["cursor://anysphere/callback"],
        ["https://app.test/callback#fragment"],
        ["https://user@app.test/callback"],
        [],
        "https://app.test/callback",
    ):
        response = anonymous.post("/api/oauth/register", json={"redirect_uris": uris})
        assert (response.status_code, response.json()["error"]) == (400, "invalid_redirect_uri"), uris
    for metadata in (
        {"grant_types": ["client_credentials"]},
        {"response_types": ["token"]},
        {"token_endpoint_auth_method": "private_key_jwt"},
    ):
        response = anonymous.post("/api/oauth/register", json={"redirect_uris": [REDIRECT], **metadata})
        assert response.json()["error"] == "invalid_client_metadata", metadata
    # Confidential clients (the RFC 7591 default) receive a secret and must present it.
    confidential = anonymous.post(
        "/api/oauth/register", json={"redirect_uris": [REDIRECT], "client_name": "  Spaced‮  name\n"}
    ).json()
    assert confidential["token_endpoint_auth_method"] == "client_secret_basic"
    assert confidential["client_name"] == "Spaced name"
    assert confidential["client_secret_expires_at"] == 0
    client_id, secret = confidential["client_id"], confidential["client_secret"]
    code, verifier, _ = authorize(person, client_id)
    exchange = {"grant_type": "authorization_code", "code": code, "code_verifier": verifier}
    missing = token(anonymous, **exchange, client_id=client_id, redirect_uri=REDIRECT)
    assert (missing.status_code, missing.json()["error"]) == (401, "invalid_client")
    wrong = anonymous.post(
        "/api/oauth/token", data={**exchange, "redirect_uri": REDIRECT}, auth=(client_id, "wrong-secret")
    )
    assert wrong.status_code == 401 and wrong.headers["www-authenticate"].startswith("Basic")
    basic = anonymous.post(
        "/api/oauth/token", data={**exchange, "redirect_uri": REDIRECT}, auth=(client_id, secret)
    )
    assert basic.status_code == 200, basic.text
    posted = refresh(anonymous, client_id, basic.json()["refresh_token"], client_secret=secret)
    assert posted.status_code == 200, posted.text
    # Public clients have no secret to present; unknown clients register again.
    public = register(anonymous)
    assert "client_secret" not in public
    assert (
        refresh(anonymous, public["client_id"], "dpr_x", client_secret="x").json()["error"]
        == "invalid_client"
    )
    assert refresh(anonymous, "oauth_client_unknown", "dpr_x").json()["error"] == "invalid_client"
    assert anonymous.post("/api/oauth/token", json={"grant_type": "refresh_token"}).json()["error"] == (
        "invalid_request"
    )
    assert token(anonymous, grant_type="password", client_id=public["client_id"]).json()["error"] == (
        "unsupported_grant_type"
    )
    # Loopback redirects may use any port (RFC 8252), on the registered host only.
    native = register(anonymous, redirect_uris=["http://127.0.0.1/callback"])
    _, challenge = pkce()
    for redirect, status in (
        ("http://127.0.0.1:53682/callback", 200),
        ("http://localhost:53682/callback", 400),
    ):
        query = request_query(native["client_id"], challenge, redirect_uri=redirect)
        assert person.get("/api/oauth/authorization?" + query).status_code == status, redirect
    monkeypatch.setattr(oauth, "REGISTRATIONS", 0)
    limited = anonymous.post("/api/oauth/register", json={"redirect_uris": [REDIRECT]})
    assert limited.status_code == 429


def test_authorized_apps_are_listed_and_revoked(instance):
    app, admin, _, actor, person = instance
    anonymous = TestClient(app, base_url=BASE)
    client = register(person)
    tokens = connect(person, client["client_id"])
    apps = person.get("/api/oauth/apps").json()
    assert [(a["client"]["name"], a["scope"]) for a in apps] == [("Test app", "agent")]
    assert apps[0]["last_used"] is None
    assert tools(person, tokens["access_token"]).status_code == 200
    assert person.get("/api/oauth/apps").json()[0]["last_used"] is not None
    assert admin.get(f"/api/users/{actor['id']}/oauth/apps").json()[0]["id"] == apps[0]["id"]
    # Authorizing the same app again replaces its authorization.
    again = connect(person, client["client_id"])
    assert len(person.get("/api/oauth/apps").json()) == 1
    assert tools(person, tokens["access_token"]).status_code == 401
    current = person.get("/api/oauth/apps").json()[0]["id"]
    assert admin.delete(f"/api/oauth/apps/{current}").status_code == 404
    assert person.delete(f"/api/oauth/apps/{current}").json() == {"ok": True}
    assert tools(person, again["access_token"]).status_code == 401
    assert refresh(person, client["client_id"], again["refresh_token"]).json()["error"] == "invalid_grant"
    # An administrator can revoke a person's apps; RFC 7009 revocation by the app works too.
    tokens = connect(person, client["client_id"])
    grant = person.get("/api/oauth/apps").json()[0]["id"]
    assert admin.delete(f"/api/users/{actor['id']}/oauth/apps/{grant}").json() == {"ok": True}
    assert tools(person, tokens["access_token"]).status_code == 401
    tokens = connect(person, client["client_id"])
    revoked = anonymous.post(
        "/api/oauth/revoke", data={"token": tokens["refresh_token"], "client_id": client["client_id"]}
    )
    assert (revoked.status_code, revoked.json()) == (200, {})
    assert tools(person, tokens["access_token"]).status_code == 401
    # Deactivation revokes them for good.
    tokens = connect(person, client["client_id"])
    assert admin.patch(f"/api/users/{actor['id']}", json={"active": False}).status_code == 200
    assert tools(person, tokens["access_token"]).status_code == 401
    assert admin.patch(f"/api/users/{actor['id']}", json={"active": True}).status_code == 200
    assert tools(person, tokens["access_token"]).status_code == 401
    assert admin.get(f"/api/users/{actor['id']}/oauth/apps").json() == []
    # Only a signed-in person, never a token, reviews and authorizes apps.
    _, challenge = pkce()
    query = request_query(client["client_id"], challenge)
    assert anonymous.get("/api/oauth/authorization?" + query).status_code == 401
    api_token = app.state.auth.create_api_token(actor, actor["id"], "Agent")["token"]
    bearer = {"Authorization": "Bearer " + api_token}
    for method, path in (("GET", "/api/oauth/authorization?" + query), ("GET", "/api/oauth/apps")):
        assert anonymous.request(method, path, headers=bearer).status_code == 403


def test_client_metadata_documents(instance, monkeypatch):
    app, _, _, _, person = instance
    url = "https://app.test/oauth/client.json"
    documents = {
        url: {
            "client_id": url,
            "client_name": "Document app",
            "redirect_uris": [REDIRECT],
            "token_endpoint_auth_method": "private_key_jwt",
            "token_endpoint_auth_methods_supported": ["none", "private_key_jwt"],
            "grant_types": ["authorization_code", "refresh_token"],
        }
    }
    fetched = []

    def fetch(address):
        fetched.append(address)
        if address not in documents:
            raise Problem("Could not read the app's metadata document")
        return documents[address]

    app.state.oauth.fetch = fetch
    code, verifier, consent = authorize(person, url)
    assert consent["client"] == {
        "id": url,
        "name": "Document app",
        "document": True,
        "host": "app.test",
        "redirect_hosts": ["app.test"],
    }
    assert fetched == [url]
    tokens = token(
        person,
        grant_type="authorization_code",
        code=code,
        code_verifier=verifier,
        client_id=url,
        redirect_uri=REDIRECT,
    )
    assert tokens.status_code == 200, tokens.text
    assert refresh(person, url, tokens.json()["refresh_token"]).status_code == 200
    # The cached copy is reused within the hour, and while the publisher is briefly unreachable.
    monkeypatch.setattr(oauth, "DOCUMENT_TTL", -1)
    del documents[url]
    authorize(person, url)
    assert len(fetched) == 3

    _, challenge = pkce()
    for document, message in (
        ({"client_id": "https://other.test/client.json", "redirect_uris": [REDIRECT]}, "own address"),
        (
            {
                "client_id": "https://app.test/jwt.json",
                "redirect_uris": [REDIRECT],
                "token_endpoint_auth_method": "private_key_jwt",
            },
            "key or a secret",
        ),
        (
            {"client_id": "https://app.test/http.json", "redirect_uris": ["http://app.test/callback"]},
            "redirect URI",
        ),
    ):
        address = (
            document["client_id"]
            if "other.test" not in document["client_id"]
            else "https://app.test/mismatch.json"
        )
        documents[address] = document
        response = person.get("/api/oauth/authorization?" + request_query(address, challenge))
        assert response.status_code == 400 and message in response.json()["error"], response.text
    for invalid in (
        "https://app.test",
        "https://app.test/",
        "https://app.test:8443/client.json",
        "https://app.test/client.json?version=1",
        "https://app.test/a/../client.json",
        "https://app.test/a/%2E%2E/client.json",
        "https://192.0.2.1/client.json",
        "http://app.test/client.json",
    ):
        assert oauth.document_problem(invalid), invalid
    assert oauth.document_problem(url) is None


@pytest.mark.parametrize(
    "address", ["10.0.0.1", "127.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fd00::1"]
)
def test_metadata_documents_are_only_read_from_public_addresses(monkeypatch, address):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    monkeypatch.setattr(
        socket, "getaddrinfo", lambda *args, **kwargs: [(family, socket.SOCK_STREAM, 6, "", (address, 443))]
    )
    connections = []
    monkeypatch.setattr(socket, "create_connection", lambda *args, **kwargs: connections.append(args))
    with pytest.raises(Problem, match="public address"):
        oauth.fetch_document("https://app.test/client.json")
    assert connections == []


def test_uri_helpers():
    assert oauth.canonical("HTTPS://Duckpad.TEST:443/api/agent/mcp/") == MCP
    assert (
        oauth.canonical("https://duckpad.test:8443/api/agent/mcp")
        == "https://duckpad.test:8443/api/agent/mcp"
    )
    assert oauth.canonical("https://duckpad.test/api/agent/mcp#x") is None
    assert oauth.redirect_matches("http://localhost/cb", "http://localhost:4242/cb")
    assert not oauth.redirect_matches("http://localhost/cb", "http://localhost:4242/other")
    assert not oauth.redirect_matches("https://app.test/cb", "https://app.test:8443/cb")
    assert oauth.with_query("https://app.test/cb?tenant=1", {"code": "c", "state": None}) == (
        "https://app.test/cb?tenant=1&code=c"
    )
    assert oauth.with_query("https://app.test/cb?", {"code": "c"}) == "https://app.test/cb?code=c"
