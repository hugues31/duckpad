"""Startup messages and failures should be actionable."""

import base64
import os
import re
import subprocess
import sys

import pytest
import uvicorn
from fastapi.testclient import TestClient

from duckpad import cli, sealing
from duckpad.paths import InstancePaths
from duckpad.store import Store


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
    assert InstancePaths(home).master_key.exists() is not external


def test_a_missing_master_key_is_reported_without_traceback(tmp_path, monkeypatch):
    monkeypatch.setattr(sealing, "_environment_keys", None)
    monkeypatch.delenv(sealing.KEY_VARIABLE, raising=False)
    monkeypatch.delenv(sealing.KEY_FILE_VARIABLE, raising=False)
    store = Store(tmp_path)
    store.put("settings", "oidc", {"enabled": False, "client_secret": "kept"})
    store.close()
    InstancePaths(tmp_path).master_key.unlink()
    result = subprocess.run(
        [sys.executable, "-m", "duckpad", "start", "--home", str(tmp_path), "--no-browser"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode != 0
    assert "duckpad-master.key is missing" in result.stderr
    assert "Traceback" not in result.stderr


def start_instance(monkeypatch, home, *options):
    """Start the CLI server without serving requests; return the address it would open."""
    opened = []

    class Timer:
        def __init__(self, delay, action):
            self.action = action

        def start(self):
            self.action()

    def serve(app, **options):
        with TestClient(app):
            pass

    monkeypatch.setattr(cli.threading, "Timer", Timer)
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    monkeypatch.setattr(uvicorn, "run", serve)
    monkeypatch.setattr(sys, "argv", ["duckpad", "start", "--home", str(home), *options])
    cli.main()
    return opened


def test_first_launch_opens_a_setup_link_and_prints_a_fallback_password(tmp_path, monkeypatch, capsys):
    home = tmp_path / "instance"
    opened = start_instance(monkeypatch, home, "--port", "8799")
    output = capsys.readouterr().out
    [link] = re.findall(r"http://127\.0\.0\.1:8799/#setup=[\w-]+", output)
    assert opened == [link]
    assert "(it opens by itself)" in output
    assert re.search(r"^Username: admin\nPassword: \S+$", output, re.MULTILINE)
    assert f"If you lose it, run: duckpad reset-password --home {home}" in output
    opened = start_instance(monkeypatch, home, "--port", "8799")
    output = capsys.readouterr().out
    assert opened == ["http://127.0.0.1:8799"]
    assert "setup=" not in output and "Password:" not in output


def test_headless_first_launch_prints_a_browsable_setup_link(tmp_path, monkeypatch, capsys):
    opened = start_instance(monkeypatch, tmp_path / "instance", "--host", "0.0.0.0", "--no-browser")
    output = capsys.readouterr().out
    assert opened == []
    assert "Duckpad · http://127.0.0.1:8765" in output
    assert re.search(r"browser:\n\n    http://127\.0\.0\.1:8765/#setup=[\w-]+\n", output)


@pytest.mark.parametrize(
    ("host", "url"),
    [
        ("127.0.0.1", "http://127.0.0.1:8765"),
        ("localhost", "http://localhost:8765"),
        ("0.0.0.0", "http://127.0.0.1:8765"),
        ("::", "http://127.0.0.1:8765"),
        ("::1", "http://[::1]:8765"),
        ("192.0.2.10", "http://192.0.2.10:8765"),
    ],
)
def test_browser_addresses_are_openable(host, url):
    assert cli.browser_url(host, 8765) == url


def test_the_reset_hint_omits_the_default_home(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert cli.reset_command(tmp_path / "duckpad") == "duckpad reset-password"
    assert cli.reset_command(tmp_path / "other") == f"duckpad reset-password --home {tmp_path / 'other'}"
    assert (
        cli.reset_command(tmp_path / "my instance")
        == f'duckpad reset-password --home "{tmp_path / "my instance"}"'
    )
