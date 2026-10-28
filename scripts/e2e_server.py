"""Disposable local server for browser acceptance tests only."""

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import uvicorn
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from starlette.routing import Mount

from duckpad.app import create_app
from duckpad.util import Problem

# A real signing provider is exposed only by this disposable test entry point.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from oidc_provider import Provider

port = int(os.environ.get("DUCKPAD_E2E_PORT", "8766"))

with tempfile.TemporaryDirectory(prefix="duckpad-e2e-") as directory:
    app = create_app(Path(directory))
    provider = Provider(f"http://127.0.0.1:{port}/test-oidc")
    app.router.routes.insert(0, Mount("/test-oidc", app=provider.application()))
    # Browser Git tests use real disposable bare repositories without credentials or a network service.
    # Only this test entry point replaces transport; production URL validation, trusted hosts, account
    # keys and consent checks remain unchanged.
    remotes = app.state.services.projects.remotes
    network = remotes.network
    host_key = (
        ed25519.Ed25519PrivateKey.generate()
        .public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode()
    )
    remotes.credentials.save_hosts(
        f"example.invalid {host_key}\n", ["https://example.invalid/e2e/", "git@example.invalid:e2e/"]
    )

    def disposable_transport(path, *args, key=None):
        urls = [
            arg
            for arg in args
            if re.fullmatch(r"(https://example\.invalid/e2e/|git@example\.invalid:e2e/)[a-z0-9-]+\.git", arg)
        ]
        # SSH origins reach this transport only with the requesting account's key.
        if not urls or urls[0].startswith("git@") != bool(key):
            return network(path, *args, key=key)
        remote = Path(directory) / "remotes" / urls[0].rsplit("/", 1)[1]
        if not remote.exists():
            remote.parent.mkdir(exist_ok=True)
            subprocess.run(
                ["git", "init", "--bare", "-b", "main", str(remote)], check=True, capture_output=True
            )
        result = subprocess.run(
            ["git", "-C", str(path), *[str(remote) if arg in urls else arg for arg in args]],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode:
            raise Problem("Disposable remote rejected the operation; fetch and review again", 409)
        return result.stdout.strip()

    remotes.network = disposable_transport
    app.state.access.update_user("admin", {"password": "duckpad-browser-test"})
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
