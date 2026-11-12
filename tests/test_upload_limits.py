"""Reject oversized multipart bodies before the parser reads or spools their content."""

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from duckpad.api.http import MAX_UPLOAD_BYTES
from duckpad.app import create_app
from duckpad.archive import MAX_ARCHIVE_BYTES
from duckpad.extensions import MAX_UPLOAD_BYTES as MAX_EXTENSION_BYTES


@pytest.fixture
def uploads(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        client.post("/api/login", json={"username": "admin", "password": app.state.auth.initial_password})
        worktree = client.post("/api/projects", json={"name": "Uploads"}).json()["id"]
        yield client, worktree


@pytest.mark.parametrize(
    ("route", "limit"),
    [
        ("/api/projects/import", MAX_ARCHIVE_BYTES),
        ("/api/extensions/import", MAX_EXTENSION_BYTES),
        ("/api/worktrees/{worktree}/uploads", MAX_UPLOAD_BYTES),
    ],
)
def test_upload_admission_precedes_multipart_parsing(uploads, monkeypatch, route, limit):
    client, worktree = uploads

    def never(*args, **kwargs):
        raise AssertionError("Rejected uploads must not read or spool the body")

    monkeypatch.setattr(Request, "form", never)
    for headers, status in (
        ({"Content-Length": str(limit + 1)}, 413),
        ({"Content-Length": "9" * 5000}, 413),
        ({"Content-Length": "invalid"}, 411),
        ({"Transfer-Encoding": "chunked"}, 411),
    ):
        response = client.post(route.format(worktree=worktree), content=b"not read", headers=headers)
        assert response.status_code == status, response.text
