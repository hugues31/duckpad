"""Disposable local server for browser acceptance tests only."""

import secrets
import tempfile
from pathlib import Path

import uvicorn

from duckpad.app import create_app

with tempfile.TemporaryDirectory(prefix="duckpad-e2e-") as directory:
    app = create_app(Path(directory))
    salt = secrets.token_hex(32)
    app.state.auth.store.put(
        "auth", "admin", {"salt": salt, "hash": app.state.auth.hash("duckpad-browser-test", salt)}
    )
    uvicorn.run(app, host="127.0.0.1", port=8766, log_level="warning")
