"""Polling caches must save work without hiding changes or weakening access checks."""

import copy

import pytest
from helpers import join_run
from test_partitions import bundle

from duckpad.bundle import bundle_to_files
from duckpad.jobs import Jobs
from duckpad.partition_storage import PartitionStorage
from duckpad.project_view import project_view
from duckpad.services import Services
from duckpad.util import Problem


def service_record(services):
    return Services(*services, None)


def test_snapshot_reuses_definitions_but_refreshes_permissions_and_connections(services, monkeypatch):
    store, projects, _, engine = services
    tree = projects.create("Cached editor", bundle())
    store.put(
        "connection",
        "files",
        {"name": "Files", "connector": "folder", "secret_fields": [], "environments": {}},
    )
    engine.access.grant_connections(tree["project"], ["files"])
    user = {"id": "admin", "role": "admin"}
    first = project_view(service_record(services), user, tree["id"])
    original_open = store._open

    def no_secrets(kind, *args):
        assert kind != "connection"
        return original_open(kind, *args)

    def no_parse(*args, **kwargs):
        raise AssertionError("Warm snapshots must reuse file-derived metadata")

    monkeypatch.setattr(store, "_open", no_secrets)
    monkeypatch.setattr("duckpad.projects.diagnose", no_parse)
    monkeypatch.setattr("duckpad.project_view.parse_templates", no_parse)
    first["bundle"]["templates"].clear()
    second = project_view(service_record(services), user, tree["id"])
    assert second["bundle"]["templates"]
    assert second["connections"][0]["name"] == "Files"
    engine.access.grant_connections(tree["project"], [])
    assert project_view(service_record(services), user, tree["id"])["connections"] == []


