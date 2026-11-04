"""Python execution inside the shared context worker: standard streams, limits, crashes and results."""

import json
import os
import subprocess
import sys

import pytest
from helpers import wait_run
from test_python_nodes import single

from duckpad.bundle import bundle_to_files
from duckpad.python_execution import BoundedLog


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


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX resource limits")
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
