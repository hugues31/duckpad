"""Native equivalence and partition lifetime through the real Runner."""

import json
import os
import subprocess
import sys
from collections import Counter

import duckdb
import pytest
from helpers import join_run
from test_partitions import bundle

from duckpad.bundle import bundle_to_files
from duckpad.partition_storage import PartitionStorage
from duckpad.util import Problem


def test_serial_execution_preserves_duplicates_and_manifest_order(services, monkeypatch):
    store, projects, _, engine = services
    project = bundle()
    project["templates"]["keys"] = (
        "-- @kind source\n-- @output result\nSELECT 'b' batch, 'two' task UNION ALL SELECT 'a', 'one';"
    )
    worktree = projects.create("Partition equivalence", project)["id"]
    calls = Counter()
    compute = engine.runs._compute

    def counted(execution, key, tables):
        calls[key] += 1
        return compute(execution, key, tables)

    monkeypatch.setattr(engine.runs, "_compute", counted)
    launched = engine.launch(worktree, "dev")
    run = join_run(store, launched["id"])
    assert run["status"] == "success", run
    assert calls == {"keys": 1, "lookup": 1, "source": 2, "transform": 2, "collect": 1}
    preview = engine.preview(worktree, "dev", "collect")
    actual = [r["values"] for r in preview["rows"]]
    with duckdb.connect() as db:
        expected = []
        for key, task in [("b", "two"), ("a", "one")]:
            expected.extend(
                [
                    list(r)
                    for r in db.execute(
                        "SELECT amount * 10, $task FROM (VALUES ('a', 1), ('a', 1), ('b', 2)) t(batch, amount) WHERE batch = $key",
                        {"key": key, "task": task},
                    ).fetchall()
                ]
            )
    assert actual == expected
    assert run["partitions"]["completed"] == 2
    storage = PartitionStorage(store, worktree, "dev")
    entries = storage.entries(run["partitions"]["manifest"])
    assert all(storage.result("transform", e["key_hash"])["success"]["artifacts"] for e in entries)
    assert not any(
        not d.disk and d.node in ("source", "transform")
        for d in engine.context(worktree, "dev").datasets.values()
    )


def test_empty_manifest_binds_source_schema_without_evaluating_rows(services):
    store, projects, _, engine = services
    project = bundle()
    project["templates"]["keys"] = (
        "-- @kind source\n-- @output result\nSELECT 'a' batch, 'one' task WHERE FALSE;"
    )
    project["templates"]["source"] = (
        "-- @kind source\n-- @output result\nSELECT 'a' batch, error('must not scan')::INTEGER amount;"
    )
    project["templates"]["collect"] = (
        "-- @input data\n-- @output result\nSELECT count(*) AS total FROM {{ data }};"
    )
    worktree = projects.create("Empty partitions", project)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success", run
    assert engine.preview(worktree, "dev", "collect")["rows"][0]["values"] == [0]


@pytest.mark.parametrize(
    ("sql", "code"),
    [
        ("SELECT 'a' batch, 'one' task UNION ALL SELECT 'a', 'two'", "partition_duplicate"),
        ("SELECT NULL::VARCHAR batch, 'one' task", "partition_null"),
        ("SELECT 'a' batch, NULL::VARCHAR task", "partition_null"),
        ("SELECT 42 batch, 'one' task WHERE FALSE", "partition_type"),
    ],
)
def test_invalid_manifest_does_not_start_partition_sources(services, sql, code):
    store, projects, _, engine = services
    project = bundle()
    project["templates"]["keys"] = "-- @kind source\n-- @output result\n" + sql + ";"
    worktree = projects.create("Invalid manifest", project)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert code in run["partitions"]["error"]
    assert run["nodes"]["source"]["status"] == "blocked"
    assert run["nodes"]["lookup"]["status"] == "success"


def test_targeted_run_reuses_its_environment_manifest(services):
    store, projects, _, engine = services
    worktree = projects.create("Targeted partitions", bundle())["id"]
    with pytest.raises(Problem, match="partition_not_calculated"):
        engine.preview(worktree, "dev", "transform")
    # Without a retained list, the first targeted run calculates it.
    run = join_run(store, engine.launch(worktree, "dev", "transform")["id"])
    assert run["status"] == "success", run
    assert run["nodes"]["keys"]["status"] == "success"
    assert run["partitions"]["total"] == 2
    first = join_run(store, engine.launch(worktree, "dev")["id"])
    second = join_run(store, engine.launch(worktree, "dev", "collect")["id"])
    assert second["status"] == "success", second
    assert first["partitions"]["manifest"] == second["partitions"]["manifest"]
    assert "keys" not in second["nodes"]


