"""Latest project preparation, readable while uv is still running."""

import json
import os
import re
import sys
import time
import uuid
from pathlib import Path

import duckdb
from filelock import FileLock

from .monitoring import redact_log
from .types import Record
from .util import atomic_write

LOG_LIMIT = 16000


def clean_output(text, *paths):
    """Keep package diagnostics without operator credentials or local runtime paths."""
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"(?:https?|file)://[^\s\"'<>]+", "<package-source>", text)
    for name, value in os.environ.items():
        if name.startswith("UV_INDEX") and name.endswith(("_PASSWORD", "_USERNAME")) and value:
            text = text.replace(value, "<redacted>")
    for path in (*paths, sys.prefix, Path.home()):
        text = text.replace(str(path), "<environment>")
    return redact_log(text)


def environment_status(home, project):
    path = Path(home) / "python" / "status" / (project + ".json")
    status: Record = json.loads(path.read_text()) if path.exists() else {"state": "unprepared"}
    if status.get("started_at"):
        status["elapsed_seconds"] = round(
            max(0, (status.get("finished_at") or time.time()) - status["started_at"]), 1
        )
    return {**status, "python": sys.version.split()[0], "duckdb": duckdb.__version__}


class Preparation:
    def __init__(self, home, project, state, *, start=True):
        self.home = home
        self.path = Path(home) / "python" / "status" / (project + ".json") if project else None
        self.status = {
            "operation": uuid.uuid4().hex,
            "state": state,
            "stage": "waiting",
            "started_at": time.time(),
            "finished_at": None,
            "error": None,
            "log": "",
            "log_truncated": False,
        }
        self.active = False
        if start:
            self.start()

    def start(self):
        if not self.active:
            self.active = True
            self.save(initial=True)

    def save(self, *, initial=False):
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.path.with_suffix(".lock"))):
            # A slower, older preparation must not overwrite the latest operation.
            if not initial and self.path.exists():
                current = json.loads(self.path.read_text())
                if current.get("operation") != self.status["operation"]:
                    return
            atomic_write(self.path, json.dumps(self.status))

    def step(self, stage):
        self.start()
        self.status["stage"] = stage
        self.save()

    def output(self, text, *, truncated=False):
        clean = clean_output(text, self.home)
        self.status.update(log=clean[-LOG_LIMIT:], log_truncated=truncated or len(clean) > LOG_LIMIT)
        self.save()

    def finish(self, state, error=None):
        if error:
            self.start()
        if not self.active:
            return
        self.status.update(
            state=state,
            finished_at=time.time(),
            error=clean_output(str(error), self.home) if error else None,
        )
        self.save()
