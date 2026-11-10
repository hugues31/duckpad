import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from helpers import example_bundle, wait_run, wait_until

from duckpad.bundle import bundle_to_files
from duckpad.lineage import Lineage
from duckpad.trace import TraceQuery
from duckpad.util import Problem


def test_cancel_interrupts_active_duckdb_and_prevents_later_branch(services, tmp_path):
    store, projects, _, engine = services
    source = tmp_path / "input.csv"
    worktree = projects.create("Cancellation", example_bundle(source))["id"]
    previous = wait_run(store, engine.launch(worktree, "dev"))
    old = engine.preview(worktree, "dev", "filter")
    source.write_text("id,region,amount\n" + "".join(f"{i},North,{i}\n" for i in range(2500)))
    snapshot = projects.snapshot(worktree)
    snapshot["bundle"]["templates"]["filter"] = (
        "-- @input source\n-- @output result\nSELECT SUM(a.amount * b.amount + c.amount) AS total FROM {{ source }} a CROSS JOIN {{ source }} b CROSS JOIN {{ source }} c;"
    )
    snapshot["bundle"]["flow"]["nodes"].append({"id": "later", "template": "total", "params": {}})
    snapshot["bundle"]["flow"]["edges"].append(
        {
            "id": "later_edge",
            "source": "source",
            "sourceHandle": "result",
            "target": "later",
            "targetHandle": "source",
        }
    )
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    run = engine.launch(worktree, "dev")
    wait_until(
        lambda: (
            store.get("run", run["id"])["nodes"]
            .get("filter", {})
            .get("statements", [{}])[0]
            .get("materialization_sql")
        ),
        message="The long query did not start",
    )
    time.sleep(0.03)  # Let DuckDB enter the query that cancellation must interrupt.
    engine.cancel(run["id"])
    engine.cancel(run["id"])
    result = wait_run(store, run)
    assert result["status"] == "canceled"
    assert result["nodes"]["filter"]["status"] == "canceled"
    assert result["nodes"]["later"]["status"] == "canceled"
    retained = engine.preview(worktree, "dev", "filter")
    assert retained["id"] == old["id"] and retained["status"] == "stale"
    assert retained["run"] == previous["id"]
    assert engine.cancel(run["id"])["status"] == "canceled"


def test_recalculation_cancels_only_dependent_lineage_and_rejects_old_generation(
    services, tmp_path, monkeypatch
):
    store, projects, _, engine = services
    worktree = projects.create("Lineage priority", example_bundle(tmp_path / "input.csv"))["id"]
    wait_run(store, engine.launch(worktree, "dev"))
    old = engine.preview(worktree, "dev", "total")
    entered, release = threading.Event(), threading.Event()
    original = TraceQuery.trace

    def hold(self, *args, **kwargs):
        entered.set()
        release.wait(5)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(TraceQuery, "trace", hold)
    outcome = []

    def request():
        try:
            outcome.append(Lineage(engine).explain(worktree, "dev", old["id"], 0, "total"))
        except Problem as error:
            outcome.append(error)

    thread = threading.Thread(target=request)
    thread.start()
    assert entered.wait(2)
    run = engine.launch(worktree, "dev", "filter")
    wait_until(
        lambda: (
            old["id"] in engine.context(worktree, "dev").datasets
            and engine.context(worktree, "dev").datasets[old["id"]].status == "stale"
        )
    )
    with pytest.raises(Problem, match="unavailable or stale"):
        Lineage(engine).explain(worktree, "dev", old["id"], 0, "total")
    release.set()
    thread.join(5)
    assert isinstance(outcome[0], Problem) and outcome[0].status == 409
    assert wait_run(store, run)["status"] == "success"
    assert engine.preview(worktree, "dev", "total")["status"] == "stale"


def test_simultaneous_entry_points_admit_exactly_one_run(services, tmp_path, monkeypatch):

    store, projects, catalog, engine = services
    worktree = projects.create("Admission race", example_bundle(tmp_path / "race.csv"))["id"]
    barrier, release = threading.Barrier(3), threading.Event()
    original = catalog.prepare

    def hold(db, captured):
        release.wait(5)
        original(db, captured)

    monkeypatch.setattr(catalog, "prepare", hold)

    def launch(origin):
        barrier.wait()
        try:
            return engine.launch(worktree, "dev" if origin == "ui" else "prod", entry_point=origin)
        except Problem as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(launch, origin) for origin in ("ui", "api")]
        barrier.wait()
        outcomes = [future.result(3) for future in futures]
        accepted = [result for result in outcomes if isinstance(result, dict)]
        rejected = [result for result in outcomes if isinstance(result, Problem)]
        assert len(accepted) == len(rejected) == 1 and rejected[0].status == 409
        engine.cancel(accepted[0]["id"])
        release.set()
        assert wait_run(store, accepted[0])["status"] == "canceled"
    assert len(store.all("run")) == 1 and not engine.active


