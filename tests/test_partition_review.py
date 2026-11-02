"""Regressions for no-consumer runs, retry evidence, collection lifetime and scale."""

from collections import Counter

import pytest
from helpers import join_run
from sqlmodel import select
from test_partitions import bundle

from duckpad import models, partitions
from duckpad.builtin_templates import BUILTINS
from duckpad.bundle import bundle_to_files
from duckpad.components import expand
from duckpad.partition_storage import PartitionStorage
from duckpad.util import Problem


@pytest.mark.parametrize("target", [None, "ordinary"])
def test_dimension_without_consumers_runs_ordinary_nodes(services, target):
    store, projects, _, engine = services
    project = bundle()
    project["flow"]["nodes"] = [project["flow"]["nodes"][0], {"id": "ordinary", "template": "collect"}]
    project["flow"]["edges"] = [
        {"id": "x", "source": "keys", "sourceHandle": "result", "target": "ordinary", "targetHandle": "data"}
    ]
    worktree = projects.create("Unused dimension", project)["id"]
    run = join_run(store, engine.launch(worktree, "dev", target)["id"])
    assert run["status"] == "success", run
    assert not run["nodes"]["ordinary"].get("skipped")
    assert len(engine.preview(worktree, "dev", "ordinary")["rows"]) == 2


