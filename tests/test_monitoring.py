"""Administrator diagnostics must stay bounded and tolerate unavailable metrics."""

import logging
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import psutil
import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.monitoring import LOG_CAPACITY, MESSAGE_LIMIT, Monitoring, RecentLogs, redact_log


def emit(logs, message, level=logging.INFO):
    logs.handle(logging.LogRecord("duckpad.test", level, "", 0, message, (), None))


def test_log_retention_filters_and_bounds():
    logs = RecentLogs()
    for i in range(LOG_CAPACITY + 10):
        emit(logs, f"Entry {i}")
    emit(logs, "Database failed", logging.ERROR)
    result = logs.snapshot()
    assert result["retained"] == LOG_CAPACITY
    assert len(result["entries"]) == 200
    assert result["entries"][0]["message"] == "Database failed"
    assert logs.snapshot(query="entry 0")["matched"] == 0
    assert logs.snapshot(level="warning", query="DATABASE")["matched"] == 1
    assert logs.snapshot(query="DUCKPAD.TEST", limit=3)["entries"] == result["entries"][:3]
    emit(logs, "x" * (MESSAGE_LIMIT + 10))
    entry = logs.snapshot(limit=1)["entries"][0]
    assert entry["message"] == "x" * MESSAGE_LIMIT
    assert entry["truncated"]


def test_logging_and_reading_are_thread_safe():
    logs = RecentLogs()

    def write(i):
        emit(logs, f"Entry {i}")
        return logs.snapshot()

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(write, range(100)))
    entries = logs.snapshot()["entries"]
    assert [entry["id"] for entry in entries] == list(range(100, 0, -1))


@pytest.mark.parametrize(
    "message",
    [
        "password=private-value",
        '"password": "private-value with spaces"',
        "client_secret='private-value'",
        "api_key: private-value",
        "Authorization: Bearer private-value",
        "Cookie: duckpad_session=private-value; other=value",
        '"Cookie": "duckpad_session=private-value"',
        "Bearer private-value",
        "https://name:private-value@example.invalid/path",
        "https://example.invalid/callback?code=private-value&state=value",
    ],
)
def test_common_credentials_are_masked_before_retention(message):
    logs = RecentLogs()
    emit(logs, message)
    assert "private-value" not in repr(logs.snapshot())
    assert "[redacted]" in redact_log(message)


def test_access_logs_omit_clients_and_queries_and_do_not_capture_monitoring_polls():
    logs = RecentLogs()
    for path, status in [
        ("/api/oidc/callback?code=private-value", 302),
        ("/api/monitoring", 200),
        ("/api/monitoring/logs?q=private-value", 200),
        ("/api/monitoring", 500),
    ]:
        logs.handle(
            logging.LogRecord(
                "uvicorn.access",
                logging.INFO,
                "",
                0,
                "%s %s %s %s %s",
                ("client-address", "GET", path, "1.1", status),
                None,
            )
        )
    messages = [entry["message"] for entry in logs.snapshot()["entries"]]
    assert messages == ["GET /api/monitoring 500", "GET /api/oidc/callback 302"]


def test_capture_lifecycle_does_not_duplicate_or_leak_handlers(caplog):
    logs = RecentLogs()
    logger = logging.getLogger("duckpad.test")
    with caplog.at_level(logging.INFO, logger="duckpad"), logs.capture():
        logger.info("Captured once")
        try:
            raise RuntimeError("password=private-value")
        except RuntimeError:
            logger.exception("Failure")
    logger.warning("Not captured")
    entries = logs.snapshot()["entries"]
    assert len(entries) == 2
    assert "Traceback" in entries[0]["message"]
    assert "private-value" not in entries[0]["message"]
    assert entries[1]["message"] == "Captured once"


def test_metrics_measure_instance_filesystem_and_degrade_independently(tmp_path, monkeypatch):
    monitoring = Monitoring(tmp_path)

    def disk_usage(path):
        assert path == str(tmp_path)
        return SimpleNamespace(total=1000, free=100, used=850)

    monkeypatch.setattr(psutil, "disk_usage", disk_usage)
    sample = monitoring.snapshot()
    assert sample["disk"] == {"total_bytes": 1000, "free_bytes": 100, "used_bytes": 850}
    assert sample["process_memory_bytes"] > 0
    assert sample["uptime_seconds"] >= 0

    def unavailable(*args):
        raise PermissionError

    monkeypatch.setattr(psutil, "disk_usage", unavailable)
    assert monitoring.snapshot()["disk"] is None
    assert monitoring.snapshot()["resources"]["memory_total_bytes"] > 0
    monkeypatch.setattr(psutil, "Process", unavailable)
    assert monitoring.snapshot()["process_memory_bytes"] is None


def test_monitoring_requires_instance_admin_and_validates_queries(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        for path in ("/api/monitoring", "/api/monitoring/logs"):
            assert client.get(path).status_code == 401
        client.post("/api/login", json={"username": "admin", "password": app.state.auth.initial_password})
        summary = client.get("/api/monitoring")
        assert summary.status_code == 200
        assert summary.headers["cache-control"] == "no-store"
        assert summary.json()["disk"]["free_bytes"] >= 0
        logging.getLogger("duckpad.test").warning("Monitoring test entry")
        logs = client.get("/api/monitoring/logs?q=Monitoring%20test")
        assert logs.status_code == 200
        assert logs.headers["cache-control"] == "no-store"
        assert logs.json()["entries"][0]["message"] == "Monitoring test entry"
        for query in ("limit=0", "limit=201", "level=unknown", "q=" + "x" * 201):
            assert client.get("/api/monitoring/logs?" + query).status_code == 422
        client.post(
            "/api/users",
            json={"username": "member", "password": "monitoring-test-password", "role": "member"},
        )
        client.post("/api/logout")
        client.post("/api/login", json={"username": "member", "password": "monitoring-test-password"})
        for path in ("/api/monitoring", "/api/monitoring/logs"):
            assert client.get(path).status_code == 403


def test_new_process_monitoring_starts_with_empty_history(tmp_path):
    first = Monitoring(tmp_path)
    emit(first.logs, "Old process")
    assert Monitoring(tmp_path).logs.snapshot()["entries"] == []
