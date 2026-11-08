"""One session budget, deterministic collection, typed selection and safe retries."""

import threading
from collections import Counter

import pytest
from helpers import join_run
from test_partitions import bundle

from duckpad.builtin_templates import BUILTINS
from duckpad.bundle import bundle_to_files
from duckpad.partition_storage import PartitionStorage
from duckpad.util import Problem


def test_parallel_keys_share_database_budget_and_collect_in_manifest_order(services, monkeypatch):
    store, projects, _, engine = services
    store.put("settings", "sql_resources", {"threads": 2, "memory_limit": "128MiB"})
    worktree = projects.create("Parallel keys", bundle())["id"]
    barrier = threading.Barrier(2)
    contexts, settings, calls = [], [], Counter()
    compute = engine.runs.nodes.compute

    def counted(execution, key, tables):
        calls[key] += 1
        if key == "source":
            contexts.append(execution.context.db)
            settings.append(
                execution.cursor.execute(
                    "SELECT current_setting('threads'), current_setting('memory_limit')"
                ).fetchone()
            )
            barrier.wait(timeout=10)
        return compute(execution, key, tables)

    monkeypatch.setattr(engine.runs.nodes, "compute", counted)
    run = join_run(store, engine.launch(worktree, "dev", partition_execution={"parallelism": 8})["id"])
    assert run["status"] == "success", run
    assert run["partitions"]["effective_parallelism"] == 2
    assert contexts[0] is contexts[1]
    assert settings == [(2, "128.0 MiB"), (2, "128.0 MiB")]
    assert calls == {"keys": 1, "lookup": 1, "source": 2, "transform": 2, "collect": 1}
    assert [r["values"] for r in engine.preview(worktree, "dev", "collect")["rows"]] == [
        [10, "one"],
        [10, "one"],
        [20, "two"],
    ]


