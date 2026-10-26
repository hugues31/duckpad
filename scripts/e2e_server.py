"""Disposable local server for browser acceptance tests only."""

import os
import tempfile
from pathlib import Path

import uvicorn

from duckpad.app import create_app

with tempfile.TemporaryDirectory(prefix="duckpad-e2e-") as directory:
    app = create_app(Path(directory))
    app.state.access.update_user("admin", {"password": "duckpad-browser-test"})
    uvicorn.run(
        app, host="127.0.0.1", port=int(os.environ.get("DUCKPAD_E2E_PORT", "8766")), log_level="warning"
    )
