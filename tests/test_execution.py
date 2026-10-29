import copy
import threading
from pathlib import Path

import pytest
from helpers import example_bundle, pipeline, wait_run, wait_until

from duckpad.bundle import bundle_to_files
from duckpad.util import Problem


def test_rerun_refreshes_sources_and_preserves_external_snapshot(services, tmp_path):
    store, projects, _, engine = services
    source = tmp_path / "input.csv"
    wt = projects.create("Test", example_bundle(source))["id"]
    first = wait_run(store, engine.launch(wt, "dev", "total"))
    assert first["status"] == "success", first
    preview = engine.preview(wt, "dev", "total")
    assert preview["rows"][0]["values"] == ["North", 30, 2]
    source.write_text("id,region,amount\n1,North,40\n")
    assert engine.preview(wt, "dev", "total")["rows"] == preview["rows"]
    second = wait_run(store, engine.launch(wt, "dev", "total"))
    assert second["status"] == "success", second
    assert engine.preview(wt, "dev", "total")["rows"][0]["values"] == ["North", 40, 1]
    assert first["id"] != second["id"]


def test_failed_output_set_retains_all_previous_outputs(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["total"] = (
        "-- @input source\n-- @output result\nSELECT * FROM {{ source }};\n-- @output summary\nSELECT SUM(amount) AS total FROM {{ result }};"
    )
    wt = projects.create("Test", bundle)["id"]
    assert wait_run(store, engine.launch(wt, "dev"))["status"] == "success"
    previous = engine.preview(wt, "dev", "total", "summary")
    snapshot = projects.snapshot(wt)
    snapshot["bundle"]["templates"]["total"] = snapshot["bundle"]["templates"]["total"].replace(
        "SUM(amount)", "SUM(missing)"
    )
    projects.write(wt, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    run = wait_run(store, engine.launch(wt, "dev"))
    assert run["nodes"]["total"]["status"] == "failed"
    retained = engine.preview(wt, "dev", "total", "summary")
    assert retained["id"] == previous["id"]
    assert retained["status"] == "stale"
    assert retained["error"]
    assert engine.preview(wt, "dev", "total")["status"] == "stale"


def test_layout_change_preserves_valid_results(services, tmp_path):
    store, projects, _, engine = services
    wt = projects.create("Test", example_bundle(tmp_path / "input.csv"))["id"]
    wait_run(store, engine.launch(wt, "dev"))
    snapshot = projects.snapshot(wt)
    snapshot["bundle"]["flow"]["nodes"][0]["position"] = {"x": 20, "y": 40}
    snapshot["bundle"]["templates"]["total"] = (
        "-- @description Revenue by region\n" + snapshot["bundle"]["templates"]["total"]
    )
    projects.write(wt, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert engine.preview(wt, "dev", "total")["status"] == "valid"


def test_conflicts_survive_and_disjoint_fields_merge(services, tmp_path):
    store, projects, _, _ = services
    worktree = projects.create("Test", example_bundle(tmp_path / "input.csv"))
    snapshot = projects.snapshot(worktree["id"])
    external = copy.deepcopy(snapshot["bundle"])
    external["flow"]["nodes"][1]["params"]["threshold"] = 10

    (Path(worktree["path"]) / "flow.json").write_text(bundle_to_files(external)["flow.json"])
    snapshot["bundle"]["flow"]["nodes"][1]["params"]["threshold"] = 20
    with pytest.raises(Problem, match="Concurrent edits"):
        projects.write(worktree["id"], snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    conflict = store.all("conflict")[0]
    assert "threshold" in str(conflict["paths"])
    result = projects.resolve(conflict["id"], "proposal")
    assert result["bundle"]["flow"]["nodes"][1]["params"]["threshold"] == 20
    assert not result["conflicts"]


def test_undeclared_reads_rejected_and_independent_branch_continues(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["flow"]["nodes"].append({"id": "bad", "template": "bad", "params": {}})
    bundle["templates"]["bad"] = "-- @output result\nSELECT * FROM read_csv('/etc/passwd');"
    wt = projects.create("Test", bundle)["id"]
    run = wait_run(store, engine.launch(wt, "dev"))
    assert run["status"] == "partial_failure"
    assert run["nodes"]["bad"]["status"] == "failed"
    assert run["nodes"]["total"]["status"] == "success"


def test_atomic_admission_and_cancellation(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["total"] = (
        "-- @input source\n-- @output result\nSELECT sum(a.amount * b.amount * c.amount) AS total FROM {{ source }} a CROSS JOIN {{ source }} b CROSS JOIN {{ source }} c;"
    )
    wt = projects.create("Test", bundle)["id"]
    # Hold preparation deterministically to verify rejection cannot invalidate or queue.
    original = engine.catalog.prepare
    entered, release = threading.Event(), threading.Event()

    def hold(db, values):
        entered.set()
        release.wait(3)
        original(db, values)

    engine.catalog.prepare = hold
    run = engine.launch(wt, "dev")
    assert entered.wait(2)
    with pytest.raises(Problem, match="active execution"):
        engine.launch(wt, "prod")
    assert engine.cancel(run["id"])["status"] in ("canceling", "canceled")
    release.set()
    assert wait_run(store, run)["status"] == "canceled"
    wait_until(lambda: not engine.active, message="The worktree stayed reserved")


def test_preview_returns_timestamps_with_time_zones(services, tmp_path):
    _, preview, _ = pipeline(
        services,
        tmp_path,
        "SELECT id, TIMESTAMPTZ '2024-01-02 12:00:00+00' AS seen FROM {{ source }} WHERE id = 1;",
    )
    assert preview["rows"][0]["values"][1].startswith("2024-01-02")


def test_startup_loads_only_unfinished_runs(services, monkeypatch):
    from duckpad.engine import UNFINISHED_RUN_STATUSES, Engine

    store, projects, catalog, _ = services
    tree = projects.create("Recovery")
    completed = ("success", "failed", "partial_failure", "canceled", "interrupted")
    for status in (*UNFINISHED_RUN_STATUSES, *completed):
        store.put(
            "run",
            status,
            {
                "project": tree["project"],
                "worktree": tree["id"],
                "environment": "dev",
                "status": status,
                "started": "2026-01-01",
                "commit": "commit",
                "nodes": {
                    "export": {"kind": "export", "status": "running"},
                    "later": {"kind": "export", "status": "pending"},
                },
            },
        )
    original = store._record
    loaded = []

    def record(kind, row, session):
        if kind == "run":
            loaded.append(row.id)
        return original(kind, row, session)

    with monkeypatch.context() as patch:
        patch.setattr(store, "_record", record)
        recovered = Engine(store, projects, catalog)
        recovered.close()
    assert set(loaded) == set(UNFINISHED_RUN_STATUSES)
    for status in UNFINISHED_RUN_STATUSES:
        run = store.get("run", status)
        assert run["status"] == "interrupted"
        assert run["nodes"]["export"]["external_outcome"] == "unknown"
        # A node that never started is final too, without an unconfirmed external write.
        assert run["nodes"]["later"]["status"] == "interrupted"
        assert "external_outcome" not in run["nodes"]["later"]
    for status in completed:
        assert store.get("run", status)["status"] == status


def test_final_persistence_failure_releases_worktree_for_runs_and_cleanup(services, monkeypatch):
    from duckpad.engine import Execution

    store, projects, _, engine = services
    tree = projects.create("Persistence failure")
    context = engine.context(tree["id"], "dev", create=True)
    token = {"id": "failed-write", "cancel": threading.Event(), "cursor": None}
    engine.active[tree["id"]] = token
    run = {
        "id": token["id"],
        "project": tree["project"],
        "worktree": tree["id"],
        "environment": "dev",
        "status": "preparing",
        "started": "2026-01-01",
        "nodes": {},
    }
    execution = Execution(token, context, run, {}, [], [], {}, [], {})
    original = engine._persist

    def fail_final_write(run, secrets):
        if run.get("finished"):
            raise OSError("Simulated final persistence failure")
        original(run, secrets)

    with monkeypatch.context() as patch:
        patch.setattr(engine, "_persist", fail_final_write)
        with pytest.raises(OSError, match="Simulated final persistence failure"):
            engine._execute(execution)
    assert token["cursor"] is None
    assert tree["id"] not in engine.active
    assert wait_run(store, engine.launch(tree["id"], "dev"))["status"] == "success"
    engine.close()
    engine.reset_project(tree["project"])
    projects.delete(tree["project"])
    assert store.get("project", tree["project"]) is None
