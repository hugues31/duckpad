"""Machine credentials, service account boundaries and immutable run attribution."""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from helpers import wait_run

from duckpad.app import SESSION_COOKIE, create_app
from duckpad.auth import session_key
from duckpad.util import Problem

PASSWORD = "api-token-test-password"


@pytest.fixture
def instance(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert client.post("/api/login", json={"password": app.state.auth.initial_password}).is_success
        yield app, client


def issue_token(client, name="Nightly orchestration", path="/api/api-tokens", **data):
    response = client.post(path, json={"name": name, **data})
    assert response.status_code == 200, response.text
    return response.json()


def bearer(token):
    return {"Authorization": f"Bearer {token}", "Cookie": ""}


def test_token_lifecycle_storage_and_last_use_throttle(instance, monkeypatch):
    app, client = instance
    store = app.state.services.store
    token = issue_token(client)
    assert token["token"].startswith("dpk_") and len(token["token"]) >= 40
    assert token["expires"] is None and token["last_used"] is None
    stored = store.get("api_token", token["id"])
    assert stored["hash"] == session_key(token["token"])
    assert token["token"] not in json.dumps(stored)
    assert "hash" not in token
    instant = time.time()
    monkeypatch.setattr("duckpad.auth.time.time", lambda: instant)
    headers = bearer(token["token"])
    assert client.get("/api/session", headers=headers).json()["id"] == "admin"
    used = store.get("api_token", token["id"])["last_used"]
    assert used == instant
    monkeypatch.setattr("duckpad.auth.time.time", lambda: instant + 59)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: app.state.auth.check_api_token(token["token"]), range(8)))
    assert store.get("api_token", token["id"])["last_used"] == used
    monkeypatch.setattr("duckpad.auth.time.time", lambda: instant + 60)
    assert client.get("/api/session", headers=headers).status_code == 200
    assert store.get("api_token", token["id"])["last_used"] == instant + 60
    listed = client.get("/api/api-tokens").json()
    assert "token" not in listed[0] and "hash" not in listed[0]
    assert client.delete(f"/api/api-tokens/{token['id']}").status_code == 200
    assert client.get("/api/session", headers=headers).status_code == 401
    assert client.get("/api/api-tokens").json() == []


def test_unknown_expired_cookie_and_git_credentials_are_refused(instance, monkeypatch):
    _app, client = instance
    expiry = datetime.now(UTC) + timedelta(days=1)
    token = issue_token(client, expires=expiry.isoformat())
    assert token["expires"] == expiry.timestamp()
    assert client.get("/api/session", headers=bearer("dpk_unknown")).status_code == 401
    assert client.get("/api/", headers=bearer(token["token"])).status_code == 404
    assert (
        client.get("/api/session", headers={"Cookie": f"{SESSION_COOKIE}={token['token']}"}).status_code
        == 401
    )
    assert (
        client.get("/api/session", headers={"Cookie": "", "Authorization": token["token"]}).status_code == 401
    )
    assert (
        client.get(
            "/api/session", headers={"Cookie": "", "Authorization": f"bearer {token['token']}"}
        ).status_code
        == 200
    )
    for method in ("GET", "POST", "DELETE"):
        assert client.request(method, "/api/ssh-key", headers=bearer(token["token"])).status_code == 403
    for action in ("consent", "fetch", "push"):
        assert (
            client.post(
                f"/api/worktrees/absent/git/{action}", headers=bearer(token["token"]), json={}
            ).status_code
            == 403
        )
    monkeypatch.setattr("duckpad.auth.time.time", lambda: expiry.timestamp())
    assert client.get("/api/session", headers=bearer(token["token"])).status_code == 401


@pytest.mark.parametrize(
    "data",
    [
        {"name": " "},
        {"name": "x" * 129},
        {"name": "bad", "expires": "2000-01-01T00:00:00Z"},
        {"name": "bad", "expires": "tomorrow"},
        {"name": "bad", "expires": "2099-01-01T00:00:00"},
    ],
)
def test_invalid_token_metadata_is_rejected(instance, data):
    app, client = instance
    assert client.post("/api/api-tokens", json=data).status_code in (400, 422)
    assert app.state.services.store.all("api_token") == []


