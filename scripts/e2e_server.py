"""Disposable local server for browser acceptance tests only."""

import tempfile
from pathlib import Path

import uvicorn

from duckpad.app import create_app

with tempfile.TemporaryDirectory(prefix="duckpad-e2e-") as directory:
    app = create_app(Path(directory))
    app.state.auth.set_password("duckpad-browser-test")
    uvicorn.run(app, host="127.0.0.1", port=8766, log_level="warning")
