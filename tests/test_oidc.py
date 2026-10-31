"""OIDC protocol, privilege boundaries, durable accounts and recovery."""

import logging
import time
from urllib.parse import parse_qs, urlsplit

import httpx2
import pytest
from fastapi.testclient import TestClient
from joserfc.jwk import OctKey, RSAKey
from oidc_provider import Provider

import duckpad.oidc as oidc_module
from duckpad.app import create_app
from duckpad.auth import Auth, session_key
from duckpad.git.identity import account_identity
from duckpad.logging import PollingAccessFilter
from duckpad.store import Store
from duckpad.util import Problem


@pytest.fixture
def instance(tmp_path, monkeypatch):
    provider = Provider()
    transport = httpx2.MockTransport(provider.handle)
    oauth_client = oidc_module.OAuth2Client
    monkeypatch.setattr(
        oidc_module,
        "OAuth2Client",
        lambda *args, **kwargs: oauth_client(*args, transport=transport, **kwargs),
    )

    def get_json(url):
        with httpx2.Client(transport=transport) as client:
            response = client.get(url)
            response.raise_for_status()
            return response.json()

    monkeypatch.setattr(oidc_module.OIDC, "get_json", staticmethod(get_json))
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app, base_url="https://duckpad.example.com") as client:
        password = app.state.auth.initial_password
        assert client.post("/api/login", json={"password": password}).status_code == 200
        yield app, client, provider, password


def configure(client, **changes):
    return client.put(
        "/api/sso",
        json={
            "enabled": True,
            "label": "Test SSO",
            "issuer": "https://identity.example.com",
            "client_id": "test-client",
            "client_secret": "test-secret",
            "public_url": "https://duckpad.example.com",
            "allow_signup": True,
            **changes,
        },
    )


def start(client, provider):
    response = client.get("/api/oidc/login", follow_redirects=False)
    assert response.status_code == 303
    url = response.headers["location"]
    params = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
    assert params["response_type"] == "code"
    assert params["scope"] == "openid profile email"
    provider.handle(httpx2.Request("GET", url))
    code = next(reversed(provider.codes))
    return {"state": params["state"], "code": code, "iss": provider.issuer}


def complete(client, provider):
    params = start(client, provider)
    return client.get("/api/oidc/callback", params=params, follow_redirects=False)


def test_real_signed_flow_creates_member_and_preserves_identity(instance):
    app, client, provider, password = instance
    private = client.post("/api/projects", json={"name": "Private project"}).json()
    assert configure(client).status_code == 200
    assert "test-secret" not in client.get("/api/sso").text
    assert client.get("/api/sso").json()["has_secret"]
    client.post("/api/logout")
    assert client.get("/api/oidc/provider").json() == {"label": "Test SSO"}
    response = complete(client, provider)
    assert response.headers["location"] == "/"
    assert "HttpOnly" in response.headers["set-cookie"] and "Secure" in response.headers["set-cookie"]
    user = client.get("/api/session").json()
    assert user["role"] == "member" and user["auth_method"] == "oidc" and user["id"] != "admin"
    assert client.get("/api/workspace").json()["projects"] == []
    assert client.get(f"/api/worktrees/{private['id']}").status_code == 404
    assert client.get("/api/sso").status_code == configure(client).status_code == 403
    assert (
        client.post("/api/password", json={"current": "", "password": "new-password-123"}).status_code == 400
    )
    assert (
        client.post("/api/login", json={"username": user["username"], "password": password}).status_code
        == 401
    )
    assert len(app.state.auth.store.all("user")) == 2
    token = client.cookies.get("duckpad_session")
    client.post("/api/logout")
    assert client.get("/api/session", headers={"authorization": "Bearer " + token}).status_code == 401
    provider.claims = {"preferred_username": "renamed", "email": "different@example.com", "role": "admin"}
    assert complete(client, provider).headers["location"] == "/"
    assert client.get("/api/session").json() == user
    assert len(app.state.auth.store.all("user")) == 2
    assert "test-access-token" not in str(app.state.auth.store.items("session"))