def test_tokens_survive_password_changes_but_not_account_deactivation(instance):
    app, client = instance
    auth = app.state.auth
    user = auth.create_user("worker", PASSWORD)
    session = auth.login("worker", PASSWORD)
    token = auth.create_api_token(user, user["id"], "Worker")
    assert (
        client.patch(f"/api/users/{user['id']}", json={"password": PASSWORD + "-changed"}).status_code == 200
    )
    assert client.get("/api/session", headers=bearer(session)).status_code == 401
    assert client.get("/api/session", headers=bearer(token["token"])).status_code == 200
    for active in (False, True):
        assert client.patch(f"/api/users/{user['id']}", json={"active": active}).status_code == 200
        assert client.get("/api/session", headers=bearer(token["token"])).status_code == 401
        assert app.state.services.store.api_tokens(user["id"]) == []


def test_admin_revocation_and_token_ownership(instance):
    app, client = instance
    auth = app.state.auth
    user = auth.create_user("owner", PASSWORD)
    other = auth.create_user("other", PASSWORD)
    token = auth.create_api_token(user, user["id"], "Owned")
    other_token = auth.create_api_token(other, other["id"], "Other")
    headers = bearer(token["token"])
    assert client.get("/api/api-tokens", headers=headers).json()[0]["id"] == token["id"]
    assert client.delete(f"/api/api-tokens/{other_token['id']}", headers=headers).status_code == 404
    assert client.get(f"/api/users/{other['id']}/api-tokens", headers=headers).status_code == 403
    path = f"/api/users/{user['id']}/api-tokens"
    assert client.get(path).json()[0]["name"] == "Owned"
    assert client.post(path, json={"name": "Impersonation"}).status_code == 403
    assert client.delete(f"{path}/{other_token['id']}").status_code == 404
    assert client.delete(f"{path}/{token['id']}").status_code == 200
    assert client.get("/api/session", headers=headers).status_code == 401


def test_personal_token_permissions_follow_current_account_and_membership(instance):
    app, client = instance
    auth = app.state.auth
    user = auth.create_user("changing-role", PASSWORD, "admin")
    token = auth.create_api_token(user, user["id"], "Current permissions")
    headers = bearer(token["token"])
    worktree = client.post("/api/projects", json={"name": "Permissions"}).json()
    path = f"/api/worktrees/{worktree['id']}"
    assert client.get(path, headers=headers).status_code == 200
    assert client.patch(f"/api/users/{user['id']}", json={"role": "member"}).status_code == 200
    assert client.get(path, headers=headers).status_code == 404
    member = f"/api/projects/{worktree['project']}/members/{user['id']}"
    assert client.put(member, json={"role": "editor"}).status_code == 200
    response = client.post(f"{path}/runs", headers=headers, json={"environment": "dev"})
    assert response.status_code == 200
    run = wait_run(app.state.services.store, response.json())
    assert run["requester"]["id"] == user["id"]
    assert client.put(member, json={"role": "reader"}).status_code == 200
    assert client.get(path, headers=headers).status_code == 200
    assert client.post(f"{path}/runs", headers=headers, json={"environment": "dev"}).status_code == 403
    assert client.delete(member).status_code == 200
    assert client.get(path, headers=headers).status_code == 404


