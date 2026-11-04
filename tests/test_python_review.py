"""Regression coverage for Python worker and environment review findings."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from helpers import wait_run
from test_python_nodes import flow, single

from duckpad.bundle import bundle_to_files, default_pyproject
from duckpad.python_environment import validate_manifest
from duckpad.python_execution import BoundedLog
from duckpad.util import Problem


@pytest.mark.parametrize(
    "setting",
    [
        'cache-dir = "/unapproved"',
        'find-links = ["file:///unapproved"]',
        'index = [{url = "https://unapproved.invalid/simple"}]',
        'override-dependencies = ["duckdb==0.1"]',
    ],
)
def test_manifest_cannot_configure_the_operator_resolver(setting):
    source = default_pyproject("Review").replace("package = false", "package = false\n" + setting)
    with pytest.raises(Problem, match=r"Only tool\.uv"):
        validate_manifest(source)


@pytest.mark.parametrize("table", ["project.optional-dependencies", "dependency-groups"])
@pytest.mark.parametrize(
    "dependency", ["duckpad", "duckpad[server]>=1", "helper @ file:///private", "duckdb>=1"]
)
def test_all_dependency_lists_enforce_the_runtime_policy(table, dependency):
    with pytest.raises(Problem):
        validate_manifest(default_pyproject("Review") + f'\n[{table}]\nextra = ["{dependency}"]\n')


def test_environment_resolution_preserves_windows_bytes(tmp_path, monkeypatch):
    from duckpad import python_environment as environment

    source = default_pyproject("Review").replace("\n", "\r\n")
    lock = "version = 1\r\nrevision = 3\r\n"
    wheel = tmp_path / "runtime.whl"
    wheel.write_bytes(b"runtime")
    monkeypatch.setattr(environment, "runtime_wheel", lambda _: wheel)

    def command(arguments, directory, **options):
        assert (directory / "pyproject.toml").read_bytes() == source.encode()
        assert (directory / "uv.lock").read_bytes() == lock.encode()

    monkeypatch.setattr(environment, "command", command)
    assert environment.resolve_lock({"pyproject.toml": source, "uv.lock": lock}, tmp_path) == lock


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_project_manifest_writes_preserve_existing_newlines(tmp_path, newline):
    from duckpad.util import atomic_write

    path = tmp_path / "pyproject.toml"
    source = default_pyproject("Review").replace("\n", newline)
    for _ in range(3):
        atomic_write(path, source)
        assert path.read_bytes() == source.encode("utf-8")
        source = path.read_bytes().decode("utf-8")
        validate_manifest(source)


def test_resolver_uses_only_operator_configuration_and_wheels(tmp_path, monkeypatch):
    from duckpad import python_environment as environment

    observed = []

    def run(arguments, **options):
        observed.append((arguments, options))
        return subprocess.CompletedProcess(arguments, 0, "", "")

    monkeypatch.setattr(environment.subprocess, "run", run)
    monkeypatch.setenv("UV_CONFIG_FILE", "/unapproved/config.toml")
    monkeypatch.setenv("UV_NO_BUILD", "false")
    environment.command(["sync", "--locked"], tmp_path)
    arguments, options = observed[0]
    assert "--no-config" in arguments and "--no-build" in arguments
    assert "UV_CONFIG_FILE" not in options["env"] and "UV_NO_BUILD" not in options["env"]


def test_log_buffer_retains_exact_tail_after_many_small_writes():
    log = BoundedLog()
    for _ in range(100_000):
        assert log.write("abc\n") == 4
    assert log.text == ("abc\n" * 100_000)[-65536:]
    log.write("x" * 100_000)
    assert log.text == "x" * 65536


def test_subprocess_cannot_consume_worker_commands(services):
    store, _, _, engine = services
    tree = single(
        services,
        """import duckpad as dp
import subprocess, sys
class ReadStdin(dp.Node):
    def run(self) -> dp.Relation:
        child = subprocess.run([sys.executable, "-c", "import sys; assert sys.stdin.read() == ''"], timeout=5)
        assert child.returncode == 0
        return self.db.sql("SELECT 42 AS answer")
""",
    )
    run = wait_run(store, engine.launch(tree["id"], "dev"), timeout=30)
    assert run["status"] == "success", run["nodes"]
    assert engine.preview(tree["id"], "dev", "python")["rows"][0]["values"] == [42]
    assert run["nodes"]["python"]["outputs"]["result"]["duration"] >= 0


def test_sql_only_launch_never_resolves_python_dependencies(services, monkeypatch):
    from duckpad import python_environment as environment

    store, _, _, engine = services
    tree = flow(services)

    def forbidden(*args, **kwargs):
        pytest.fail("SQL-only execution must not prepare Python")

    monkeypatch.setattr(environment, "lock_files", forbidden)
    monkeypatch.setattr(environment, "prepare", forbidden)
    assert wait_run(store, engine.launch(tree["id"], "dev", "source"))["status"] == "success"


@pytest.mark.skipif(sys.platform != "linux", reason="POSIX address-space limit")
def test_python_memory_exhaustion_is_a_run_failure(services):
    store, projects, _, engine = services
    tree = single(
        services,
        """import duckpad as dp