@pytest.mark.parametrize(
    ("claims", "name", "email"),
    [
        (
            {"name": "Alex Example", "email": "alex@example.com", "email_verified": True},
            "Alex Example",
            "alex@example.com",
        ),
        ({"name": "Alex", "email": "admin@example.com", "email_verified": False}, "Alex", None),
        ({"email": "admin@example.com", "email_verified": "true"}, "admin", None),
        (
            {"name": "Alex\n<Example>\x1f", "email": "bad\n@example.com", "email_verified": True},
            "Alex Example",
            None,
        ),
        ({"name": [], "preferred_username": None, "email": {}, "email_verified": True}, None, None),
    ],
)
def test_verified_sso_profile_drives_commit_identity_and_refreshes(instance, claims, name, email):
    app, client, provider, _ = instance
    configure(client)
    client.post("/api/logout")
    provider.claims = claims
    assert complete(client, provider).headers["location"] == "/"
    user = client.get("/api/session").json()
    worktree = client.post("/api/projects", json={"name": "SSO project"}).json()
    projects = app.state.services.projects
    expected = {"name": name or user["username"], "email": email or account_identity(user)["email"]}
    fields = projects.git(worktree["path"], "show", "-s", "--format=%an%n%ae%n%cn%n%ce").splitlines()
    assert fields == [expected["name"], expected["email"]] * 2
    # Metadata survives reloading auth and is not exposed in the account directory.
    assert Auth(app.state.auth.store).commit_identity(user) == expected
    assert "commit_identity" not in user
    original = projects.snapshot(worktree["id"])["commit"]
    client.post("/api/logout")
    provider.claims = {"name": "Updated name", "email": "new@example.com", "email_verified": True}
    assert complete(client, provider).headers["location"] == "/"
    assert client.get("/api/session").json()["id"] == user["id"]
    snapshot = client.get(f"/api/worktrees/{worktree['id']}").json()
    snapshot["bundle"]["flow"]["description"] = "Updated by SSO"
    response = client.put(
        f"/api/worktrees/{worktree['id']}",
        json={
            "revision": snapshot["revision"],
            "bundle": snapshot["bundle"],
            "identity": {"name": "Forged", "email": "forged@example.com"},
        },
    )
    assert response.status_code == 200, response.text
    assert (
        projects.git(worktree["path"], "show", "-s", "--format=%an%n%ae%n%cn%n%ce").splitlines()
        == ["Updated name", "new@example.com"] * 2
    )
    assert projects.git(worktree["path"], "show", "-s", "--format=%an%n%ae", original).splitlines() == [
        expected["name"],
        expected["email"],
    ]


@pytest.mark.parametrize(
    "claims",
    [
        {"iss": "https://attacker.example.com"},
        {"aud": "another-client"},
        {"aud": ["test-client", "other"]},
        {"azp": "another-client"},
        {"nonce": "wrong"},
        {"nonce": None},
        {"exp": 1},
        {"exp": None},
        {"iat": 9999999999},
        {"iat": None},
        {"sub": ""},
        {"sub": None},
        {"sub": 123},
        {"at_hash": "wrong"},
    ],
)
def test_invalid_claims_fail_closed(instance, claims):
    app, client, provider, _ = instance
    assert configure(client).status_code == 200
    client.post("/api/logout")
    provider.claims = claims
    assert complete(client, provider).headers["location"] == "/?sso_error=failed"
    assert client.get("/api/session").status_code == 401
    assert len(app.state.auth.store.all("user")) == 1


def test_invalid_signature_and_key_rotation(instance):
    _, client, provider, _ = instance
    configure(client)
    client.post("/api/logout")
    provider.signing_key = RSAKey.generate_key(2048, {"kid": "test-key"})
    assert complete(client, provider).headers["location"] == "/?sso_error=failed"
    provider.key = provider.signing_key
    assert complete(client, provider).headers["location"] == "/"