def test_warm_partition_preview_does_not_expand_keys_and_edits_invalidate_it(services, monkeypatch):
    from duckpad.execution import fingerprints

    store, projects, _, engine = services
    tree = projects.create("Cached partitions", bundle())
    run = join_run(store, engine.launch(tree["id"], "dev")["id"])
    selection = {"manifest": run["partitions"]["manifest"], "partition_mode": "all"}
    first = engine.preview(tree["id"], "dev", "transform", partition_context=selection)
    calls = []
    original = fingerprints.expand_for

    def count(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(fingerprints, "expand_for", count)
    second = engine.preview(tree["id"], "dev", "transform", partition_context=selection)
    assert second["rows"] == first["rows"]
    assert calls == []
    snapshot = projects.snapshot(tree["id"])
    snapshot["bundle"]["templates"]["transform"] = snapshot["bundle"]["templates"]["transform"].replace(
        "d.amount * l.rate", "d.amount + l.rate"
    )
    projects.write(tree["id"], snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert engine.preview(tree["id"], "dev", "transform", partition_context=selection)["status"] == "stale"
    assert calls


def test_repeated_partition_runs_share_manifest_without_overwriting_attempts(services):
    store, projects, _, engine = services
    tree = projects.create("Stable keys", bundle())
    first = join_run(store, engine.launch(tree["id"], "dev")["id"])
    storage = PartitionStorage(store, tree["id"], "dev")
    entries = storage.entries(first["partitions"]["manifest"])
    evidence = copy.deepcopy(storage.attempts(first["id"], entries[0]["partition_id"]))
    second = join_run(store, engine.launch(tree["id"], "dev")["id"])
    assert second["partitions"]["manifest"] == first["partitions"]["manifest"]
    assert storage.entries(second["partitions"]["manifest"]) == entries
    assert storage.attempts(first["id"], entries[0]["partition_id"]) == evidence
    assert storage.attempts(second["id"], entries[0]["partition_id"])


def test_element_history_finds_change_beyond_sixty_unrelated_saves(services, monkeypatch):
    _, projects, _, _ = services
    tree = projects.create("Sparse history", bundle())
    changed = projects.snapshot(tree["id"])["commit"]
    for index in range(60):
        projects.git(tree["path"], "commit", "--allow-empty", "-m", f"Save unrelated change {index}")

    def no_archive(*args):
        raise AssertionError("Element history must read only its blobs")

    monkeypatch.setattr(projects, "revision_files", no_archive)
    page = projects.versioning.history(tree["id"], entity="node/source", limit=1)
    assert page["items"][0]["commit"] == changed
    assert page["next"] is None


def test_run_summaries_page_ties_without_captured_project_and_retain_references(services):
    store, projects, _, _ = services
    tree = projects.create("Summary history")
    for index in range(6):
        identity = f"run_{index}"
        store.put(
            "run",
            identity,
            {
                "id": identity,
                "project": tree["project"],
                "worktree": tree["id"],
                "environment": "dev",
                "started": "2026-01-01T00:00:00Z",
                "status": "success",
                "definitions": {"large": "SELECT 1;" * 1000},
                "nodes": {},
                "connections": {},
            },
        )
    user = {"role": "admin"}
    first = store.runs(user, tree["id"], limit=2, summary=True)
    second = store.runs(user, tree["id"], limit=2, summary=True, cursor=store.run_cursor(first[-1]))
    assert [r["id"] for r in first + second] == ["run_5", "run_4", "run_3", "run_2"]
    assert not ({"definitions", "nodes", "connections"} & first[0].keys())
    assert store.get("run", "run_5")["definitions"]
    with pytest.raises(Problem, match="cursor"):
        store.runs(user, cursor="invalid", summary=True)
    assert store.prune_runs(tree["id"], "dev", keep=2, protected={"run_0"}) == 3
    assert {r["id"] for r in store.runs(user)} == {"run_0", "run_4", "run_5"}


def test_job_listing_handles_branch_refs_without_an_annotated_tag(services, monkeypatch):
    from duckpad.schemas import NewJob

    _, projects, _, _ = services
    tree = projects.create("Branch jobs")
    jobs = Jobs(service_record(services))
    for index in range(3):
        jobs.create(
            tree["project"],
            NewJob(
                slug=f"job-{index}",
                name=f"Job {index}",
                environment="dev",
                target={"kind": "branch", "ref": "main"},
            ),
            {"id": "admin", "username": "admin"},
        )
    commands = []
    original = projects.git

    def count(path, *args, **kwargs):
        commands.append(args[0])
        return original(path, *args, **kwargs)

    monkeypatch.setattr(projects, "git", count)
    listed = jobs.listing(tree["project"])
    assert len(listed) == 3
    assert all(job["resolved_commit"] and job["warning"] is None for job in listed)
    assert commands == ["for-each-ref"]


def test_retention_preserves_reused_manifest_owners_and_expires_obsolete_evidence(services):
    store, projects, _, _ = services
    tree = projects.create("Manifest retention")
    storage = PartitionStorage(store, tree["id"], "dev")
    for index in range(4):
        identity = f"run_{index}"
        store.put(
            "run",
            identity,
            {
                "project": tree["project"],
                "worktree": tree["id"],
                "environment": "dev",
                "started": f"2026-01-01T00:00:0{index}Z",
                "status": "success",
                "partitions": {"manifest": "manifest_0" if index == 3 else f"manifest_{index}"},
            },
        )
        if index == 3:
            continue
        storage.publish_manifest(
            {
                "id": f"manifest_{index}",
                "run": identity,
                "source": "keys",
                "dimension": {"name": "batch"},
                "schema": [],
                "signature": f"signature_{index}",
                "created": f"2026-01-01T00:00:0{index}Z",
            },
            [],
        )
        storage.attempt(identity, "key", "source", {"status": "success"})
    assert store.prune_runs(tree["id"], "dev", keep=1) == 1
    assert store.get("run", "run_0")  # Older producer referenced by the newest run.
    assert storage.manifest(identity="manifest_0")
    assert storage.manifest(identity="manifest_2")  # Current key list.
    assert storage.manifest(identity="manifest_1") is None
    assert storage.attempts("run_1", "key") == {}