import resource
class Exhaust(dp.Node):
    def run(self) -> None:
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, resource.RLIM_INFINITY))
        bytearray(1024 * 1024 * 1024)
""",
    )
    run = wait_run(store, engine.launch(tree["id"], "dev"), timeout=30)
    assert run["status"] == "failed"
    assert "MemoryError" in run["nodes"]["python"]["error"]
    assert "worker was restarted" in run["nodes"]["python"]["error"]
    # The lowered limit must not survive in a worker that later queries would reuse.
    assert engine.pool.contexts[(tree["id"], "dev")].db.closed
    again = wait_run(store, engine.launch(tree["id"], "dev"), timeout=30)
    assert again["status"] == "failed" and "MemoryError" in again["nodes"]["python"]["error"]
    assert projects.snapshot(tree["id"])["bundle"]


def test_python_limits_are_restored_after_the_node(services):
    store, _, _, engine = services
    code = """import duckpad as dp
import resource
class Narrow(dp.Node):
    def run(self) -> dp.Relation:
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        resource.setrlimit(resource.RLIMIT_NOFILE, (min(soft, 64), hard))
        return self.db.sql("SELECT 1 AS x")
"""
    tree = single(services, code)
    run = wait_run(store, engine.launch(tree["id"], "dev"), timeout=30)
    assert run["status"] == "success", run["nodes"]["python"].get("error")
    context = engine.context(tree["id"], "dev")
    assert not context.db.closed
    with context.db.cursor() as cursor:
        assert cursor.execute("SELECT count(*) FROM range(10)").fetchone() == (10,)


def test_partition_validation_prevents_write(tmp_path):
    import duckdb

    from duckpad.python_execution import execute

    marker = tmp_path / "written"
    code = f"""import duckpad as dp
from pathlib import Path
class Source(dp.Node):
    def run(self) -> dp.Relation:
        return self.db.sql("SELECT 1 AS wrong_column")
    def write(self):
        Path({str(marker)!r}).write_text("unexpected")