def test_retry_does_not_skip_an_export_whose_latest_attempt_failed(services, monkeypatch):
    store, projects, _, engine = services
    project = bundle()
    project["flow"]["partitions"]["batch"]["execution"] = {"on_error": "continue"}
    project["templates"]["export_csv"] = BUILTINS["export_csv"]
    project["flow"]["nodes"].append(
        {"id": "export", "template": "export_csv", "params": {"destination": "{{ partition }}.csv"}}
    )
    project["flow"]["edges"].append(
        {
            "id": "export",
            "source": "source",
            "sourceHandle": "result",
            "target": "export",
            "targetHandle": "source",
        }
    )
    worktree = projects.create("Latest export evidence", project)["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    compute, calls = engine.runs._compute, Counter()

    def fail(execution, key, tables):
        if key == "export" and execution.partition["key"]["value"] == "b":
            (store.paths.exports(worktree, "dev") / "b.csv").unlink()
            raise Problem("Export destination failed after replacement")
        return compute(execution, key, tables)

    monkeypatch.setattr(engine.runs, "_compute", fail)
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "partial_failure"

    def count(execution, key, tables):
        calls[key, (execution.partition or {}).get("key", {}).get("value")] += 1
        return compute(execution, key, tables)

    monkeypatch.setattr(engine.runs, "_compute", count)
    run = join_run(store, engine.launch(worktree, "dev", partition_selection={"mode": "failed"})["id"])
    assert run["status"] == "success", run
    assert calls["export", "b"] == 1
    assert calls["export", "a"] == 0
    assert (store.paths.exports(worktree, "dev") / "b.csv").is_file()


def test_explain_replay_keeps_all_required_collector_inputs(services):
    store, projects, _, engine = services
    worktree = projects.create("Replay preserves collection", bundle())["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    replay = join_run(
        store,
        engine.launch(
            worktree,
            "dev",
            "transform",
            partition_selection={"mode": "selected", "keys": [{"type": "text", "value": "a"}]},
        )["id"],
    )
    assert replay["status"] == "success", replay
    run = join_run(store, engine.launch(worktree, "dev", partition_selection={"mode": "missing"})["id"])
    assert run["status"] == "success", run
    assert run["partitions"]["selected"] == 0
    assert len(engine.preview(worktree, "dev", "collect")["rows"]) == 3


def test_collector_feedback_blocks_only_its_partition_zone(services):
    store, projects, _, engine = services
    project = bundle()
    project["flow"]["nodes"].append({"id": "feedback", "template": "transform", "params": {"value": "'ok'"}})
    project["flow"]["edges"].extend(
        [
            {
                "id": "d",
                "source": "source",
                "sourceHandle": "result",
                "target": "feedback",
                "targetHandle": "data",
            },
            {
                "id": "e",
                "source": "collect",
                "sourceHandle": "result",
                "target": "feedback",
                "targetHandle": "lookup",
            },
        ]
    )
    nodes, edges, boundaries = expand(project)
    plan = partitions.plan(project, nodes, edges, boundaries)
    assert any(e["code"] == "partition_dependency_cycle" for e in plan["errors"])
    worktree = projects.create("Collector feedback", project)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["nodes"]["lookup"]["status"] == "success", run
    assert run["nodes"]["source"]["status"] == "blocked"
    assert "own collector" in run["nodes"]["source"]["error"]


def test_graph_expansions_grow_linearly_for_run_and_validity_reads(services, monkeypatch):
    from duckpad.execution import fingerprints

    store, projects, _, engine = services
    counts = []
    original = fingerprints.expand_for
    for size in (10, 30):
        project = bundle()
        project["templates"]["keys"] = (
            f"-- @kind source\n-- @output result\nSELECT i::VARCHAR batch, 'task' task FROM range({size}) t(i);"
        )
        worktree = projects.create("Linear fingerprints", project)["id"]
        calls = []

        def count(*args, calls=calls, **kwargs):
            calls.append(1)
            return original(*args, **kwargs)

        monkeypatch.setattr(fingerprints, "expand_for", count)
        # This counts expansions; 30 keys can exceed the default wait on a loaded runner.
        run = join_run(store, engine.launch(worktree, "dev")["id"], timeout=120)
        assert run["status"] == "success", run
        engine.partitions.page(worktree, "dev", limit=200)
        engine.invalidate(worktree)
        counts.append(len(calls))
    assert counts[1] < counts[0] * 3.2, counts


def test_partition_records_and_files_follow_project_and_node_lifetime(services):
    store, projects, _, engine = services
    worktree = projects.create("Owned artifacts", bundle())["id"]
    join_run(store, engine.launch(worktree, "dev")["id"])
    storage = PartitionStorage(store, worktree, "dev")
    assert storage.data.is_dir()
    assert not (store.home / "partitions").exists()
    project = projects.snapshot(worktree)["bundle"]
    project["flow"]["nodes"] = [
        n for n in project["flow"]["nodes"] if n["id"] not in ("transform", "collect")
    ]
    project["flow"]["edges"] = []
    projects.write(worktree, projects.snapshot(worktree)["revision"], bundle_to_files(project))
    join_run(store, engine.launch(worktree, "dev")["id"])
    assert all(meta["dataset"]["node"] != "transform" for _, _, meta in storage.outputs())
    project_id = projects.get(worktree)["project"]
    engine.discard_worktree(worktree)
    projects.delete(project_id)
    assert not storage.data.exists()
    with store.session() as session:
        for model in (
            models.PartitionManifest,
            models.PartitionEntry,
            models.PartitionAttempt,
            models.PartitionResult,
            models.PartitionOutput,
        ):
            assert not session.exec(select(model)).all()


def test_isolated_worker_can_read_but_cannot_overwrite_partition_artifacts(tmp_path):
    import duckdb

    from duckpad.services import Services
    from duckpad.util import literal

    instance = Services.open(tmp_path / "instance", enforce_access=True)
    try:
        ordinary = bundle()
        ordinary["flow"] = {"nodes": [ordinary["flow"]["nodes"][0]], "edges": []}
        worktree = instance.projects.create("Private collector inputs", ordinary)
        instance.engine.access.grant_connections(worktree["project"], [])
        assert (
            join_run(instance.store, instance.engine.launch(worktree["id"], "dev")["id"])["status"]
            == "success"
        )
        assert not instance.store.paths.partition_artifacts(worktree["id"]).exists()
        snapshot = instance.projects.snapshot(worktree["id"])
        instance.projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle()))
        run = join_run(instance.store, instance.engine.launch(worktree["id"], "dev")["id"])
        assert run["status"] == "success", run
        storage = PartitionStorage(instance.store, worktree["id"], "dev")
        metadata = storage.outputs()[0][2]
        path = storage.data / metadata["id"]
        context = instance.engine.context(worktree["id"], "dev")
        cursor = context.db.cursor()
        try:
            assert cursor.execute(f"SELECT count(*) FROM read_parquet({literal(str(path))})").fetchone()
            with pytest.raises(duckdb.Error):
                cursor.execute(f"COPY (SELECT 99 x) TO {literal(str(path))} (FORMAT PARQUET)")
        finally:
            cursor.close()
        assert storage.available(metadata)
    finally:
        instance.close()


