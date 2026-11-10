import threading

import pytest
from helpers import example_bundle, pipeline, wait_run

from duckpad.bundle import bundle_to_files


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


def test_next_run_drops_the_results_of_removed_nodes(services, tmp_path):
    store, projects, _, engine = services
    wt = projects.create("Test", example_bundle(tmp_path / "input.csv"))["id"]
    assert wait_run(store, engine.launch(wt, "dev"))["status"] == "success"
    context = engine.context(wt, "dev")
    removed = context.outputs["total"]["result"]

    def relations():
        query = "SELECT table_name FROM duckdb_tables() UNION ALL SELECT view_name FROM duckdb_views()"
        return {row[0] for row in context.db.execute(query).fetchall()}

    assert {removed.table, removed.storage} <= relations()
    snapshot = projects.snapshot(wt)
    flow = snapshot["bundle"]["flow"]
    flow["nodes"] = [node for node in flow["nodes"] if node["id"] != "total"]
    flow["edges"] = [edge for edge in flow["edges"] if edge["target"] != "total"]
    projects.write(wt, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    # Any run of the worktree releases them, whatever its scope.
    assert wait_run(store, engine.launch(wt, "dev", "source"))["status"] == "success"
    assert not {removed.table, removed.storage} & relations()
    assert all(dataset.node != "total" for dataset in context.datasets.values())
    assert "total" not in engine.statuses(wt, "dev")["nodes"]
    assert engine.preview(wt, "dev", "filter")["count"] == 3


def test_compiled_sql_is_the_query_that_runs(services, tmp_path):
    store, projects, _, engine = services
    wt = projects.create("Test", example_bundle(tmp_path / "input.csv"))["id"]
    compiled = engine.compile(wt, "dev", "total")[0]
    assert "query" not in compiled and compiled["sql"].startswith("SELECT")
    statement = wait_run(store, engine.launch(wt, "dev"))["nodes"]["total"]["statements"][0]
    # The editor uses a symbolic input; execution resolves the retained result table.
    source = engine.context(wt, "dev").outputs["filter"]["result"]
    assert "query" not in statement
    assert statement["sql"] == compiled["sql"].replace('"input_filter_result"', f'"{source.table}"')


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


@pytest.mark.parametrize(
    "directive", ["-- @label Revenue", "--@label Revenue", "  --  @label Revenue", "--@description Revenue"]
)
def test_descriptive_directives_never_change_fingerprints(services, tmp_path, directive):
    engine = services[3]
    bundle = example_bundle(tmp_path / "input.csv")
    before = engine.fingerprints.of(bundle, "dev")
    bundle["templates"]["total"] = directive + "\n" + bundle["templates"]["total"]
    assert engine.fingerprints.of(bundle, "dev") == before
    bundle["templates"]["total"] += "\n-- SQL change"
    assert engine.fingerprints.of(bundle, "dev")["total"] != before["total"]


def test_preview_returns_timestamps_with_time_zones(services, tmp_path):
    _, preview, _ = pipeline(
        services,
        tmp_path,
        "SELECT id, TIMESTAMPTZ '2024-01-02 12:00:00+00' AS seen FROM {{ source }} WHERE id = 1;",
    )
    assert preview["rows"][0]["values"][1].startswith("2024-01-02")


def test_startup_loads_only_unfinished_runs(services, monkeypatch):
    from duckpad.engine import Engine
    from duckpad.execution.journal import UNFINISHED_RUN_STATUSES

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
                    "export": {"writes_external": True, "status": "running"},
                    "later": {"writes_external": True, "status": "pending"},
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
        recovered = Engine(store, projects, catalog, isolated=False, enforce_access=False)
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
    from duckpad.execution.launches import Execution

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
    original = engine.runs.journal.persist

    def fail_final_write(run, secrets):
        if run.get("finished"):
            raise OSError("Simulated final persistence failure")
        original(run, secrets)

    with monkeypatch.context() as patch:
        patch.setattr(engine.runs.journal, "persist", fail_final_write)
        patch.setattr(engine.runs.planner, "start", lambda *args: execution)
        with pytest.raises(OSError, match="Simulated final persistence failure"):
            engine.runs._execute(token, run, None, None, None, False)
    assert token["cursor"] is None
    assert tree["id"] not in engine.active
    assert wait_run(store, engine.launch(tree["id"], "dev"))["status"] == "success"
    engine.close()
    engine.reset_project(tree["project"])
    projects.delete(tree["project"])
    assert store.get("project", tree["project"]) is None