"""
    # Use the same native cursor adapter as the worker.
    from duckpad.sql_worker import Cursor

    with duckdb.connect() as db:
        cursor = Cursor(db)
        result = execute(
            cursor,
            {
                "code": code,
                "parameters": {},
                "inputs": {},
                "outputs": {"result": "staged"},
                "workspace": str(tmp_path / "execution"),
                "partition": {"key": {"type": "number", "value": 1}},
                "partition_filters": {"result": {"column": "batch"}},
            },
        )
        assert "partition_column" in result["error"]
        assert not marker.exists()


def test_python_benchmark_records_peak_memory(tmp_path):
    result = subprocess.run(
        [sys.executable, "scripts/benchmark_python.py", "--rows", "10000"],
        capture_output=True,
        text=True,
        timeout=90,
        env={**os.environ, "TMPDIR": str(tmp_path)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["output_rows"] == 5000
    assert report["peak_combined_rss_mib"] > 0 and report["incremental_rss_mib"] < 512


def test_same_environment_supports_two_live_workers(services):
    store, _, _, engine = services
    tree = flow(services)
    for environment in ("dev", "prod"):
        run = wait_run(store, engine.launch(tree["id"], environment), timeout=30)
        assert run["status"] == "success", run["nodes"]
    assert (
        engine.context(tree["id"], "dev").db.process.pid != engine.context(tree["id"], "prod").db.process.pid
    )


def test_environment_cleanup_preserves_active_leases(tmp_path):
    from filelock import FileLock

    from duckpad.python_environment import prune_environments

    directory = tmp_path / "environment"
    directory.mkdir()
    marker = directory / "ready.json"
    marker.write_text("{}")
    os.utime(marker, (0, 0))
    with FileLock(str(directory) + ".lease.worker"):
        prune_environments(tmp_path)
        assert directory.exists()
    prune_environments(tmp_path)
    assert not directory.exists()


def test_environment_cleanup_errors_and_leftovers(tmp_path, monkeypatch):
    import shutil

    from duckpad import python_environment

    old = time.time() - 8 * 86400
    unused = tmp_path / "unused"
    (unused / "ready.json").parent.mkdir()
    (unused / "ready.json").write_text("{}")
    os.utime(unused / "ready.json", (old, old))
    interrupted = tmp_path / ("a" * 64)
    interrupted.mkdir()
    os.utime(interrupted, (old, old))
    (tmp_path / ("b" * 64 + ".lock")).write_text("")
    os.utime(tmp_path / ("b" * 64 + ".lock"), (old, old))
    wheels = tmp_path / "wheels" / "0123456789abcdef"
    wheels.mkdir(parents=True)
    os.utime(wheels, (old, old))
    real = shutil.rmtree

    def refuse(path, *args, **kwargs):
        if Path(path) == unused:
            raise PermissionError("busy")
        return real(path, *args, **kwargs)

    monkeypatch.setattr(python_environment.shutil, "rmtree", refuse)
    python_environment.prune_environments(tmp_path)
    assert unused.exists()
    assert not interrupted.exists() and not wheels.exists()
    assert not (tmp_path / ("b" * 64 + ".lock")).exists()


def test_helper_modules_cannot_shadow_the_sdk(services):
    _, projects, _, _ = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree["id"])
    files = {**snapshot["files"], "modules/duckpad.py": "x = 1\n", "modules/2024/report.py": "x = 2\n"}
    projects.write(worktree["id"], snapshot["revision"], files)
    problems = {d["file"]: d["message"] for d in projects.snapshot(worktree["id"])["diagnostics"]}
    assert "replace the Duckpad SDK" in problems["modules/duckpad.py"]
    assert "Python identifiers" in problems["modules/2024/report.py"]


def test_first_python_run_keeps_existing_sql_results(services):
    store, projects, _, engine = services
    worktree = single(
        services,
        "import duckpad as dp\nclass Source(dp.Node):\n    def run(self) -> dp.Relation:\n        return self.db.sql('SELECT 2 AS two')\n",
    )
    snapshot = projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"].append({"id": "other", "template": "other", "params": {}})
    bundle["templates"]["other"] = "-- @output result\nSELECT 7 AS seven"
    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    assert wait_run(store, engine.launch(worktree["id"], "dev", "other"), timeout=60)["status"] == "success"
    sql_worker = engine.context(worktree["id"], "dev").db
    assert wait_run(store, engine.launch(worktree["id"], "dev", "python"), timeout=120)["status"] == "success"
    # The run moved to the project environment's worker and brought the SQL result along.
    assert engine.context(worktree["id"], "dev").db is not sql_worker
    assert [row["values"] for row in engine.preview(worktree["id"], "dev", "other")["rows"]] == [[7]]


def test_unrelated_save_merges_a_concurrent_dependency_change(services):
    _, projects, _, _ = services
    tree = flow(services)
    base = projects.snapshot(tree["id"])
    files = base["files"]
    edited = files["pyproject.toml"].replace('version = "0.1.0"', 'version = "0.1.1"')
    assert edited != files["pyproject.toml"]
    changed = projects.write(tree["id"], base["revision"], {**files, "pyproject.toml": edited})
    saved = projects.write(tree["id"], base["revision"], {**files, "README.md": "Unrelated edit\n"})
    assert saved["files"]["README.md"] == "Unrelated edit\n"
    assert saved["files"]["pyproject.toml"] == edited
    assert saved["files"]["uv.lock"] == changed["files"]["uv.lock"]
    both = files["pyproject.toml"].replace('version = "0.1.0"', 'version = "0.2.0"')
    # Editing the manifest on both sides still needs a reviewed resolution.
    with pytest.raises(Problem) as refused:
        projects.write(tree["id"], base["revision"], {**files, "pyproject.toml": both})
    assert refused.value.status == 409


def test_float_defaults_are_normalized_for_direct_calls():
    import duckpad as dp

    class Numeric(dp.Node):
        minimum: float = 1

    assert type(Numeric().minimum) is float
    assert Numeric(minimum=2).minimum == 2.0


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX kill signal")
def test_killed_worker_reports_stderr_and_recovers(services):
    store, projects, _, engine = services
    tree = single(
        services,
        """import duckpad as dp
import os, signal
class Killed(dp.Node):
    def run(self) -> None:
        os.write(2, b"native failure evidence\\n")
        os.kill(os.getpid(), signal.SIGKILL)
""",
    )
    run = wait_run(store, engine.launch(tree["id"], "dev"), timeout=30)
    assert run["status"] == "failed"
    assert "native failure evidence" in run["nodes"]["python"]["error"]
    assert "exit -9" in run["nodes"]["python"]["error"]
    snapshot = projects.snapshot(tree["id"])
    projects.write(
        tree["id"],
        snapshot["revision"],
        {
            **snapshot["files"],
            "nodes/python.py": "import duckpad as dp\nclass Recovered(dp.Node):\n    def run(self) -> dp.Relation:\n        return self.db.sql('SELECT 42 AS answer')\n",
        },
    )
    assert wait_run(store, engine.launch(tree["id"], "dev"), timeout=30)["status"] == "success"


def test_dependency_resolution_does_not_hold_repository_lock(services, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    from duckpad import python_environment

    _, projects, _, _ = services
    tree = flow(services)
    snapshot = projects.snapshot(tree["id"])
    resolve = python_environment.lock_files

    def resolve_while_readable(*args, **kwargs):
        with ThreadPoolExecutor(1) as executor:
            assert executor.submit(projects.snapshot, tree["id"]).result(timeout=2)["revision"]
        return resolve(*args, **kwargs)

    monkeypatch.setattr(python_environment, "lock_files", resolve_while_readable)
    projects.write(
        tree["id"], snapshot["revision"], {**snapshot["files"], "README.md": "Updated description\n"}
    )
