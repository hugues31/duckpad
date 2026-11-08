"""Inspection contexts must never execute a source or silently choose another key."""

import threading

import pytest
from helpers import join_run
from test_partitions import bundle

from duckpad.util import Problem


def test_partition_reads_preserve_live_results_after_resource_changes(services, monkeypatch):
    store, projects, _, engine = services
    worktree = projects.create("Retained partitions", bundle())["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    selection = {"manifest": run["partitions"]["manifest"], "partition_mode": "all"}
    context = engine.context(worktree, "dev")
    database = context.db
    retained = set(context.datasets)
    entered, release = threading.Event(), threading.Event()
    compute = engine.runs._compute

    def pause(*args, **kwargs):
        entered.set()
        assert release.wait(10)
        return compute(*args, **kwargs)

    monkeypatch.setattr(engine.runs, "_compute", pause)
    active = engine.launch(worktree, "dev")
    try:
        assert entered.wait(10)
        engine.configure_sql_resources({"threads": 2, "memory_limit": "1GiB"})
        preview = engine.preview(worktree, "dev", "transform", partition_context=selection)
        assert len(preview["rows"]) == 3
        assert engine.context(worktree, "dev") is context
        assert context.db is database and not database.closed
        assert retained <= context.datasets.keys()
    finally:
        release.set()
    assert join_run(store, active["id"])["status"] == "success"


def test_explicit_contexts_paging_and_retained_reads(services, monkeypatch):
    store, projects, _, engine = services
    worktree = projects.create("Partition inspection", bundle())["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    manifest = run["partitions"]["manifest"]

    def never(*args, **kwargs):
        raise AssertionError("Inspection must not execute nodes")

    monkeypatch.setattr(engine.runs, "_compute", never)
    page = engine.partitions.page(worktree, "dev", node="transform", limit=1)
    assert page["entries"][0]["key"]["value"] == "a"
    second = engine.partitions.page(worktree, "dev", node="transform", limit=1, cursor=page["next_cursor"])
    assert second["entries"][0]["key"]["value"] == "b"
    assert second["next_cursor"] is None
    with pytest.raises(Problem, match="cursor"):
        engine.partitions.page(worktree, "dev", node="source", cursor=page["next_cursor"])
    selected = {"manifest": manifest, "partition_id": page["entries"][0]["partition_id"]}
    rows = engine.preview(worktree, "dev", "transform", partition_context=selected)
    assert [r["values"] for r in rows["rows"]] == [[10, "one"], [10, "one"]]
    assert rows["partition_context"] == selected
    assert rows["executed_sql"]
    with pytest.raises(Problem, match="explicit partition manifest"):
        engine.preview(worktree, "dev", "transform")
    with pytest.raises(Problem, match="Select one"):
        engine.preview(worktree, "dev", "transform", partition_context={**selected, "partition_mode": "all"})
    with pytest.raises(Problem, match="does not belong"):
        engine.preview(worktree, "prod", "transform", partition_context=selected)
    all_keys = {"manifest": manifest, "partition_mode": "all"}
    preview = engine.preview(worktree, "dev", "transform", partition_context=all_keys)
    assert [r["values"] for r in preview["rows"]] == [[10, "one"], [10, "one"], [20, "two"]]
    statements = engine.compile(
        worktree, "dev", "source", partition=engine.partitions.compile_entry(worktree, "dev", all_keys)
    )
    assert statements[0]["partition_plan"]
    assert statements[0]["bindings"]["dp_partition_key"] is None


def test_eviction_is_honest_and_all_is_incomplete(services):
    store, projects, _, engine = services
    worktree = projects.create("Preview retention", bundle())["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    page = engine.partitions.page(worktree, "dev", node="source")
    selected = {"manifest": run["partitions"]["manifest"], "partition_id": page["entries"][0]["partition_id"]}
    with pytest.raises(Problem, match="partition_not_retained"):
        engine.preview(worktree, "dev", "source", partition_context=selected)
    preview = engine.preview(
        worktree,
        "dev",
        "source",
        partition_context={"manifest": selected["manifest"], "partition_mode": "all"},
    )
    assert preview["incomplete"] == {"available": 1, "total": 2}
    assert preview["status"] == "stale"
