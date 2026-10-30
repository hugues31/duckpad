"""Verify polling log levels through the real CLI and Uvicorn access logger."""

import logging
import os
import socket
import subprocess
import sys
import time

import httpx
import pytest

from duckpad.app import create_app
from duckpad.logging import PollingAccessFilter


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
                    assert client.get(path).status_code == 200
                assert client.get("/api/catalog").status_code == 200
                assert client.get("/api/worktrees/missing/status?environment=dev").status_code == 404
                assert client.put(f"/api/worktrees/{worktree}", json={}).status_code == 422
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)

    lines = log.read_text().splitlines()
    assert any("Application startup complete." in line for line in lines)
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