def test_browser_binding_expiry_replay_and_provider_denial(instance):
    app, client, provider, _ = instance
    configure(client)
    client.post("/api/logout")
    params = start(client, provider)
    # A callback stolen from another browser cannot establish a session.
    assert (
        client.get(
            "/api/oidc/callback", params=params, headers={"cookie": ""}, follow_redirects=False
        ).headers["location"]
        == "/?sso_error=failed"
    )
    assert client.get("/api/session").status_code == 401
    params = start(client, provider)
    assert (
        client.get("/api/oidc/callback", params={**params, "state": "wrong"}, follow_redirects=False).headers[
            "location"
        ]
        == "/?sso_error=failed"
    )
    params = start(client, provider)
    record = app.state.auth.store.get("oidc_transaction", session_key(params["state"]))
    record["expires"] = time.time() - 1
    app.state.auth.store.put("oidc_transaction", session_key(params["state"]), record)
    assert (
        client.get("/api/oidc/callback", params=params, follow_redirects=False).headers["location"]
        == "/?sso_error=failed"
    )
    params = start(client, provider)
    assert (
        client.get(
            "/api/oidc/callback",
            params={**params, "error": "access_denied", "error_description": "private provider detail"},
            follow_redirects=False,
        ).headers["location"]
        == "/?sso_error=failed"
    )
    params = start(client, provider)
    cookie = client.cookies.get("duckpad_oidc")
    assert client.get("/api/oidc/callback", params=params, follow_redirects=False).headers["location"] == "/"
    client.post("/api/logout")
    response = client.get(
        "/api/oidc/callback",
        params=params,
        headers={"cookie": "duckpad_oidc=" + cookie},
        follow_redirects=False,
    )
    assert response.headers["location"] == "/?sso_error=failed"
    assert (
        response.headers["cache-control"] == "no-store"
        and response.headers["referrer-policy"] == "no-referrer"
    )
    assert client.get("/api/session").status_code == 401


def test_deactivation_recovery_and_config_changes_revoke_sso(instance):
    app, client, provider, password = instance
    configure(client)
    client.post("/api/logout")
    complete(client, provider)
    user = client.get("/api/session").json()
    token = client.cookies.get("duckpad_session")
    client.cookies.clear()
    client.post("/api/login", json={"password": password})
    assert client.patch(f"/api/users/{user['id']}", json={"password": "new-password-123"}).status_code == 400
    assert client.patch(f"/api/users/{user['id']}", json={"active": False}).status_code == 200
    assert (
        client.get("/api/session", headers={"cookie": "", "authorization": "Bearer " + token}).status_code
        == 401
    )
    client.cookies.clear()
    assert complete(client, provider).headers["location"] == "/?sso_error=failed"
    client.post("/api/login", json={"password": password})
    assert client.patch(f"/api/users/{user['id']}", json={"active": True, "role": "admin"}).status_code == 200
    assert client.patch("/api/users/admin", json={"role": "member"}).status_code == 409
    client.post("/api/logout")
    complete(client, provider)
    token = client.cookies.get("duckpad_session")
    assert configure(client, enabled=False).status_code == 200
    assert client.get("/api/session").status_code == 401
    assert client.get("/api/oidc/provider").json() is None
    assert client.post("/api/login", json={"password": password}).status_code == 200
    configure(client)
    assert (
        client.get("/api/session", headers={"cookie": "", "authorization": "Bearer " + token}).status_code
        == 401
    )
    params = start(client, provider)
    assert configure(client, client_secret="").status_code == 200
    assert app.state.oidc.settings()["client_secret"] == "test-secret"
    assert (
        client.get("/api/oidc/callback", params=params, follow_redirects=False).headers["location"]
        == "/?sso_error=failed"
    )


def test_signup_restriction_and_post_client_auth(instance):
    _, client, provider, _ = instance
    provider.method = "client_secret_post"
    assert configure(client, allow_signup=False).status_code == 200
    assert complete(client, provider).headers["location"] == "/?sso_error=failed"
    configure(client)
    assert complete(client, provider).headers["location"] == "/"


@pytest.mark.parametrize(
    "changes",
    [
        {"issuer": "http://identity.example.com"},
        {"issuer": "https://user:secret@identity.example.com"},
        {"issuer": "https://identity.example.com?secret=123"},
        {"public_url": "https://duckpad.example.com/path"},
        {"client_secret": ""},
        {"client_id": ""},
        {"label": " "},
    ],
)
def test_bad_settings_do_not_enable_sso(instance, changes):
    _, client, _, _ = instance
    assert configure(client, **changes).status_code == 400
    assert client.get("/api/oidc/provider").json() is None


@pytest.mark.parametrize(
    "metadata",
    [
        {"issuer": "https://wrong.example.com"},
        {"token_endpoint": "http://127.0.0.1/token"},
        {"id_token_signing_alg_values_supported": ["none", "HS256"]},
        {"response_types_supported": ["id_token"]},
        {"code_challenge_methods_supported": ["plain"]},
        {"token_endpoint_auth_methods_supported": ["none"]},
    ],
)
def test_discovery_rejects_unsafe_or_unsupported_provider(instance, metadata):
    _, client, provider, _ = instance
    provider.metadata = metadata
    assert configure(client).status_code == 400
    assert client.get("/api/oidc/provider").json() is None


