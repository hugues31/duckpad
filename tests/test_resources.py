import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.resources import resource_usage


def test_resources_require_authentication_and_return_live_process_counters(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert client.get("/api/resources").status_code == 401
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        first = client.get("/api/resources")
        second = client.get("/api/resources").json()
        assert first.status_code == 200
        assert first.headers["cache-control"] == "no-store"
        assert second["process_id"] == os.getpid()
        assert second["sampled_at"] > first.json()["sampled_at"]
        assert second["cpu_seconds"] >= first.json()["cpu_seconds"] >= 0
        if Path("/proc/self/statm").exists():
            assert second["memory_bytes"] > 0
        client.post("/api/logout")
        assert client.get("/api/resources").status_code == 401


def test_memory_reports_current_resident_pages_including_decreases(monkeypatch):
    monkeypatch.setattr(os, "sysconf", lambda key: 4096)
    monkeypatch.setattr(Path, "read_text", lambda path: "1000 250 20 10 0 50 0")
    assert resource_usage()["memory_bytes"] == 250 * 4096
    monkeypatch.setattr(Path, "read_text", lambda path: "1000 125 20 10 0 50 0")
    assert resource_usage()["memory_bytes"] == 125 * 4096


@pytest.mark.parametrize("error", [FileNotFoundError, PermissionError])
def test_missing_memory_counters_do_not_break_cpu_reporting(monkeypatch, error):
    def unavailable(path):
        raise error

    monkeypatch.setattr(Path, "read_text", unavailable)
    sample = resource_usage()
    assert sample["memory_bytes"] is None
    assert sample["cpu_seconds"] >= 0
