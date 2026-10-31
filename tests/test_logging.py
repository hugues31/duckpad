"""Verify polling log levels through the real CLI and Uvicorn access logger."""

import json
import logging
import os
import socket
import subprocess
import sys
import time

import httpx
import pytest
from helpers import wait_until

from duckpad.app import create_app
from duckpad.logging import PollingAccessFilter, server_log_config


@pytest.mark.parametrize("level", [None, "debug"])
def test_cli_polling_logs(tmp_path, level):
    home = tmp_path / "instance"
    app = create_app(home, watch=False)
    password = app.state.auth.initial_password
    app.state.services.close()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    command = [
        sys.executable,
        "-m",
        "duckpad",
        "start",
        "--home",
        str(home),
        "--port",
        str(port),
        "--no-browser",
    ]
    if level:
        command.extend(["--log-level", level])
    log = tmp_path / "server.log"
    with log.open("w") as stream:
        process = subprocess.Popen(
            command,
            stdout=stream,
            stderr=stream,
            env={**os.environ, "DUCKPAD_SECURE_COOKIES": "0"},
        )
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5) as client:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    assert process.poll() is None, log.read_text()
                    try:
                        if client.get("/api/session").status_code == 401:
                            break
                    except httpx.ConnectError:
                        pass
                    time.sleep(0.05)
                else:
                    pytest.fail("The CLI server did not start")
                assert client.get("/api/resources").status_code == 401
                assert client.post("/api/login", json={"password": password}).status_code == 200
                project = client.post("/api/projects", json={"name": "Logging checks"})
                assert project.status_code == 200
                worktree = project.json()["id"]
                polling = [
                    "/api/workspace",
                    "/api/resources",
                    f"/api/worktrees/{worktree}",
                    f"/api/worktrees/{worktree}/status?environment=dev",
                    f"/api/worktrees/{worktree}/generations/data_missing?environment=dev",
                ]
                for path in polling:
                    response = client.get(path)
                    assert response.status_code == 200
                    if path == f"/api/worktrees/{worktree}":
                        snapshot = response.json()
                assert client.get("/api/catalog").status_code == 200
                assert client.get("/api/worktrees/missing/status?environment=dev").status_code == 404
                assert client.put(f"/api/worktrees/{worktree}", json={}).status_code == 422
                bundle = snapshot["bundle"]
                bundle["flow"]["nodes"] = [{"id": "messages", "params": {}}]
                bundle["node_sql"] = {
                    "nodes/messages.sql": (
                        "-- @output result\nSELECT 1 AS value;\n-- @message\n"
                        "SELECT 'info' AS level, 'First' || chr(10) || 'Second' AS message;"
                    )
                }
                assert (
                    client.put(
                        f"/api/worktrees/{worktree}",
                        json={
                            "revision": snapshot["revision"],
                            "bundle": bundle,
                        },
                    ).status_code
                    == 200
                )
                execution = client.post(f"/api/worktrees/{worktree}/runs", json={"environment": "dev"}).json()
                wait_until(lambda: client.get(f"/api/runs/{execution['id']}").json()["status"] == "success")
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)

    lines = log.read_text().splitlines()
    assert any("Application startup complete." in line for line in lines)
    messages = [json.loads(line) for line in lines if line.startswith('{"event": "node_result"')]
    assert len(messages) == 1
    assert messages[0] == {
        "event": "node_result",
        "run": execution["id"],
        "project": project.json()["project"],
        "branch": "main",
        "environment": "dev",
        "node": "messages",
        "level": "info",
        "message": "First\nSecond",
        "origin": {"kind": "message", "block": 1},
        "output": None,
    }
    for path in polling:
        matching = [line for line in lines if f'"GET {path} HTTP/1.1" 200' in line]
        if level == "debug":
            assert len(matching) == 1 and matching[0].startswith("DEBUG:")
        else:
            assert matching == []
    for request in [
        '"GET /api/resources HTTP/1.1" 401',
        '"POST /api/login HTTP/1.1" 200',
        '"POST /api/projects HTTP/1.1" 200',
        '"GET /api/catalog HTTP/1.1" 200',
        '"GET /api/worktrees/missing/status?environment=dev HTTP/1.1" 404',
        f'"PUT /api/worktrees/{worktree} HTTP/1.1" 422',
    ]:
        assert any(line.startswith("INFO:") and request in line for line in lines)


@pytest.mark.parametrize(
    ("method", "path", "status"),
    [
        ("GET", "/api/resources", 199),
        ("GET", "/api/resources", 301),
        ("GET", "/api/resources", 304),
        ("GET", "/api/resources", 403),
        ("GET", "/api/resources", 500),
        ("POST", "/api/resources", 200),
        ("PUT", "/api/worktrees/worktree_test", 200),
        ("DELETE", "/api/worktrees/worktree_test", 204),
        ("GET", "/api/worktrees/worktree_test/git/history", 200),
        ("GET", "/api/worktrees/worktree_test/status/extra", 200),
        ("GET", "/api/worktrees/worktree_test/generations/data_test/extra", 200),
        ("GET", "/api/catalog?next=/api/resources", 200),
    ],
)
def test_other_access_logs_retain_their_level(caplog, method, path, status):
    logger = logging.getLogger("duckpad.test.access")
    access_filter = PollingAccessFilter()
    logger.addFilter(access_filter)
    try:
        with caplog.at_level(logging.DEBUG, logger=logger.name):
            logger.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:1234", method, path, "1.1", status)
    finally:
        logger.removeFilter(access_filter)
    assert len(caplog.records) == 1
    assert caplog.records[0].levelno == logging.INFO


@pytest.mark.parametrize(("level", "expected"), [("debug", "DEBUG"), ("info", "INFO"), ("error", "ERROR")])
def test_node_result_logs_follow_the_server_level(level, expected):
    assert server_log_config(level)["loggers"]["duckpad.execution"]["level"] == expected
