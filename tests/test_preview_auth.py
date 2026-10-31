import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app


def test_documentation_mount_preserves_application_and_api_boundaries(tmp_path, monkeypatch):
    static = tmp_path / "static"
    (static / "site" / "docs" / "quickstart").mkdir(parents=True)
    (static / "site" / "index.html").write_text("Duckpad website")
    (static / "site" / "docs" / "quickstart" / "index.html").write_text("Quickstart guide")
    (static / "index.html").write_text("Duckpad application")
    (static / "assets").mkdir()
    (static / "assets" / "app.js").write_text("// Application asset")
    monkeypatch.setattr("duckpad.app.STATIC", static)
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert client.get("/site/").text == "Duckpad website"
        assert client.get("/site/docs/quickstart/").text == "Quickstart guide"
        assert client.get("/site/missing/").status_code == 404
        assert client.get("/").text == "Duckpad application"
        for path in (
            "/user-settings",
            "/instance-settings/environments",
            "/projects/project-example/settings",
            "/worktrees/worktree-example/code?environment=prod",
        ):
            assert client.get(path).text == "Duckpad application"
        assert client.get("/assets/app.js").text == "// Application asset"
        assert client.get("/assets/missing.js").status_code == 404
        assert client.get("/api/session").status_code == 401
        assert client.get("/api/missing").status_code == 401
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        assert client.get("/api/missing").status_code == 404
        assert client.get("/api").status_code == 404


@pytest.mark.parametrize(
    ("secure", "scheme", "session_status"),
    [("0", "http", 200), ("1", "http", 401), ("0", "https", 200), ("1", "https", 200)],
)
def test_session_cookie_transport(tmp_path, monkeypatch, secure, scheme, session_status):
    monkeypatch.setenv("DUCKPAD_SECURE_COOKIES", secure)
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app, base_url=f"{scheme}://duckpad.test") as client:
        response = client.post("/api/login", json={"password": app.state.auth.initial_password})
        assert response.status_code == 200
        assert "HttpOnly" in response.headers["set-cookie"]
        assert client.get("/api/session").status_code == session_status
