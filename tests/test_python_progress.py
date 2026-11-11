"""Observe preparation before completion, retain failures and bound diagnostic output."""

import sys
from concurrent.futures import ThreadPoolExecutor

import pytest
from helpers import wait_run, wait_until
from test_python_nodes import flow

from duckpad import python_environment as environment
from duckpad import python_progress as progress_module
from duckpad.python_progress import LOG_LIMIT, Preparation, clean_output, environment_status
from duckpad.util import Problem


def test_command_publishes_live_output_and_masks_operator_details(tmp_path, monkeypatch):
    monkeypatch.setattr(environment, "uv_executable", lambda: sys.executable)
    monkeypatch.setenv("UV_INDEX_INTERNAL_PASSWORD", "operator-password")
    progress = Preparation(tmp_path, "worktree", "installing")
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
            wait_until(lambda: "Downloading package" in environment_status(tmp_path, "worktree")["log"])
            status = environment_status(tmp_path, "worktree")
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
    status = environment_status(tmp_path, "worktree")
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
        environment.prepare({}, tmp_path, "project", worktree="worktree")
    status = environment_status(tmp_path, "worktree")
    assert status["state"] == "error" and status["finished_at"]
    assert "Dependency unavailable" in status["log"]
    assert status["error"]


def test_verbose_output_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(environment, "uv_executable", lambda: sys.executable)
    progress = Preparation(tmp_path, "worktree", "resolving")
    environment.command(
        ["-c", "print('old output'); print('package line\\n' * 5000); print('Resolved packages')"],
        tmp_path,
        allow_builds=True,
        progress=progress,
    )
    status = environment_status(tmp_path, "worktree")
    assert len(status["log"]) <= LOG_LIMIT
    assert status["log_truncated"]
    assert "old output" not in status["log"]
    assert "Resolved packages" in status["log"]


def test_older_preparation_cannot_replace_latest_status(tmp_path):
    older = Preparation(tmp_path, "worktree", "resolving")
    newer = Preparation(tmp_path, "worktree", "installing")
    newer.output("Installing packages")
    older.output("Older resolver output")
    older.finish("error", "Older failure")
    status = environment_status(tmp_path, "worktree")
    assert status["state"] == "installing"
    assert status["log"] == "Installing packages"
    assert status["error"] is None
    assert environment_status(tmp_path, "other")["state"] == "unprepared"


def test_preparation_interrupted_by_a_server_stop_is_reported(tmp_path, monkeypatch):
    Preparation(tmp_path, "worktree", "installing").output("Downloading package")
    assert environment_status(tmp_path, "worktree")["state"] == "installing"
    monkeypatch.setattr(progress_module, "PROCESS", "restarted-server")
    status = environment_status(tmp_path, "worktree")
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
    status = environment_status(store.home, tree["id"])
    assert status["state"] == "locked" and "Resolved" in status["log"]
    first = environment.prepare(files, store.home, project, worktree=tree["id"])
    status = environment_status(store.home, tree["id"])
    assert status["state"] == "ready" and "Installed" in status["log"]
    # Starting another worker on a ready environment is not a new preparation.
    assert environment.prepare(files, store.home, project, worktree=tree["id"]) == first
    assert environment_status(store.home, tree["id"]) == status
    environment.lock_files(files, store.home, worktree=tree["id"])
    # A run reusing its existing worker does not prepare again after this cache hit.
    assert environment_status(store.home, tree["id"]) == status

    def forbidden(*args, **kwargs):
        pytest.fail("Cached environments must not run uv")

    monkeypatch.setattr(environment, "command", forbidden)
    with pytest.raises(Problem):
        environment.lock_files({"pyproject.toml": "invalid"}, store.home, worktree=tree["id"])
    assert environment_status(store.home, tree["id"])["state"] == "error"
    assert environment.lock_files(files, store.home, worktree=tree["id"]) == files["uv.lock"]
    status = environment_status(store.home, tree["id"])
    assert status["state"] == "locked" and status["error"] is None
    assert environment.prepare(files, store.home, project, worktree=tree["id"]) == first
    status = environment_status(store.home, tree["id"])
    assert status["state"] == "ready" and status["stage"] == "cached"
    assert not status["log"]


