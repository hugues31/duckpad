import threading
import time

import pytest
from conftest import example_bundle, wait_run

from duckpad.lineage import Lineage, TraceQuery
from duckpad.projects import bundle_to_files
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
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        state = store.get("run", run["id"])["nodes"]["filter"]
        if state.get("statements", [{}])[0].get("materialization_sql"):
            break
        time.sleep(0.01)
    time.sleep(0.03)
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
    with pytest.raises(Problem, match="unavailable or stale"):
        Lineage(engine).explain(worktree, "dev", old["id"], 0, "total")
    release.set()
    thread.join(5)
    assert isinstance(outcome[0], Problem) and outcome[0].status == 409
    assert wait_run(store, run)["status"] == "success"
    assert engine.preview(worktree, "dev", "total")["status"] == "stale"


def test_simultaneous_entry_points_admit_exactly_one_run(services, tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

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


def test_unrelated_lineage_in_same_context_is_not_canceled(services, tmp_path, monkeypatch):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "shared.csv")
    bundle["flow"]["nodes"] += [
        {"id": "other_source", "template": "source", "params": {"file": str(tmp_path / "shared.csv")}},
        {"id": "other_total", "template": "total", "params": {}},
    ]
    bundle["flow"]["edges"].append(
        {
            "id": "other_edge",
            "source": "other_source",
            "sourceHandle": "result",
            "target": "other_total",
            "targetHandle": "source",
        }
    )
    worktree = projects.create("Independent lineage", bundle)["id"]
    wait_run(store, engine.launch(worktree, "dev"))
    preview = engine.preview(worktree, "dev", "other_total")
    entered, release = threading.Event(), threading.Event()
    original = TraceQuery.trace

    def hold(self, *args, **kwargs):
        entered.set()
        release.wait(5)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(TraceQuery, "trace", hold)
    result = []
    thread = threading.Thread(
        target=lambda: result.append(Lineage(engine).explain(worktree, "dev", preview["id"], 0, "total"))
    )
    thread.start()
    assert entered.wait(2)
    run = engine.launch(worktree, "dev", "filter")
    assert wait_run(store, run)["status"] == "success"
    assert not any(
        request["canceled"].is_set() for request in engine.context(worktree, "dev").lineage.values()
    )
    release.set()
    thread.join(5)
    assert result[0]["complete"] and result[0]["total"] == 2