def test_settings_require_admin_and_reject_cross_origin_writes(instance):
    _, client, _, _ = instance
    assert (
        client.put("/api/sso", json={}, headers={"origin": "https://attacker.example.com"}).status_code == 403
    )
    client.post("/api/logout")
    assert client.get("/api/sso").status_code == configure(client).status_code == 401
    assert client.get("/api/oidc/anything").status_code == 401


def test_callback_log_redaction():
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        "",
        0,
        "%s %s %s %s %s",
        ("client", "GET", "/api/oidc/callback?code=secret&state=private", "1.1", 303),
        None,
    )
    assert PollingAccessFilter().filter(record)
    assert "secret" not in record.getMessage() and "private" not in record.getMessage()


def test_symmetric_token_cannot_use_published_rsa_keys(instance):
    _, client, provider, _ = instance
    configure(client)
    client.post("/api/logout")
    provider.algorithm = "HS256"
    provider.signing_key = OctKey.generate_key(256)
    assert complete(client, provider).headers["location"] == "/?sso_error=failed"
    assert client.get("/api/session").status_code == 401


def test_discovery_failure_preserves_config_and_local_access(instance, monkeypatch):
    app, client, _, password = instance
    configure(client)
    before = app.state.oidc.settings()

    def unavailable(url):
        raise httpx2.ConnectError("private upstream details")

    monkeypatch.setattr(app.state.oidc, "get_json", unavailable)
    response = configure(client, label="Changed")
    assert response.status_code == 400 and "private upstream" not in response.text
    assert app.state.oidc.settings() == before
    assert configure(client, issuer="https://other.example.com", client_secret="").status_code == 400
    client.post("/api/logout")
    assert client.get("/api/oidc/login", follow_redirects=False).headers["location"] == "/?sso_error=failed"
    assert client.post("/api/login", json={"password": password}).status_code == 200


def test_settings_accounts_and_sessions_survive_service_restart(instance):
    app, client, provider, _ = instance
    configure(client)
    client.post("/api/logout")
    complete(client, provider)
    user = client.get("/api/session").json()
    with_store = Store(app.state.auth.store.home)
    try:
        auth = Auth(with_store)
        oidc = oidc_module.OIDC(with_store, auth)
        assert auth.initial_password is None
        assert auth.check(client.cookies.get("duckpad_session"))["id"] == user["id"]
        assert oidc.settings()["client_secret"] == "test-secret"
        assert oidc.public_settings()["enabled"]
        # Matching a verified subject still works when new registrations are closed.
        config = oidc.settings()
        config["allow_signup"] = False
        with_store.put("settings", "oidc", config)
        token = oidc.create_session(config, {"sub": "subject-123"})
        assert auth.check(token)["id"] == user["id"]
    finally:
        with_store.close()


def test_pending_signin_limit_and_expiry_without_loading_transactions(instance, monkeypatch):
    app, client, provider, _ = instance
    configure(client)
    store = app.state.auth.store
    params = start(client, provider)
    record = store.get("oidc_transaction", session_key(params["state"]))
    with store.transaction():
        for number in range(999):
            store.put("oidc_transaction", f"pending-{number}", record)

    def refuse_scan(*args):
        pytest.fail("Sign-in must not load every transaction")

    monkeypatch.setattr(store, "items", refuse_scan)
    with pytest.raises(Problem, match="Too many pending sign-ins") as error:
        app.state.oidc.start()
    assert error.value.status == 429
    store.put("oidc_transaction", "pending-0", {**record, "expires": time.time() - 1})
    url, _ = app.state.oidc.start()
    assert url.startswith(provider.issuer + "/authorize?")
    assert store.count_oidc_transactions() == 1000


def test_signup_retries_case_insensitive_username_collision_without_scanning_users(instance, monkeypatch):
    app, client, provider, _ = instance
    configure(client)
    app.state.auth.create_user("MEMBER-sso-11111111", "local-password-123")
    provider.claims["preferred_username"] = "member"
    params = start(client, provider)
    suffixes = iter(("11111111", "22222222"))
    monkeypatch.setattr(oidc_module.secrets, "token_hex", lambda _length: next(suffixes))

    def refuse_scan(*args):
        pytest.fail("Signup must look up candidates instead of loading every account")

    monkeypatch.setattr(app.state.auth.store, "all", refuse_scan)
    result = client.get("/api/oidc/callback", params=params, follow_redirects=False)
    assert result.headers["location"] == "/"
    assert client.get("/api/session").json()["username"] == "member-sso-22222222"
