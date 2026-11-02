"""Startup failures should be actionable without modifying an old instance."""

import base64
import os
import sqlite3
import subprocess
import sys
from contextlib import closing

import pytest
import uvicorn
from fastapi.testclient import TestClient

from duckpad import cli, sealing
from duckpad.store import Store


def test_unsupported_schema_startup_reports_new_home_without_traceback(tmp_path):
    path = tmp_path / "instance.sqlite"
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("CREATE TABLE records (kind TEXT, id TEXT, value TEXT)")
        connection.execute("INSERT INTO records VALUES ('settings', 'marker', 'kept')")
    result = subprocess.run(
        [sys.executable, "-m", "duckpad", "start", "--home", str(tmp_path), "--no-browser"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode != 0
    assert "unsupported schema" in result.stderr
    assert "duckpad start --home <new-directory>" in result.stderr
    assert "Traceback" not in result.stderr
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("SELECT value FROM records").fetchall() == [("kept",)]
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [
            ("records",)
        ]


@pytest.mark.parametrize(
    ("host", "forwarded", "warned"),
    [("0.0.0.0", None, True), ("0.0.0.0", "192.0.2.10", False), ("127.0.0.1", None, False)],
)
def test_network_binds_warn_when_no_proxy_is_trusted(tmp_path, monkeypatch, capsys, host, forwarded, warned):
    monkeypatch.setattr(
        sys, "argv", ["duckpad", "start", "--home", str(tmp_path), "--host", host, "--no-browser"]
    )
    if forwarded:
        monkeypatch.setenv("FORWARDED_ALLOW_IPS", forwarded)
    else:
        monkeypatch.delenv("FORWARDED_ALLOW_IPS", raising=False)

    def serve(app, **options):
        # Run the lifespan so that the instance closes its services.
        with TestClient(app):
            pass

    monkeypatch.setattr(uvicorn, "run", serve)
    cli.main()
    assert ("FORWARDED_ALLOW_IPS is not set" in capsys.readouterr().out) is warned


@pytest.mark.parametrize(
    ("host", "external", "warned"),
    [("0.0.0.0", False, True), ("0.0.0.0", True, False), ("127.0.0.1", False, False)],
)
def test_network_binds_warn_when_the_master_key_is_in_the_instance(
    tmp_path, monkeypatch, capsys, host, external, warned
):
    monkeypatch.setattr(sealing, "_environment_keys", None)
    monkeypatch.delenv(sealing.KEY_VARIABLE, raising=False)
    home = tmp_path / "instance"
    if external:
        (tmp_path / "key").write_text(base64.b64encode(os.urandom(32)).decode())
        monkeypatch.setenv(sealing.KEY_FILE_VARIABLE, str(tmp_path / "key"))
    else:
        monkeypatch.delenv(sealing.KEY_FILE_VARIABLE, raising=False)
    monkeypatch.setattr(
        sys, "argv", ["duckpad", "start", "--home", str(home), "--host", host, "--no-browser"]
    )

    def serve(app, **options):
        with TestClient(app):
            pass

    monkeypatch.setattr(uvicorn, "run", serve)
    cli.main()
    assert ("master key that encrypts stored secrets" in capsys.readouterr().out) is warned
    assert (home / sealing.KEY_FILE).exists() is not external


def test_a_missing_master_key_is_reported_without_traceback(tmp_path, monkeypatch):
    monkeypatch.setattr(sealing, "_environment_keys", None)
    monkeypatch.delenv(sealing.KEY_VARIABLE, raising=False)
    monkeypatch.delenv(sealing.KEY_FILE_VARIABLE, raising=False)
    store = Store(tmp_path)
    store.put("settings", "oidc", {"enabled": False, "client_secret": "kept"})
    store.close()
    (tmp_path / sealing.KEY_FILE).unlink()
    result = subprocess.run(
        [sys.executable, "-m", "duckpad", "start", "--home", str(tmp_path), "--no-browser"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode != 0
    assert "duckpad-master.key is missing" in result.stderr
    assert "Traceback" not in result.stderr
