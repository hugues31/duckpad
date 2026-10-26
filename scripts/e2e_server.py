"""Disposable local server for browser acceptance tests only."""

import os
import re
import subprocess
import tempfile
from pathlib import Path

import uvicorn

from duckpad.app import create_app
from duckpad.util import Problem

with tempfile.TemporaryDirectory(prefix="duckpad-e2e-") as directory:
    app = create_app(Path(directory))
    # Browser Git tests use real disposable bare repositories without credentials or a network service.
    # Only this test entry point replaces transport; production URL validation remains unchanged.
    network = app.state.services.projects.remotes.network

    def disposable_transport(path, *args):
        urls = [arg for arg in args if re.fullmatch(r"https://example\.invalid/e2e/[a-z0-9-]+\.git", arg)]
        if not urls:
            return network(path, *args)
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

    app.state.services.projects.remotes.network = disposable_transport
    app.state.access.update_user("admin", {"password": "duckpad-browser-test"})
    uvicorn.run(
        app, host="127.0.0.1", port=int(os.environ.get("DUCKPAD_E2E_PORT", "8766")), log_level="warning"
    )
