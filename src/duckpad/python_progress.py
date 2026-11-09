"""Worktree preparation and run diagnostics, readable while uv is still running."""

import json
import os
import re
import sys
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

import duckdb
from filelock import FileLock

from .monitoring import redact_log
from .types import Record
from .util import atomic_write

LOG_LIMIT = 16000
# A single server owns a home (instance.lock): an unfinished preparation from another process was interrupted.
PROCESS = uuid.uuid4().hex
OBSERVER = ContextVar("preparation_observer", default=None)


@contextmanager
def observe_preparation(callback):
    token = OBSERVER.set(callback)
    try:
        yield
    finally:
        OBSERVER.reset(token)


def status_path(home, project, worktree=None):
    root = Path(home) / "python" / "status"
    return root / project / (worktree + ".json") if worktree else root / (project + ".json")


def clean_output(text, *paths):
    """Keep package diagnostics without operator credentials or local runtime paths."""
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"(?:https?|file)://[^\s\"'<>]+", "<package-source>", text)
    for name, value in os.environ.items():
        if name.startswith("UV_INDEX") and name.endswith(("_PASSWORD", "_USERNAME")) and value:
            text = text.replace(value, "<redacted>")
    # Longest first, so a parent path does not split a nested one; "/" alone would mask every separator.
    for path in sorted(
        {str(path) for path in (*paths, sys.prefix, Path.home())} - {"/", ""}, key=len, reverse=True
    ):
        text = text.replace(path, "<environment>")
    return redact_log(text)


def environment_status(home, project, worktree=None):
    path = status_path(home, project, worktree)
    try:
        status: Record = json.loads(path.read_text())
    except FileNotFoundError:
        # Cancellation can remove the first preparation while the UI is polling it.
        status = {"state": "unprepared"}
    if status["state"] in ("resolving", "installing") and status.get("process") != PROCESS:
        status.update(
            state="error",
            finished_at=path.stat().st_mtime,
            error="Python environment preparation was interrupted when the server stopped",
        )
    if status.get("started_at"):
        status["elapsed_seconds"] = round(
            max(0, (status.get("finished_at") or time.time()) - status["started_at"]), 1
        )
    return {**status, "python": sys.version.split()[0], "duckdb": duckdb.__version__}


class Preparation:
    def __init__(self, home, project, state, *, worktree=None, start=True):
        self.home = home
        self.path = status_path(home, project, worktree) if project else None
        self.status = {
            "operation": uuid.uuid4().hex,
            "process": PROCESS,
            "state": state,
            "stage": "waiting",
            "started_at": time.time(),
            "finished_at": None,
            "error": None,
            "log": "",
            "log_truncated": False,
        }
        self.active = False
        # The status this preparation replaced, which a canceled run leaves in place.
        self.previous = None
        if start:
            self.start()

    def start(self):
        if not self.active:
            self.active = True
            self.save(initial=True)

    def save(self, *, initial=False):
        self.publish()
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.path.with_suffix(".lock"))):
            # A slower, older preparation must not overwrite the latest operation.
            if initial and self.path.exists():
                self.previous = self.path.read_text()
            if not initial and self.path.exists():
                current = json.loads(self.path.read_text())
                if current.get("operation") != self.status["operation"]:
                    return
            atomic_write(self.path, json.dumps(self.status))

    def publish(self):
        if observer := OBSERVER.get():
            observer(
                {
                    **self.status,
                    "elapsed_seconds": round(
                        max(0, (self.status["finished_at"] or time.time()) - self.status["started_at"]), 1
                    ),
                }
            )

    def step(self, stage):
        self.start()
        self.status["stage"] = stage
        self.save()

    def output(self, text, *, truncated=False):
        clean = clean_output(text, self.home)
        self.status.update(log=clean[-LOG_LIMIT:], log_truncated=truncated or len(clean) > LOG_LIMIT)
        self.save()

    def cancel(self):
        """Restore the replaced status: stopping a run neither prepared nor broke the environment."""
        if not self.active:
            return
        self.status.update(state="canceled", finished_at=time.time())
        self.publish()
        if self.path is None:
            return
        with FileLock(str(self.path.with_suffix(".lock"))):
            if (
                not self.path.exists()
                or json.loads(self.path.read_text()).get("operation") != self.status["operation"]
            ):
                return
            if self.previous is None:
                self.path.unlink()
            else:
                atomic_write(self.path, self.previous)

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
