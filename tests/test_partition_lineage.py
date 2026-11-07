"""Lineage follows immutable occurrences without reopening an evicted source."""

import pytest
from helpers import join_run
from test_partitions import bundle

from duckpad.lineage import Lineage
from duckpad.util import Problem


def launched(services, project=None):
    store, projects, _, engine = services
    worktree = projects.create("Partition origins", project or bundle())["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success", run
    return worktree, run, engine, Lineage(engine)


def test_origin_survives_eviction_and_duplicate_occurrences(services, monkeypatch):
    worktree, run, engine, lineage = launched(services)
    preview = engine.preview(worktree, "dev", "collect")

    def never(*args, **kwargs):
        raise AssertionError("Lineage must not execute sources")

    monkeypatch.setattr(engine.runs, "_compute", never)
    for row in (0, 1):
        result = lineage.explain(worktree, "dev", preview["id"], row, "amount")
        assert result["origin"]["partition"]["key"]["value"] == "a", result
        assert result["origin"]["row"] == row
        assert result["origin"]["run"] == run["id"]
        assert not result["complete"]
        assert result["replay"]["node"] == "transform"
        assert result["replay"]["partitions"]["keys"] == [{"type": "text", "value": "a"}]
    result = lineage.explain(worktree, "dev", preview["id"], 2, "amount")
    assert result["complete"], result
    cell = result["contributions"][0]
    details = lineage.explain(
        worktree,
        "dev",
        cell["dataset"],
        cell["row"],
        cell["column"],
        partition_context=cell["partition_context"],
    )
    assert details["complete"], details
    assert sorted(c["value"] for c in details["contributions"]) == [2, 10]
    assert details["variables"]["partition"]["value"] == "b"
    attribute = lineage.explain(
        worktree, "dev", cell["dataset"], cell["row"], "task", partition_context=cell["partition_context"]
    )
    assert "partition.task" in attribute["expression"]
    assert "duckpad-variable" not in attribute["expression"]
    keys = engine.partitions.page(worktree, "dev")["entries"]
    with pytest.raises(Problem, match="does not match"):
        lineage.explain(
            worktree,
            "dev",
            cell["dataset"],
            cell["row"],
            cell["column"],
            partition_context={**cell["partition_context"], "partition_id": keys[0]["partition_id"]},
        )
    with pytest.raises(Problem, match="explicit partition"):
        lineage.explain(worktree, "dev", cell["dataset"], cell["row"], cell["column"])


def test_global_aggregate_reports_all_contributing_partitions(services):
    project = bundle()
    project["templates"]["collect"] = (
        "-- @input data\n-- @output result\nSELECT sum(amount) AS total FROM {{ data }};"
    )
    worktree, _, engine, lineage = launched(services, project)
    preview = engine.preview(worktree, "dev", "collect")
    result = lineage.explain(worktree, "dev", preview["id"], 0, "total")
    assert result["complete"], result
    assert result["value"] == 40
    assert "origin" not in result
    assert [(g["partition"]["key"]["value"], g["rows"]) for g in result["partition_groups"]] == [
        ("a", 2),
        ("b", 1),
    ]
    assert [c["origin"]["partition"]["key"]["value"] for c in result["contributions"]] == ["a", "a", "b"]


def test_partition_checks_read_retained_generations_only(services, monkeypatch):
    project = bundle()
    project["templates"]["transform"] += (
        "\n-- @test large: warning\nSELECT * FROM {{ result }} WHERE amount > 15;"
    )
    worktree, _, engine, _ = launched(services, project)
    page = engine.partitions.page(worktree, "dev", node="transform")
    selected = {"manifest": page["manifest"]["id"], "partition_id": page["entries"][1]["partition_id"]}

    def never(*args, **kwargs):
        raise AssertionError("Inspecting checks must not execute sources")

    monkeypatch.setattr(engine.runs, "_compute", never)
    result = engine.test_rows(worktree, "dev", "transform", "large", partition_context=selected)
    assert result["filtered_count"] == 1
    assert result["rows"][0]["values"] == [20, "two"]
    with pytest.raises(Problem, match="explicit partition"):
        engine.test_rows(worktree, "dev", "transform", "large")


def test_retained_outputs_survive_session_loss_without_substituting_shared_inputs(services):
    worktree, _, engine, lineage = launched(services)
    page = engine.partitions.page(worktree, "dev", node="transform")
    selected = {"manifest": page["manifest"]["id"], "partition_id": page["entries"][1]["partition_id"]}
    engine.pool.discard(worktree)
    preview = engine.preview(worktree, "dev", "transform", partition_context=selected)
    result = lineage.explain(worktree, "dev", preview["id"], 0, "amount", partition_context=selected)
    assert result["value"] == 20
    assert result["origin"]["partition"]["key"]["value"] == "b"
    assert not result["complete"]  # The old shared lookup is not a retained partition artifact.


def test_replay_is_a_new_generation_and_old_origin_is_not_rewritten(services):
    worktree, original, engine, lineage = launched(services)
    store = services[0]
    old = engine.preview(worktree, "dev", "collect")
    unavailable = lineage.explain(worktree, "dev", old["id"], 0, "amount")
    replay = unavailable["replay"]
    run = join_run(
        store, engine.launch(worktree, "dev", replay["node"], partition_selection=replay["partitions"])["id"]
    )
    assert run["status"] == "success", run
    assert run["partitions"]["manifest"] == original["partitions"]["manifest"]
    assert "collect" not in run["nodes"] and "keys" not in run["nodes"]
    page = engine.partitions.page(worktree, "dev", node="transform")
    selected = {"manifest": page["manifest"]["id"], "partition_id": page["entries"][0]["partition_id"]}
    current = engine.preview(worktree, "dev", "transform", partition_context=selected)
    result = lineage.explain(worktree, "dev", current["id"], 0, "amount", partition_context=selected)
    assert result["complete"], result
    assert result["origin"]["run"] == run["id"] != original["id"]
    assert current["id"] != old["id"]
    with pytest.raises(Problem, match="unavailable or stale"):
        lineage.explain(worktree, "dev", old["id"], 0, "amount")