def test_failure_continue_isolated_per_key_and_collection_requires_all(services):
    store, projects, _, engine = services
    project = bundle()
    project["flow"]["partitions"]["batch"]["execution"] = {"on_error": "continue"}
    project["flow"]["nodes"][3]["params"]["value"] = (
        "CASE WHEN {{ partition }} = 'a' THEN error('broken key') ELSE {{ partition.task }} END"
    )
    worktree = projects.create("Partition failures", project)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "partial_failure", run
    assert run["partitions"]["completed"] == 1
    assert run["partitions"]["failed"] == 1
    assert run["nodes"]["collect"]["status"] == "blocked"


def test_schema_drift_rejects_collection_and_keeps_previous_generation(services):
    store, projects, _, engine = services
    worktree = projects.create("Retained partition generation", bundle())["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    storage = PartitionStorage(store, worktree, "dev")
    entry = storage.entries(run["partitions"]["manifest"])[0]
    artifact = storage.result("transform", entry["key_hash"])["success"]["artifacts"]["result"]
    path = storage.data / (artifact["id"])
    path.write_bytes(b"corrupt")
    assert not storage.available(artifact)
    snapshot = projects.snapshot(worktree)
    project = snapshot["bundle"]
    project["templates"]["keys"] = (
        "-- @kind source\n-- @output result\nSELECT 'a' batch, 'one' task WHERE FALSE;"
    )
    projects.write(worktree, snapshot["revision"], bundle_to_files(project))
    refreshed = join_run(store, engine.launch(worktree, "dev")["id"])
    assert refreshed["status"] == "success", refreshed


def test_optional_preview_budget_never_evicts_collector_inputs(services):
    store, projects, _, engine = services
    project = bundle()
    project["flow"]["partitions"]["batch"]["preview"] = {"keep": "all", "max_bytes": 1}
    worktree = projects.create("Preview budget", project)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success", run
    storage = PartitionStorage(store, worktree, "dev")
    for entry in storage.entries(run["partitions"]["manifest"]):
        assert storage.result("source", entry["key_hash"])["success"]["artifacts"] == {}
        artifact = storage.result("transform", entry["key_hash"])["success"]["artifacts"]["result"]
        assert storage.available(artifact)


def test_empty_manifest_does_not_evaluate_shared_inputs_used_only_by_the_zone(services):
    store, projects, _, engine = services
    project = bundle()
    project["templates"]["keys"] = (
        "-- @kind source\n-- @output result\nSELECT 'a' batch, 'one' task WHERE FALSE;"
    )
    project["templates"]["lookup"] = (
        "-- @kind source\n-- @output result\nSELECT error('shared source must not run')::INTEGER rate;"
    )
    worktree = projects.create("Empty shared input", project)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success", run


def test_source_data_tests_prevent_partition_publication(services):
    store, projects, _, engine = services
    project = bundle()
    project["flow"]["partitions"]["batch"]["execution"] = {"on_error": "continue"}
    project["templates"]["transform"] += (
        "\n-- @test valid_amount: error\nSELECT * FROM {{ result }} WHERE amount = 10;"
    )
    worktree = projects.create("Partition checks", project)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["nodes"]["collect"]["status"] == "blocked", run
    assert run["partitions"]["failed"] == 1


def test_peak_working_set_is_bounded_for_one_ten_and_thirty_partitions(tmp_path):
    measurements = []
    for keys in (1, 10, 30):
        result = subprocess.run(
            [sys.executable, "scripts/benchmark_partitions.py", "--keys", str(keys)],
            env={**os.environ, "TMPDIR": str(tmp_path)},
            capture_output=True,
            text=True,
            check=True,
            timeout=180,
        )
        measurements.append(json.loads(result.stdout))
    baseline = measurements[0]["peak_bytes"]
    for measured in measurements[1:]:
        assert measured["peak_bytes"]["rss"] <= baseline["rss"] + 96 * 1024**2, measurements
        assert measured["peak_bytes"]["duckdb"] <= baseline["duckdb"] + 64 * 1024**2, measurements
        assert measured["peak_bytes"]["spill"] == 0, measurements