def test_parallel_artifact_writes_do_not_hold_a_shared_copy_lock(services, monkeypatch):
    import threading

    store, projects, _, engine = services
    store.put("settings", "sql_resources", {"threads": 2})
    worktree = projects.create("Concurrent artifact writers", bundle())["id"]
    barrier = threading.Barrier(2)
    save = PartitionStorage.save

    def concurrent(self, cursor, dataset, *args, **kwargs):
        if dataset.node == "transform":
            barrier.wait(timeout=10)
        return save(self, cursor, dataset, *args, **kwargs)

    monkeypatch.setattr(PartitionStorage, "save", concurrent)
    run = join_run(store, engine.launch(worktree, "dev", partition_execution={"parallelism": 2})["id"])
    assert run["status"] == "success", run


def test_run_deletion_cascades_manifest_entries_and_attempts(services):
    store, projects, _, engine = services
    worktree = projects.create("Partition history ownership", bundle())["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    storage = PartitionStorage(store, worktree, "dev")
    assert storage.entries(run["partitions"]["manifest"])
    store.delete("run", run["id"])
    assert storage.manifest(identity=run["partitions"]["manifest"]) is None
    assert storage.entries(run["partitions"]["manifest"]) == []
    with store.session() as session:
        assert not session.exec(select(models.PartitionAttempt)).all()


def test_missing_recomputes_stale_keys_without_counting_optional_eviction(services):
    store, projects, _, engine = services
    worktree = projects.create("Missing stale outputs", bundle())["id"]
    join_run(store, engine.launch(worktree, "dev")["id"])
    snapshot = projects.snapshot(worktree)
    project = snapshot["bundle"]
    project["templates"]["source"] = project["templates"]["source"].replace("('b', 2)", "('b', 3)")
    projects.write(worktree, snapshot["revision"], bundle_to_files(project))
    run = join_run(store, engine.launch(worktree, "dev", partition_selection={"mode": "missing"})["id"])
    assert run["status"] == "success", run
    assert run["partitions"]["selected"] == 2
    assert engine.preview(worktree, "dev", "collect")["rows"][-1]["values"][0] == 30


def test_older_parallel_key_does_not_copy_an_unneeded_preview(services, monkeypatch):
    import threading

    store, projects, _, engine = services
    store.put("settings", "sql_resources", {"threads": 2})
    worktree = projects.create("Skip superseded preview writes", bundle())["id"]
    retained = threading.Event()
    compute, save = engine.runs._compute, PartitionStorage.save
    copied = []

    def wait_for_newer(execution, key, tables):
        if key == "source" and execution.partition["key"]["value"] == "a":
            assert retained.wait(10)
        return compute(execution, key, tables)

    def saved(self, cursor, dataset, entry, *args, **kwargs):
        result = save(self, cursor, dataset, entry, *args, **kwargs)
        if dataset.node == "source":
            copied.append(entry["key"]["value"])
            if entry["key"]["value"] == "b":
                retained.set()
        return result

    monkeypatch.setattr(engine.runs, "_compute", wait_for_newer)
    monkeypatch.setattr(PartitionStorage, "save", saved)
    run = join_run(store, engine.launch(worktree, "dev", partition_execution={"parallelism": 2})["id"])
    assert run["status"] == "success", run
    assert copied == ["b"]


def export_project():
    project = bundle()
    project["templates"]["export_csv"] = BUILTINS["export_csv"]
    project["flow"]["nodes"].append(
        {"id": "export", "template": "export_csv", "params": {"destination": "{{ partition }}.csv"}}
    )
    project["flow"]["edges"].append(
        {
            "id": "export",
            "source": "transform",
            "sourceHandle": "result",
            "target": "export",
            "targetHandle": "source",
        }
    )
    return project


def downloads(store):
    with store.session() as session:
        rows = session.exec(select(models.Artifact).where(models.Artifact.media_type == "text/csv")).all()
    return {row.id for row in rows}, {f.name for f in store.paths.artifacts.iterdir() if f.is_file()}


def test_each_key_keeps_one_export_download_copy(services):
    store, projects, _, engine = services
    worktree = projects.create("One download per key", export_project())["id"]
    for _ in range(3):
        run = join_run(store, engine.launch(worktree, "dev")["id"])
        assert run["status"] == "success", run
    rows, files = downloads(store)
    storage = PartitionStorage(store, worktree, "dev")
    current = {
        storage.result("export", e["key_hash"])["success"]["artifact"]
        for e in storage.entries(run["partitions"]["manifest"])
    }
    assert rows == files == current
    assert len(current) == 2


def test_removing_partition_declarations_releases_their_data(services):
    store, projects, _, engine = services
    worktree = projects.create("Unpartitioned again", export_project())["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    storage = PartitionStorage(store, worktree, "dev")
    assert storage.outputs()
    project = projects.snapshot(worktree)["bundle"]
    del project["flow"]["partitions"]
    project["flow"]["nodes"] = [
        {k: v for k, v in n.items() if k not in ("outputs", "partitions")}
        for n in project["flow"]["nodes"]
        if n["id"] != "export"
    ]
    project["flow"]["nodes"][3]["params"] = {"value": "'shared'"}
    project["flow"]["edges"] = [e for e in project["flow"]["edges"] if e["id"] != "export"]
    projects.write(worktree, projects.snapshot(worktree)["revision"], bundle_to_files(project))
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    assert not storage.outputs()
    assert not any(storage.data.iterdir())
    with store.session() as session:
        assert not session.exec(select(models.PartitionResult)).all()
    assert downloads(store) == (set(), set())


def test_refused_partition_options_leave_results_valid(services):
    store, projects, _, engine = services
    project = bundle()
    del project["flow"]["partitions"]
    project["flow"]["nodes"] = [{"id": "lookup", "template": "lookup"}]
    project["flow"]["edges"] = []
    worktree = projects.create("Refused options", project)["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    with pytest.raises(Problem, match="partition options require a partitioned flow"):
        engine.launch(worktree, "dev", partition_selection={"mode": "all"})
    assert engine.preview(worktree, "dev", "lookup")["status"] == "valid"


def test_empty_selection_reports_its_reason(services):
    store, projects, _, engine = services
    worktree = projects.create("Nothing failed", bundle())["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    run = join_run(store, engine.launch(worktree, "dev", partition_selection={"mode": "failed"})["id"])
    assert run["status"] == "success", run
    assert run["partitions"]["selected"] == 0
    assert run["partitions"]["reason"] == "No partitions match the selection"


def test_blocked_collector_status_keeps_its_reason(services, monkeypatch):
    store, projects, _, engine = services
    project = bundle()
    project["flow"]["partitions"]["batch"]["execution"] = {"on_error": "continue"}
    worktree = projects.create("Blocked collector reason", project)["id"]
    compute = engine.runs._compute

    def fail(execution, key, tables):
        if key == "transform" and execution.partition["key"]["value"] == "b":
            raise Problem("Conversion failed")
        return compute(execution, key, tables)

    monkeypatch.setattr(engine.runs, "_compute", fail)
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "partial_failure"
    status = engine.statuses(worktree, "dev")["nodes"]["collect"]
    assert status["execution_status"] == "blocked"
    assert status["error"] == "partition_incomplete: transform.result lacks valid results for b"
