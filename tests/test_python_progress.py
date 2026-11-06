"""Observe preparation before completion, retain failures and bound diagnostic output."""

import sys
from concurrent.futures import ThreadPoolExecutor

import pytest
from helpers import wait_until
from test_python_nodes import flow

from duckpad import python_environment as environment
from duckpad import python_progress as progress_module
from duckpad.python_progress import LOG_LIMIT, Preparation, clean_output, environment_status
from duckpad.util import Problem


def test_command_publishes_live_output_and_masks_operator_details(tmp_path, monkeypatch):
    monkeypatch.setattr(environment, "uv_executable", lambda: sys.executable)
    monkeypatch.setenv("UV_INDEX_INTERNAL_PASSWORD", "operator-password")
    progress = Preparation(tmp_path, "project", "installing")
    gate = tmp_path / "finish"
    script = f"""
import sys, time
from pathlib import Path
print('Downloading package https://user:secret@index.example.invalid/simple?token=hidden', flush=True)
print('operator-password at ' + {str(tmp_path)!r}, file=sys.stderr, flush=True)
while not Path({str(gate)!r}).exists():
    time.sleep(0.02)
print('Installed package', flush=True)
"""
    with ThreadPoolExecutor(1) as executor:
        running = executor.submit(
            environment.command, ["-c", script], tmp_path, allow_builds=True, progress=progress
        )
        try:
            wait_until(lambda: "Downloading package" in environment_status(tmp_path, "project")["log"])
            status = environment_status(tmp_path, "project")
            assert not running.done()
            assert status["state"] == "installing" and status["finished_at"] is None
            assert "<package-source>" in status["log"]
            assert "<environment>" in status["log"]
            for private in ("secret", "hidden", "operator-password", str(tmp_path), "index.example.invalid"):
                assert private not in status["log"]
        finally:
            gate.touch()
        running.result(timeout=5)
    progress.finish("ready")
    status = environment_status(tmp_path, "project")
    assert status["state"] == "ready" and status["finished_at"]
    assert "Installed package" in status["log"]
    assert status["elapsed_seconds"] >= 0


@pytest.mark.parametrize("timeout", [False, True])
def test_command_failure_keeps_output_and_finishes_status(tmp_path, monkeypatch, timeout):
    monkeypatch.setattr(environment, "uv_executable", lambda: sys.executable)
    monkeypatch.setattr(environment, "COMMAND_TIMEOUT", 0.4 if timeout else 5)

    def prepare(*args, progress, **kwargs):
        environment.command(
            [
                "-c",
                "import time; print('Dependency unavailable', flush=True); "
                + ("time.sleep(30)" if timeout else "raise SystemExit(1)"),
            ],
            tmp_path,
            allow_builds=True,
            progress=progress,
        )

    monkeypatch.setattr(environment, "prepare_environment", prepare)
    with pytest.raises(Problem, match="timed out" if timeout else "Dependency unavailable"):
        environment.prepare({}, tmp_path, "project")
    status = environment_status(tmp_path, "project")
    assert status["state"] == "error" and status["finished_at"]
    assert "Dependency unavailable" in status["log"]
    assert status["error"]


def test_verbose_output_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(environment, "uv_executable", lambda: sys.executable)
    progress = Preparation(tmp_path, "project", "resolving")
    environment.command(
        ["-c", "print('old output'); print('package line\\n' * 5000); print('Resolved packages')"],
        tmp_path,
        allow_builds=True,
        progress=progress,
    )
    status = environment_status(tmp_path, "project")
    assert len(status["log"]) <= LOG_LIMIT
    assert status["log_truncated"]
    assert "old output" not in status["log"]
    assert "Resolved packages" in status["log"]


def test_older_preparation_cannot_replace_latest_status(tmp_path):
    older = Preparation(tmp_path, "project", "resolving")
    newer = Preparation(tmp_path, "project", "installing")
    newer.output("Installing packages")
    older.output("Older resolver output")
    older.finish("error", "Older failure")
    status = environment_status(tmp_path, "project")
    assert status["state"] == "installing"
    assert status["log"] == "Installing packages"
    assert status["error"] is None
    assert environment_status(tmp_path, "other")["state"] == "unprepared"


def test_preparation_interrupted_by_a_server_stop_is_reported(tmp_path, monkeypatch):
    Preparation(tmp_path, "project", "installing").output("Downloading package")
    assert environment_status(tmp_path, "project")["state"] == "installing"
    monkeypatch.setattr(progress_module, "PROCESS", "restarted-server")
    status = environment_status(tmp_path, "project")
    assert status["state"] == "error" and "interrupted" in status["error"]
    assert status["log"] == "Downloading package" and status["finished_at"]


def test_root_home_does_not_mask_path_separators(monkeypatch):
    monkeypatch.setenv("HOME", "/")
    assert clean_output("Installed into .venv/lib/site-packages") == "Installed into .venv/lib/site-packages"


def test_real_preparation_and_cache_reuse_replace_previous_errors(services, monkeypatch):
    store, projects, _, _ = services
    tree = flow(services)
    project = tree["project"]
    files = projects.snapshot(tree["id"])["files"]
    status = environment_status(store.home, project)
    assert status["state"] == "locked" and "Resolved" in status["log"]
    first = environment.prepare(files, store.home, project)
    status = environment_status(store.home, project)
    assert status["state"] == "ready" and "Installed" in status["log"]
    # Starting another worker on a ready environment is not a new preparation.
    assert environment.prepare(files, store.home, project) == first
    assert environment_status(store.home, project) == status
    environment.lock_files(files, store.home, project=project)
    # A run reusing its existing worker does not prepare again after this cache hit.
    assert environment_status(store.home, project) == status

    def forbidden(*args, **kwargs):
        pytest.fail("Cached environments must not run uv")

    monkeypatch.setattr(environment, "command", forbidden)
    with pytest.raises(Problem):
        environment.lock_files({"pyproject.toml": "invalid"}, store.home, project=project)
    assert environment_status(store.home, project)["state"] == "error"
    assert environment.lock_files(files, store.home, project=project) == files["uv.lock"]
    status = environment_status(store.home, project)
    assert status["state"] == "locked" and status["error"] is None
    assert environment.prepare(files, store.home, project) == first
    status = environment_status(store.home, project)
    assert status["state"] == "ready" and status["stage"] == "cached"
    assert not status["log"]