def test_canceled_preparation_restores_the_status_it_replaced(tmp_path):
    Preparation(tmp_path, "worktree", "installing").finish("ready")
    stopped = Preparation(tmp_path, "worktree", "resolving")
    stopped.step("resolving")
    assert environment_status(tmp_path, "worktree")["state"] == "resolving"
    stopped.cancel()
    assert environment_status(tmp_path, "worktree")["state"] == "ready"


def test_preparation_states_are_independent_for_branches_and_jobs(services):
    store, projects, _, _ = services
    main = flow(services)
    branch = projects.branch(main["id"], "different-dependencies")
    job = projects.job_worktree(main["project"], projects.snapshot(main["id"])["commit"])
    environment.prepare(
        projects.snapshot(main["id"])["files"], store.home, main["project"], worktree=main["id"]
    )
    snapshot = projects.snapshot(branch["id"])
    with pytest.raises(Problem):
        projects.write(branch["id"], snapshot["revision"], {**snapshot["files"], "pyproject.toml": "invalid"})
    assert environment_status(store.home, branch["id"])["state"] == "error"
    assert environment_status(store.home, main["id"])["state"] == "ready"
    progress = Preparation(store.home, job["id"], "installing")
    progress.output("Job installation")
    assert environment_status(store.home, job["id"])["log"] == "Job installation"
    progress.cancel()
    assert environment_status(store.home, job["id"])["state"] == "unprepared"
    assert environment_status(store.home, branch["id"])["state"] == "error"


@pytest.mark.parametrize("fail", [False, True])
def test_run_retains_its_preparation_after_another_operation(services, monkeypatch, fail):
    store, _, _, engine = services
    tree = flow(services)
    if fail:

        def unavailable(files, home, project, *, progress, **kwargs):
            progress.step("installing")
            progress.output("Package unavailable at https://user:secret@example.invalid/simple")
            raise Problem("Package unavailable", 422)

        monkeypatch.setattr(environment, "prepare_environment", unavailable)
    run = wait_run(store, engine.launch(tree["id"], "dev"))
    assert run["status"] == ("failed" if fail else "success")
    preparation = run["preparation"][-1]
    assert preparation["state"] == ("error" if fail else "ready")
    assert ("Package unavailable" if fail else "Installed") in preparation["log"]
    assert "secret" not in preparation["log"] and "process" not in preparation
    Preparation(store.home, tree["id"], "resolving").finish("locked")
    assert store.get("run", run["id"])["preparation"] == run["preparation"]


def test_status_api_selects_the_worktree_and_checks_its_project(tmp_path):
    from fastapi.testclient import TestClient

    from duckpad.app import create_app

    app = create_app(tmp_path / "api")
    with TestClient(app) as client:
        assert client.post(
            "/api/login", json={"username": "admin", "password": app.state.auth.initial_password}
        ).is_success
        main = client.post("/api/projects", json={"name": "Branches"}).json()
        other = client.post("/api/projects", json={"name": "Other"}).json()
        branch = app.state.services.projects.branch(main["id"], "experiment")
        home = app.state.services.store.home
        Preparation(home, main["id"], "installing").finish("ready")
        Preparation(home, branch["id"], "resolving").finish("error", "Branch failure")
        url = f"/api/projects/{main['project']}/python/environment"
        assert client.get(url).json()["state"] == "ready"
        assert client.get(url, params={"worktree": branch["id"]}).json()["error"] == "Branch failure"
        assert client.get(url, params={"worktree": other["id"]}).status_code == 404
        assert client.get(url, params={"worktree": "missing"}).status_code == 404


def test_preparation_status_is_removed_with_its_worktree(services):
    store, projects, _, _ = services
    main = projects.create("Python status")
    branch = projects.branch(main["id"], "experiment")
    for key in (main["id"], branch["id"], "worktree_interrupted_cleanup"):
        Preparation(store.home, key, "installing").finish("ready")
    # A restart finishes cleanups interrupted after the worktree record was deleted.
    projects.start_watcher()
    assert not store.paths.python_status("worktree_interrupted_cleanup").exists()
    assert store.paths.python_status(branch["id"]).exists()
    projects.delete(main["project"])
    assert not any(store.paths.python_status(key).exists() for key in (main["id"], branch["id"]))