def test_service_accounts_are_reader_only_and_admin_managed(instance):
    app, client = instance
    auth = app.state.auth
    created = client.post(
        "/api/users", json={"username": "orchestrator", "service": True, "description": "Nightly reports"}
    )
    assert created.status_code == 200
    user = created.json()
    assert user["role"] == "member" and user["auth_method"] == "service"
    assert user["description"] == "Nightly reports"
    stored = app.state.services.store.get("user", user["id"])
    assert not {"salt", "hash", "oidc"} & stored.keys()
    assert (
        client.post("/api/login", json={"username": user["username"], "password": PASSWORD}).status_code
        == 401
    )
    with pytest.raises(Problem, match="interactively"):
        auth.start_session(stored)
    for data in ({"password": PASSWORD}, {"role": "admin"}):
        assert client.patch(f"/api/users/{user['id']}", json=data).status_code == 400
        assert (
            client.post(
                "/api/users", json={"username": "invalid-service", "service": True, **data}
            ).status_code
            == 400
        )
    path = f"/api/users/{user['id']}/api-tokens"
    token = issue_token(client, path=path)
    headers = bearer(token["token"])
    assert client.get("/api/session", headers=headers).json()["id"] == user["id"]
    assert client.post("/api/projects", headers=headers, json={"name": "Escalation"}).status_code == 403
    assert client.post("/api/example", headers=headers).status_code == 403
    assert (
        client.post(
            "/api/password", headers=headers, json={"current": PASSWORD, "password": PASSWORD}
        ).status_code
        == 400
    )
    assert client.get("/api/api-tokens", headers=headers).status_code == 403
    assert client.post("/api/api-tokens", headers=headers, json={"name": "Escalation"}).status_code == 403
    assert client.delete(f"{path}/{token['id']}", headers=headers).status_code == 403
    worktree = client.post("/api/projects", json={"name": "Service project"}).json()
    member = f"/api/projects/{worktree['project']}/members/{user['id']}"
    for role in ("editor", "admin"):
        assert client.put(member, json={"role": role}).status_code == 403
    assert client.put(member, json={"role": "reader"}).status_code == 200
    assert client.get(f"/api/worktrees/{worktree['id']}", headers=headers).status_code == 200
    assert client.put(f"/api/worktrees/{worktree['id']}", headers=headers, json={}).status_code == 403
    assert (
        client.post(
            f"/api/worktrees/{worktree['id']}/runs", headers=headers, json={"environment": "dev"}
        ).status_code
        == 403
    )
    assert client.delete(member).status_code == 200
    assert client.get(f"/api/worktrees/{worktree['id']}", headers=headers).status_code == 404
    assert client.patch(f"/api/users/{user['id']}", json={"active": False}).status_code == 200
    assert client.post(path, json={"name": "Inactive"}).status_code == 409
    assert client.patch(f"/api/users/{user['id']}", json={"active": True}).status_code == 200
    assert client.get("/api/session", headers=headers).status_code == 401


def test_sso_tokens_follow_enabled_state_without_binding_to_session_revision(instance):
    app, client = instance
    store, auth = app.state.services.store, app.state.auth
    record = {
        "id": "sso-user",
        "username": "sso-user",
        "role": "member",
        "active": True,
        "oidc": {"issuer": "https://id.example.invalid", "subject": "123"},
    }
    store.put("user", record["id"], record)
    store.put("settings", "oidc", {"enabled": True, "revision": "first"})
    session = auth.start_session(record, oidc_revision="first")
    token = client.post("/api/api-tokens", headers=bearer(session), json={"name": "SSO automation"}).json()
    headers = bearer(token["token"])
    assert client.get("/api/session", headers=headers).status_code == 200
    store.put("settings", "oidc", {"enabled": False, "revision": "second"})
    assert client.get("/api/session", headers=headers).status_code == 401
    store.put("settings", "oidc", {"enabled": True, "revision": "third"})
    assert client.get("/api/session", headers=headers).status_code == 200
    assert client.get("/api/session", headers=bearer(session)).status_code == 401


def test_run_requester_survives_revocation_and_ignores_caller_supplied_identity(instance):
    app, client = instance
    store = app.state.services.store
    worktree = client.post("/api/projects", json={"name": "Attribution"}).json()
    token = issue_token(client, name="Scheduled reports")
    for headers, token_name in (({}, None), (bearer(token["token"]), "Scheduled reports")):
        response = client.post(
            f"/api/worktrees/{worktree['id']}/runs",
            headers=headers,
            json={"environment": "dev", "requester": {"username": "forged"}},
        )
        assert response.status_code == 200
        run = wait_run(store, response.json())
        assert run["requester"] == {"id": "admin", "username": "admin", "token_name": token_name}
    assert client.delete(f"/api/api-tokens/{token['id']}").status_code == 200
    assert store.get("run", run["id"])["requester"]["token_name"] == "Scheduled reports"
    assert token["token"] not in json.dumps(store.runs({"id": "admin", "role": "admin"}))


def test_api_tokens_and_service_accounts_survive_restart(tmp_path):
    home = tmp_path / "instance"
    app = create_app(home, watch=False)
    with TestClient(app):
        auth = app.state.auth
        admin = auth.public(app.state.services.store.get("user", "admin"))
        user = auth.create_user("durable-service", service=True)
        token = auth.create_api_token(admin, user["id"], "Durable")
    reopened = create_app(home, watch=False)
    with TestClient(reopened) as client:
        assert client.get("/api/session", headers=bearer(token["token"])).json() == {
            **user,
            "version": app.version,
        }
