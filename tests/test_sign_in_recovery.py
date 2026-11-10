"""First-launch setup link and command-line password recovery."""

import sys

import pytest
from fastapi.testclient import TestClient

from duckpad import cli
from duckpad.app import create_app

PASSWORD = "recovery-test-password"


@pytest.fixture
def fresh(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        yield app, client


def setup(client, token, password=PASSWORD):
    return client.post("/api/setup", json={"token": token, "password": password})


def login(client, password):
    return client.post("/api/login", json={"username": "admin", "password": password})


def test_the_setup_link_chooses_the_admin_password_and_signs_in(fresh):
    app, client = fresh
    generated = app.state.auth.initial_password
    response = setup(client, app.state.auth.setup_token)
    assert response.status_code == 200, response.text
    assert response.json()["username"] == "admin"
    assert client.get("/api/session").json()["role"] == "admin"
    assert app.state.auth.setup_token is None
    other = TestClient(app)
    assert login(other, generated).status_code == 401
    assert login(other, PASSWORD).status_code == 200


def test_the_setup_link_works_once(fresh):
    app, client = fresh
    token = app.state.auth.setup_token
    assert setup(client, token).status_code == 200
    reused = setup(TestClient(app), token, "another-test-password")
    assert reused.status_code == 403
    assert "duckpad reset-password" in reused.json()["error"]
    assert login(TestClient(app), PASSWORD).status_code == 200


def test_a_wrong_token_or_a_short_password_keeps_the_link(fresh):
    app, client = fresh
    token = app.state.auth.setup_token
    assert setup(client, token[:-1] + ("A" if token[-1] != "A" else "B")).status_code == 403
    assert setup(client, "").status_code == 403
    assert setup(client, token, "too short").status_code == 400
    assert client.get("/api/session").status_code == 401
    assert setup(client, token).status_code == 200


def test_changing_the_generated_password_revokes_the_link(fresh):
    app, client = fresh
    token = app.state.auth.setup_token
    assert login(client, app.state.auth.initial_password).status_code == 200
    changed = client.post(
        "/api/password", json={"current": app.state.auth.initial_password, "password": PASSWORD}
    )
    assert changed.status_code == 200, changed.text
    assert setup(TestClient(app), token, "another-test-password").status_code == 403
    assert app.state.auth.setup_token is None
    assert login(TestClient(app), PASSWORD).status_code == 200


def test_signing_in_with_the_generated_password_keeps_the_link(fresh):
    app, client = fresh
    assert login(client, app.state.auth.initial_password).status_code == 200
    assert setup(TestClient(app), app.state.auth.setup_token).status_code == 200


def test_a_restart_revokes_the_link_but_not_the_generated_password(tmp_path):
    home = tmp_path / "instance"
    app = create_app(home, watch=False)
    with TestClient(app):
        generated, token = app.state.auth.initial_password, app.state.auth.setup_token
    app = create_app(home, watch=False)
    with TestClient(app) as client:
        assert app.state.auth.setup_token is None
        assert setup(client, token).status_code == 403
        assert login(client, generated).status_code == 200


def test_setup_attempts_share_the_sign_in_limit(fresh):
    app, client = fresh
    for _ in range(12):
        assert setup(client, "guess").status_code == 403
    assert setup(client, app.state.auth.setup_token).status_code == 429
    assert login(client, app.state.auth.initial_password).status_code == 429


def reset(monkeypatch, capsys, home, *arguments):
    monkeypatch.setattr(sys, "argv", ["duckpad", "reset-password", *arguments, "--home", str(home)])
    cli.main()
    output = capsys.readouterr().out
    return output.split("\n\n")[1].strip(), output


def test_reset_password_works_while_the_server_runs(fresh, monkeypatch, capsys):
    app, client = fresh
    home = app.state.services.store.home
    generated = app.state.auth.initial_password
    assert login(client, generated).status_code == 200
    password, output = reset(monkeypatch, capsys, home)
    assert output.startswith("New password for admin:")
    assert "User settings → Change password" in output
    # The new hash signs out the running server's sessions.
    assert client.get("/api/session").status_code == 401
    assert login(client, generated).status_code == 401
    assert login(client, password).status_code == 200


def test_reset_password_accepts_another_local_account(fresh, monkeypatch, capsys):
    app, client = fresh
    app.state.auth.create_user("Analyst", PASSWORD)
    password, output = reset(monkeypatch, capsys, app.state.services.store.home, "analyst")
    assert output.startswith("New password for Analyst:")
    assert app.state.auth.login("Analyst", password, peer="probe")
    assert login(client, app.state.auth.initial_password).status_code == 200


@pytest.mark.parametrize(
    ("username", "message"),
    [
        ("nobody", "No account is named nobody"),
        ("robot", "robot is a service account"),
        ("sso-user", "sso-user signs in with single sign-on"),
        ("former", "former is deactivated"),
    ],
)
def test_reset_password_refuses_accounts_without_a_local_password(
    fresh, monkeypatch, capsys, username, message
):
    app, _ = fresh
    store = app.state.services.store
    app.state.auth.create_user("robot", service=True)
    store.put(
        "user",
        "sso",
        {
            "id": "sso",
            "username": "sso-user",
            "role": "member",
            "active": True,
            "oidc": {"issuer": "https://issuer.example", "subject": "1"},
        },
    )
    former = app.state.auth.create_user("former", PASSWORD)
    app.state.access.update_user(former["id"], {"active": False})
    monkeypatch.setattr(sys, "argv", ["duckpad", "reset-password", username, "--home", str(store.home)])
    with pytest.raises(SystemExit) as exit:
        cli.main()
    assert exit.value.code == 1
    error = capsys.readouterr().err
    assert message in error
    assert "Traceback" not in error


def test_reset_password_never_creates_an_instance(tmp_path, monkeypatch, capsys):
    home = tmp_path / "missing"
    monkeypatch.setattr(sys, "argv", ["duckpad", "reset-password", "--home", str(home)])
    with pytest.raises(SystemExit):
        cli.main()
    assert f"No Duckpad instance in {home}" in capsys.readouterr().err
    assert not home.exists()
