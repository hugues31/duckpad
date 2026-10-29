import copy
import json
import threading
import time
from pathlib import Path

import pytest
from helpers import example_bundle, wait_run, wait_until

from duckpad.auth import Auth
from duckpad.bundle import bundle_to_files, files_to_bundle
from duckpad.components import expand, group, import_definition
from duckpad.engine import Engine
from duckpad.projects import QUIET_PERIOD, Projects
from duckpad.util import Problem


def test_authentication_password_survives_restart_without_plaintext(services):
    store, *_ = services
    initial = Auth(store)
    password = initial.initial_password
    assert password
    token = initial.login("admin", password)
    initial.check(token)
    restarted = Auth(store)
    assert restarted.initial_password is None
    restarted.login("admin", password)
    assert password not in json.dumps(store.get("user", "admin"))


def test_project_files_require_documentation():
    with pytest.raises(Problem, match=r"documentation\.json"):
        files_to_bundle({"flow.json": '{"nodes": [], "edges": []}'})


def test_external_batch_commits_final_invalid_content_once(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create("Batch", example_bundle(tmp_path / "input.csv"))
    original = len(projects.history(worktree["id"]))
    projects.start_watcher()
    path = Path(worktree["path"])
    (path / "flow.json").write_text("{")
    time.sleep(0.3)
    (path / "README.md").write_text("External save")
    time.sleep(0.3)
    # Both writes fall within one quiet period, so they form a single save unit.
    assert len(projects.history(worktree["id"])) == original
    wait_until(
        lambda: len(projects.history(worktree["id"])) == original + 1, message="Batch was not committed"
    )
    time.sleep(QUIET_PERIOD)
    assert len(projects.history(worktree["id"])) == original + 1
    snapshot = projects.snapshot(worktree["id"])
    assert snapshot["bundle"] is None
    assert snapshot["files"]["flow.json"] == "{"
    assert snapshot["diagnostics"]


def test_non_utf8_file_is_reported_without_stopping_the_watcher(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create("Encoding", example_bundle(tmp_path / "input.csv"))
    projects.start_watcher()
    path = Path(worktree["path"]) / "templates" / "latin.sql"
    path.write_bytes("-- @output result\nSELECT 'é' AS letter;".encode("latin-1"))
    with pytest.raises(Problem, match="not valid UTF-8"):
        projects.snapshot(worktree["id"])
    time.sleep(QUIET_PERIOD * 2)
    assert projects.thread.is_alive()
    path.write_text("-- @output result\nSELECT 'é' AS letter;", encoding="utf-8")
    wait_until(
        lambda: "templates/latin.sql" in projects.snapshot(worktree["id"], committed=True)["files"],
        message="The corrected file was not committed",
    )


def test_merge_review_keeps_files_without_a_trailing_newline(services, tmp_path):
    _, projects, _, _ = services
    main = projects.create("Merge base", example_bundle(tmp_path / "input.csv"))["id"]

    def edit(worktree, name, change):
        snapshot = projects.snapshot(worktree)
        files = snapshot["files"]
        files[name] = change(files[name])
        projects.write(worktree, snapshot["revision"], files)

    edit(main, "templates/total.sql", lambda text: text.rstrip("\n"))
    branch = projects.branch(main, "experiment")["id"]
    edit(main, "templates/total.sql", lambda text: text + "\n-- edited on main")
    edit(branch, "README.md", lambda _: "Edited on the branch\n")
    preview = projects.versioning.prepare(main, "refs/heads/experiment")
    assert preview["conflicts"] == []
    assert preview["files"]["templates/total.sql"].endswith("-- edited on main")
    assert "Edited on the branch" in preview["files"]["README.md"]


def test_login_purges_expired_sessions(services):
    store, *_ = services
    auth = Auth(store)
    store.put("session", "expired", {"expires": 0})
    auth.login("admin", auth.initial_password)
    assert store.get("session", "expired") is None


def test_external_and_ui_disjoint_edits_merge(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create("Merge fields", example_bundle(tmp_path / "input.csv"))
    snapshot = projects.snapshot(worktree["id"])
    external = copy.deepcopy(snapshot["bundle"])
    external["flow"]["nodes"][1]["params"]["threshold"] = 15
    (Path(worktree["path"]) / "flow.json").write_text(bundle_to_files(external)["flow.json"])
    snapshot["bundle"]["flow"]["nodes"][1]["label"] = "Renamed filter"
    result = projects.write(worktree["id"], snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert result["bundle"]["flow"]["nodes"][1]["params"]["threshold"] == 15
    assert result["bundle"]["flow"]["nodes"][1]["label"] == "Renamed filter"


def test_conflict_survives_service_restart_and_refreshes_on_new_external_edit(services, tmp_path):
    store, projects, _, engine = services
    worktree = projects.create("Conflict", example_bundle(tmp_path / "input.csv"))
    initial = projects.snapshot(worktree["id"])
    a, b = copy.deepcopy(initial["bundle"]), copy.deepcopy(initial["bundle"])
    a["flow"]["nodes"][1]["params"]["threshold"] = 10
    b["flow"]["nodes"][1]["params"]["threshold"] = 20
    path = Path(worktree["path"]) / "flow.json"
    path.write_text(bundle_to_files(a)["flow.json"])
    with pytest.raises(Problem):
        projects.write(worktree["id"], initial["revision"], bundle_to_files(b))
    conflict = Projects(store).snapshot(worktree["id"])["conflicts"][0]
    with pytest.raises(Problem, match="conflicts"):
        engine.launch(worktree["id"], "dev")
    a["flow"]["nodes"][1]["params"]["threshold"] = 30
    path.write_text(bundle_to_files(a)["flow.json"])
    with pytest.raises(Problem, match="changed again"):
        projects.resolve(conflict["id"], "proposal")
    assert "30" in store.get("conflict", conflict["id"])["current"]["flow.json"]
    resolved = projects.resolve(conflict["id"], "proposal")
    assert resolved["bundle"]["flow"]["nodes"][1]["params"]["threshold"] == 20


def test_branch_isolation_and_doc_merge_does_not_invalidate(services, tmp_path):
    store, projects, _, engine = services
    main = projects.create("Branch", example_bundle(tmp_path / "input.csv"))
    wait_run(store, engine.launch(main["id"], "dev"))
    branch = projects.branch(main["id"], "feature/documentation")
    snapshot = projects.snapshot(branch["id"])
    snapshot["bundle"]["documentation"]["project"] = "A business definition"
    projects.write(branch["id"], snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert not projects.snapshot(main["id"])["bundle"]["documentation"]
    comparison = projects.versioning.prepare(main["id"], "refs/heads/feature/documentation")
    assert not comparison["conflicts"]
    merged = projects.versioning.apply(main["id"], comparison["id"], {}, comparison["proposal_revision"])
    assert merged["bundle"]["documentation"]["project"] == "A business definition"
    assert engine.preview(main["id"], "dev", "total")["status"] == "valid"
    assert len(projects.git(main["path"], "show", "--format=%P", "--no-patch", "HEAD").split()) == 2


def test_component_group_and_import_copy_are_independent(services, tmp_path):
    store, projects, _, engine = services
    bundle, _instance = group(
        example_bundle(tmp_path / "input.csv"),
        ["filter", "total"],
        "Summary",
        {"minimum": {"type": "number", "default": 0, "targets": [{"node": "filter", "param": "threshold"}]}},
    )
    source = projects.create("Source", bundle)
    run = wait_run(store, engine.launch(source["id"], "dev"))
    assert run["status"] == "success", run
    target = projects.create("Target")
    snap = projects.snapshot(target["id"])
    component = bundle["flow"]["nodes"][-1]["component"]
    imported, identity = import_definition(snap["bundle"], bundle, "components", component, {})
    assert identity != component
    assert all(n["template"] in imported["templates"] for n in imported["components"][identity]["nodes"])
    imported["components"][identity]["name"] = "Independent summary"
    assert bundle["components"][component]["name"] == "Summary"
    expand(bundle)


def test_edit_during_execution_preserves_launch_sql_and_publishes_stale(services, tmp_path):
    store, projects, catalog, engine = services
    worktree = projects.create("Concurrent", example_bundle(tmp_path / "input.csv"))["id"]
    entered, release = threading.Event(), threading.Event()
    prepare = catalog.prepare

    def pause(db, captured):
        entered.set()
        release.wait(5)
        prepare(db, captured)

    catalog.prepare = pause
    run = engine.launch(worktree, "dev")
    assert entered.wait(2)
    snapshot = projects.snapshot(worktree)
    snapshot["bundle"]["flow"]["nodes"][1]["params"]["threshold"] = 25
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    release.set()
    result = wait_run(store, run)
    assert result["status"] == "success"
    assert result["nodes"]["filter"]["statements"][0]["bindings"]["threshold"] == 0
    assert engine.preview(worktree, "dev", "total")["status"] == "stale"
    assert engine.preview(worktree, "dev", "source")["status"] == "valid"


def test_execution_history_survives_restart_but_datasets_do_not(services, tmp_path):
    store, projects, catalog, engine = services
    worktree = projects.create("History", example_bundle(tmp_path / "input.csv"))["id"]
    completed = wait_run(store, engine.launch(worktree, "dev"))
    restart = Engine(store, projects, catalog)
    try:
        assert store.get("run", completed["id"])["nodes"]["total"]["statements"]
        with pytest.raises(Problem, match="No materialized result"):
            restart.preview(worktree, "dev", "total")
    finally:
        restart.close()


def test_invalid_template_scope_does_not_block_independent_nodes(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["flow"]["nodes"].append({"id": "invalid", "template": "missing", "params": {}})
    worktree = projects.create("Invalid scope", bundle)["id"]
    result = wait_run(store, engine.launch(worktree, "dev"))
    assert result["nodes"]["invalid"]["status"] == "blocked"
    assert result["nodes"]["total"]["status"] == "success"
    assert result["status"] == "partial_failure"
    assert wait_run(store, engine.launch(worktree, "dev", "total"))["status"] == "success"


def test_column_documentation_is_removed_only_after_confirmed_schema_change(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["documentation"]["columns"] = {
        "filter:result": {"amount": "Order amount", "region": "Sales region"}
    }
    worktree = projects.create("Column lifecycle", bundle)["id"]
    wait_run(store, engine.launch(worktree, "dev"))
    snapshot = projects.snapshot(worktree)
    snapshot["bundle"]["templates"]["filter"] = (
        "-- @input source\n-- @output result\nSELECT id, region, amount AS total FROM {{ source }};"
    )
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert "amount" in projects.snapshot(worktree)["bundle"]["documentation"]["columns"]["filter:result"]
    assert wait_run(store, engine.launch(worktree, "dev", "filter"))["status"] == "success"
    docs = projects.snapshot(worktree)["bundle"]["documentation"]["columns"]["filter:result"]
    assert docs == {"region": "Sales region"}


def test_group_import_and_explicit_deletion_preserve_documentation_lifecycle(services, tmp_path):
    _store, projects, _, _ = services
    bundle = example_bundle(tmp_path / "docs.csv")
    bundle["documentation"] = {
        "nodes": {"filter": "Keep qualifying orders."},
        "columns": {"filter:result": {"amount": "Order amount."}},
    }
    worktree = projects.create("Documentation", bundle)["id"]
    snapshot = projects.snapshot(worktree)
    grouped, instance = group(snapshot["bundle"], ["filter"], "Qualifying orders")
    saved = projects.write(worktree, snapshot["revision"], bundle_to_files(grouped))
    assert (
        saved["bundle"]["documentation"]["columns"][instance + "::filter:result"]["amount"] == "Order amount."
    )
    definition = grouped["flow"]["nodes"][-1]["component"]
    empty = {"flow": {"nodes": [], "edges": []}, "templates": {}, "components": {}, "documentation": {}}
    imported, identity = import_definition(empty, saved["bundle"], "components", definition, {})
    imported["flow"]["nodes"] = [{"id": "copy", "component": identity, "params": {}}]
    destination = projects.create("Imported docs", imported)["id"]
    copied = projects.snapshot(destination)
    assert copied["bundle"]["documentation"]["columns"]["copy::filter:result"]["amount"] == "Order amount."
    copied["bundle"]["flow"]["nodes"] = []
    deleted = projects.write(destination, copied["revision"], bundle_to_files(copied["bundle"]))
    assert not deleted["bundle"]["documentation"]["columns"]
    assert (
        "Order amount."
        in projects.revision_files(projects.get(destination)["path"], copied["commit"])["documentation.json"]
    )