def test_failed_retry_refreshes_manifest_and_skips_successful_exports(services, monkeypatch):
    store, projects, _, engine = services
    project = bundle()
    project["flow"]["partitions"]["batch"]["execution"] = {"on_error": "continue"}
    project["templates"]["export_csv"] = BUILTINS["export_csv"]
    project["flow"]["nodes"].insert(
        3, {"id": "export", "template": "export_csv", "params": {"destination": "{{ partition }}.csv"}}
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
    worktree = projects.create("Retry keys", project)["id"]
    calls = Counter()
    fail = True
    compute = engine.runs.nodes.compute

    def counted(execution, key, tables):
        value = (execution.partition or {}).get("key", {}).get("value")
        calls[key, value] += 1
        if fail and key == "transform" and value == "b":
            raise Problem("Temporary source failure")
        return compute(execution, key, tables)

    monkeypatch.setattr(engine.runs.nodes, "compute", counted)
    first = join_run(store, engine.launch(worktree, "dev")["id"])
    assert first["status"] == "partial_failure", first
    fail = False
    launched = engine.launch(worktree, "dev", partition_selection={"mode": "failed"})
    # The launch answers while the run prepares; it already describes the requested selection.
    assert launched["partition_selection"] == {"mode": "failed"}
    second = join_run(store, launched["id"])
    assert second["status"] == "success", second
    assert second["partitions"]["selected"] == 1
    assert first["partitions"]["manifest"] != second["partitions"]["manifest"]
    assert calls["keys", None] == 2
    assert calls["transform", "a"] == 1
    assert calls["transform", "b"] == 2
    assert calls["export", "a"] == calls["export", "b"] == 1
    storage = PartitionStorage(store, worktree, "dev")
    entry = storage.entries(second["partitions"]["manifest"])[1]
    assert storage.attempts(second["id"], entry["partition_id"])["export"]["skipped"]
    info = engine.partitions.export_result(
        worktree,
        "dev",
        "export",
        {"manifest": second["partitions"]["manifest"], "partition_id": entry["partition_id"]},
    )
    assert info["status"] == "available"
    assert info["run"] == first["id"]


@pytest.mark.parametrize(
    "selection",
    [
        {"mode": "surprise"},
        {"mode": "all", "keys": []},
        {"mode": "selected"},
        {"mode": "selected", "keys": [{"type": "text", "value": 3}]},
        {"mode": "selected", "keys": [{"type": "text", "value": "a"}] * 2},
    ],
)
def test_reject_invalid_selectors_without_a_run(services, selection):
    store, projects, _, engine = services
    worktree = projects.create("Invalid selection", bundle())["id"]
    with pytest.raises(Problem):
        engine.launch(worktree, "dev", partition_selection=selection)
    assert not store.all("run")


def test_missing_does_not_recompute_evicted_optional_previews(services):
    store, projects, _, engine = services
    worktree = projects.create("Missing selection", bundle())["id"]
    join_run(store, engine.launch(worktree, "dev")["id"])
    run = join_run(store, engine.launch(worktree, "dev", partition_selection={"mode": "missing"})["id"])
    assert run["status"] == "success"
    assert run["partitions"]["selected"] == 0
    selected = join_run(
        store,
        engine.launch(
            worktree,
            "dev",
            "transform",
            partition_selection={"mode": "selected", "keys": [{"type": "text", "value": "a"}]},
        )["id"],
    )
    assert selected["status"] == "success", selected
    page = engine.partitions.page(worktree, "dev", node="source")
    assert page["entries"][0]["nodes"]["source"]["preview_available"]
    assert not page["entries"][1]["nodes"]["source"]["preview_available"]


def test_stop_finishes_active_keys_and_marks_others_missing(services, monkeypatch):
    store, projects, _, engine = services
    store.put("settings", "sql_resources", {"threads": 2})
    project = bundle()
    project["templates"]["keys"] = project["templates"]["keys"].replace(
        "'b', 'two';", "'b', 'two' UNION ALL SELECT 'c', 'three';"
    )
    worktree = projects.create("Stop admission", project)["id"]
    barrier = threading.Barrier(2)
    calls = []
    compute = engine.runs.nodes.compute

    def fail(execution, key, tables):
        if key == "source":
            value = execution.partition["key"]["value"]
            calls.append(value)
            barrier.wait(timeout=10)
            if value == "a":
                raise Problem("Fail one active key")
        return compute(execution, key, tables)

    monkeypatch.setattr(engine.runs.nodes, "compute", fail)
    run = join_run(store, engine.launch(worktree, "dev", partition_execution={"parallelism": 2})["id"])
    assert set(calls) == {"a", "b"}
    assert run["partitions"]["completed"] == 1
    assert run["partitions"]["not_started"] == 1
    monkeypatch.setattr(engine.runs.nodes, "compute", compute)
    missing = join_run(store, engine.launch(worktree, "dev", partition_selection={"mode": "missing"})["id"])
    assert missing["status"] == "success", missing
    assert missing["partitions"]["selected"] == 2


def test_cancel_interrupts_every_admitted_cursor(services, monkeypatch):
    store, projects, _, engine = services
    store.put("settings", "sql_resources", {"threads": 2})
    worktree = projects.create("Cancel parallel", bundle())["id"]
    admitted, release = threading.Barrier(3), threading.Event()
    compute = engine.runs.nodes.compute

    def paused(execution, key, tables):
        if key == "source":
            admitted.wait(timeout=10)
            assert release.wait(10)
        return compute(execution, key, tables)

    monkeypatch.setattr(engine.runs.nodes, "compute", paused)
    run = engine.launch(worktree, "dev", partition_execution={"parallelism": 2})
    try:
        admitted.wait(timeout=10)
        engine.cancel(run["id"])
    finally:
        release.set()
    result = join_run(store, run["id"])
    assert result["status"] == "canceled"
    storage = PartitionStorage(store, worktree, "dev")
    for entry in storage.entries(result["partitions"]["manifest"]):
        assert storage.attempts(run["id"], entry["partition_id"])["source"]["status"] == "canceled"


def test_refreshing_only_values_invalidates_ordered_collectors(services):
    store, projects, _, engine = services
    worktree = projects.create("Ordered validity", bundle())["id"]
    join_run(store, engine.launch(worktree, "dev")["id"])
    assert engine.preview(worktree, "dev", "collect")["status"] == "valid"
    snapshot = projects.snapshot(worktree)
    snapshot["bundle"]["templates"]["keys"] = (
        "-- @output result\nSELECT 'b' batch, 'two' task UNION ALL SELECT 'a', 'one';"
    )
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    refreshed = join_run(store, engine.launch(worktree, "dev", "keys")["id"])
    assert refreshed["status"] == "success"
    assert engine.preview(worktree, "dev", "collect")["status"] == "stale"
    page = engine.partitions.page(worktree, "dev", node="transform")
    assert [e["key"]["value"] for e in page["entries"]] == ["b", "a"]
    assert all(e["validity"] == "valid" for e in page["entries"])


def test_restart_marks_running_keys_interrupted_and_preserves_success(services):
    store, projects, _, engine = services
    worktree = projects.create("Recovered keys", bundle())["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    storage = PartitionStorage(store, worktree, "dev")
    entry = storage.entries(run["partitions"]["manifest"])[0]
    successful = storage.result("transform", entry["key_hash"])["success"]
    interrupted = {"status": "running", "writes_external": True, "run": run["id"]}
    storage.attempt(run["id"], entry["partition_id"], "transform", interrupted)
    storage.record("transform", entry, interrupted)
    partial = storage.temporary / "partition_unfinished.partial"
    partial.write_bytes(b"incomplete")
    run["status"] = "running"
    store.put("run", run["id"], run)
    engine.runs.recover()
    recovered = storage.result("transform", entry["key_hash"])
    assert recovered["attempt"]["status"] == "interrupted"
    assert recovered["attempt"]["external_outcome"] == "unknown"
    assert recovered["success"] == successful
    assert store.get("run", run["id"])["status"] == "interrupted"
    assert not partial.exists()


def test_successive_zones_share_ordered_collector_fingerprints(services):
    store, projects, _, engine = services
    project = bundle()
    project["templates"]["collect"] = (
        "-- @input data\n-- @output result\nSELECT *, CASE task WHEN 'one' THEN 'a' ELSE 'b' END AS batch FROM {{ data }};"
    )
    project["templates"]["second"] = "-- @input data\n-- @output result\nSELECT * FROM {{ data }};"
    project["flow"]["nodes"].extend(
        [
            {
                "id": "second",
                "template": "second",
                "outputs": {"result": {"partition": {"by": "batch", "column": "batch"}}},
            },
            {"id": "final", "template": "second", "partitions": "all"},
        ]
    )
    project["flow"]["edges"].extend(
        [
            {
                "id": "d",
                "source": "collect",
                "sourceHandle": "result",
                "target": "second",
                "targetHandle": "data",
            },
            {
                "id": "e",
                "source": "second",
                "sourceHandle": "result",
                "target": "final",
                "targetHandle": "data",
            },
        ]
    )
    worktree = projects.create("Successive zones", project)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success", run
    assert engine.preview(worktree, "dev", "final")["count"] == 3
    before = engine.partitions.page(worktree, "dev", node="second")
    assert before["entries"][1]["validity"] == "valid"
    snapshot = projects.snapshot(worktree)
    snapshot["bundle"]["templates"]["keys"] = "-- @output result\nSELECT 'b' AS batch, 'two' AS task;"
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    refreshed = join_run(store, engine.launch(worktree, "dev", "keys")["id"])
    assert refreshed["status"] == "success", refreshed
    assert engine.partitions.page(worktree, "dev", node="second")["entries"][0]["validity"] == "stale"
    # A key before the collector still has its own unchanged computation.
    assert engine.partitions.page(worktree, "dev", node="source")["entries"][0]["validity"] == "valid"