@pytest.mark.parametrize("close", [False, True])
@pytest.mark.parametrize("command", ["lock", "sync"])
def test_preparing_run_is_visible_and_cancellable_during_uv(services, tmp_path, monkeypatch, close, command):
    import os
    import sys

    from duckpad import python_environment

    store, projects, _, engine = services
    tree = projects.create("Preparing Python")
    snapshot = projects.snapshot(tree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"] = [{"id": "python", "language": "python", "params": {}}]
    bundle["node_sql"] = {
        "nodes/python.py": "import duckpad as dp\nclass Slow(dp.Node):\n    def run(self) -> None: pass\n"
    }
    projects.write(tree["id"], snapshot["revision"], bundle_to_files(bundle))
    store.put("settings", "python:" + tree["project"], {"enabled": True})
    if command == "sync":
        snapshot = projects.snapshot(tree["id"])
        locked = python_environment.lock_files(snapshot["files"], store.home)
        projects.write(tree["id"], snapshot["revision"], {**snapshot["files"], "uv.lock": locked})
    marker = tmp_path / "uv-started"
    uv = tmp_path / "uv"
    # The PID is published by renaming a complete file: the test reads the marker as soon as it exists.
    uv.write_text(
        f"#!{sys.executable}\nimport os, sys, time\nfrom pathlib import Path\nassert sys.argv[1] == {command!r}\n"
        "print('Preparing packages', flush=True)\n"
        f"Path({str(marker) + '.tmp'!r}).write_text(str(os.getpid()))\n"
        f"os.replace({str(marker) + '.tmp'!r}, {str(marker)!r})\ntime.sleep(60)\n"
    )
    uv.chmod(0o755)
    monkeypatch.setattr(python_environment, "uv_executable", lambda: str(uv))
    # Supply a tiny wheel to keep the fixture focused on the real uv command lifecycle.
    wheel = tmp_path / python_environment.runtime_tag()
    wheel.write_bytes(b"test runtime")
    monkeypatch.setattr(python_environment, "runtime_wheel", lambda _: wheel)
    before = projects.snapshot(tree["id"])["commit"]
    run = engine.launch(tree["id"], "dev")
    wait_until(marker.exists, timeout=10)
    child = int(marker.read_text())
    assert store.get("run", run["id"])["status"] == "preparing"
    wait_until(lambda: "Preparing packages" in store.get("run", run["id"])["preparation"][-1]["log"])
    assert engine.statuses(tree["id"], "dev")["active"]["id"] == run["id"]
    with pytest.raises(Problem) as busy:
        engine.launch(tree["id"], "dev")
    assert busy.value.status == 409 and busy.value.detail["run"] == run["id"]
    if close:
        with ThreadPoolExecutor(1) as pool:
            pool.submit(engine.close).result(5)
        assert not engine.pool.all()
    else:
        assert engine.cancel(run["id"])["status"] == "canceling"
    finished = wait_run(store, run, timeout=5)
    assert finished["status"] == "canceled"
    assert finished["preparation"][-1]["state"] == "canceled"
    assert "Preparing packages" in finished["preparation"][-1]["log"]
    assert not [p for p in (store.home / "python").iterdir() if p.is_dir() and len(p.name) == 64]
    assert not engine.active
    with pytest.raises(ProcessLookupError):
        os.kill(child, 0)
    assert projects.snapshot(tree["id"])["commit"] == before
    assert not any(t.is_alive() for t in engine.runs.threads)
    # Stopping the run neither prepared nor broke the environment: no error is left in settings.
    assert python_environment.environment_status(store.home, tree["id"])["state"] in (
        "unprepared",
        "locked",
    )


def test_retirement_holds_context_lock_while_lineage_adds_datasets(services, tmp_path, monkeypatch):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "rows.csv")
    bundle["flow"]["nodes"].extend(
        [
            {"id": "other_source", "template": "source", "params": {"file": str(tmp_path / "rows.csv")}},
            {"id": "other_total", "template": "total", "params": {}},
        ]
    )
    bundle["flow"]["edges"].append(
        {
            "id": "other_edge",
            "source": "other_source",
            "sourceHandle": "result",
            "target": "other_total",
            "targetHandle": "source",
        }
    )
    worktree = projects.create("Concurrent retirement", bundle)["id"]
    assert wait_run(store, engine.launch(worktree, "dev"))["status"] == "success"
    context = engine.context(worktree, "dev")
    output = context.outputs["other_total"]["result"]
    inspecting = threading.local()
    entered, release = threading.Event(), threading.Event()
    retire = engine.runs.nodes.publication.retire

    class CheckedDatasets(dict):
        def items(self):
            # Retirement must take its whole dependency snapshot under the same lock
            # used by TraceQuery when it adds intermediate lineage datasets.
            if getattr(inspecting, "retiring", False):
                assert context.lock._is_owned()
                entered.set()
            return super().items()

        def values(self):
            if getattr(inspecting, "retiring", False):
                assert context.lock._is_owned()
            return super().values()

    context.datasets = CheckedDatasets(context.datasets)

    def observed(*args):
        inspecting.retiring = True
        try:
            return retire(*args)
        finally:
            inspecting.retiring = False
            release.set()

    monkeypatch.setattr(engine.runs.nodes.publication, "retire", observed)
    # An unrelated branch's lineage is allowed to read while source outputs retire.
    lineage = Lineage(engine)
    tracing = threading.Event()
    trace = TraceQuery.trace

    def held_trace(self, *args, **kwargs):
        tracing.set()
        assert release.wait(10)
        return trace(self, *args, **kwargs)

    monkeypatch.setattr(TraceQuery, "trace", held_trace)
    with ThreadPoolExecutor(max_workers=1) as readers:
        request = readers.submit(lineage.explain, worktree, "dev", output.id, 0, "total")
        assert tracing.wait(5)
        run = engine.launch(worktree, "dev", "source")
        assert wait_run(store, run)["status"] == "success"
        assert entered.is_set() and release.is_set()
        assert request.result(10)["complete"]
    current = context.outputs["source"]["result"]
    assert current.run == run["id"]
