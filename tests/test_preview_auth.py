import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app


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
