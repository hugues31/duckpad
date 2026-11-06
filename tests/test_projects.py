import copy
import json
import threading
import time
from pathlib import Path

import pytest
from helpers import example_bundle, files_connection, wait_run, wait_until

from duckpad.auth import Auth
from duckpad.bundle import bundle_to_files, files_to_bundle
from duckpad.components import expand, group, import_definition
from duckpad.engine import Engine
from duckpad.merge import merge_files
from duckpad.projects import QUIET_PERIOD, Projects
from duckpad.util import Problem, dumps


def commit_count(projects, worktree):
    return int(projects.git(worktree["path"], "rev-list", "--count", "HEAD"))


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


def test_rejected_save_writes_and_commits_nothing(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create("Rejected", example_bundle(tmp_path / "input.csv"))
    path = Path(worktree["path"])
    snapshot = projects.snapshot(worktree["id"])
    head = projects.git(path, "rev-parse", "HEAD")
    # A pending external edit would be committed before a valid save.
    (path / "README.md").write_text("External edit")
    proposal = {**snapshot["files"], "flow.json": "{}", "notes.txt": "Not a project definition"}
    with pytest.raises(Problem, match="Only declarative project files"):
        projects.write(worktree["id"], snapshot["revision"], proposal)
    assert projects.git(path, "rev-parse", "HEAD") == head
    assert projects.read_files(worktree) == {**snapshot["files"], "README.md": "External edit"}
    assert not (path / "notes.txt").exists()
    assert projects.store.conflicts(worktree["id"]) == []


def test_external_batch_commits_final_invalid_content_once(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create("Batch", example_bundle(tmp_path / "input.csv"))
    original = commit_count(projects, worktree)
    projects.start_watcher()
    path = Path(worktree["path"])
    (path / "flow.json").write_text("{")
    time.sleep(0.3)
    (path / "README.md").write_text("External save")
    time.sleep(0.3)
    # Both writes fall within one quiet period, so they form a single save unit.
    assert commit_count(projects, worktree) == original
    wait_until(lambda: commit_count(projects, worktree) == original + 1, message="Batch was not committed")
    time.sleep(QUIET_PERIOD)
    assert commit_count(projects, worktree) == original + 1
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
    store.put("session", "expired", {"user": "admin", "version": 0, "expires": 0})
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


def test_revert_undoes_and_redoes_one_save_and_keeps_independent_edits(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create("Undo", example_bundle(tmp_path / "input.csv"))
    snapshot = projects.snapshot(worktree["id"])
    deleted = copy.deepcopy(snapshot["bundle"])
    deleted["flow"]["nodes"] = [n for n in deleted["flow"]["nodes"] if n["id"] != "filter"]
    deleted["flow"]["edges"] = []
    removal = projects.write(worktree["id"], snapshot["revision"], bundle_to_files(deleted))
    assert removal["change"] == removal["commit"]
    # A later save of another node, from a client that never saw the deletion.
    renamed = copy.deepcopy(snapshot["bundle"])
    renamed["flow"]["nodes"][2]["label"] = "Renamed total"
    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(renamed))

    undone = projects.revert(worktree["id"], removal["change"])
    nodes = {n["id"]: n for n in undone["bundle"]["flow"]["nodes"]}
    assert nodes["filter"] == snapshot["bundle"]["flow"]["nodes"][1]
    assert nodes["total"]["label"] == "Renamed total"
    assert sorted(e["id"] for e in undone["bundle"]["flow"]["edges"]) == ["a", "b"]

    redone = projects.revert(worktree["id"], undone["change"])
    nodes = {n["id"]: n for n in redone["bundle"]["flow"]["nodes"]}
    assert sorted(nodes) == ["source", "total"]
    assert nodes["total"]["label"] == "Renamed total"
    assert redone["bundle"]["flow"]["edges"] == []

    unchanged = projects.write(worktree["id"], redone["revision"], redone["files"])
    assert unchanged["change"] is None
    assert unchanged["commit"] == redone["commit"]


def test_revert_accepts_only_commits_of_the_branch(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create("Foreign", example_bundle(tmp_path / "input.csv"))
    other = projects.create("Other", example_bundle(tmp_path / "other.csv"))
    head = projects.snapshot(worktree["id"])["commit"]
    foreign = projects.snapshot(other["id"])["commit"]
    with pytest.raises(Problem, match="no longer part of the branch") as missing:
        projects.revert(worktree["id"], foreign)
    assert missing.value.status == 409
    with pytest.raises(Problem, match="first commit"):
        projects.revert(worktree["id"], head)


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


@pytest.mark.parametrize("choice", ["current", "proposal", "combined"])
@pytest.mark.parametrize("conflicting_file", ["nodes/report.sql", "flow.json"])
@pytest.mark.parametrize("refresh", [False, True])
def test_ui_resolution_preserves_independent_edits(services, choice, conflicting_file, refresh):
    store, projects, _, _ = services
    sql = '-- @param status: text = "paid"\n-- @output result\nSELECT {{ status }} AS status;\n'
    worktree = projects.create(
        "Resolution",
        {
            "flow": {"nodes": [{"id": "report", "params": {"status": "paid"}}], "edges": []},
            "node_sql": {"nodes/report.sql": sql},
            "templates": {"obsolete": "SELECT 1;"},
        },
    )["id"]
    initial = projects.snapshot(worktree)
    incoming, current = copy.deepcopy(initial["bundle"]), copy.deepcopy(initial["bundle"])

    def edit(bundle, version):
        if conflicting_file.endswith(".sql"):
            bundle["node_sql"][conflicting_file] = sql + f"-- {version}\n"
        else:
            bundle["flow"]["nodes"][0]["label"] = version

    edit(incoming, "proposal")
    incoming["flow"]["description"] = "Independent proposal field"
    incoming["templates"]["incoming"] = "SELECT 2;"
    edit(current, "current")
    current["flow"]["nodes"][0]["params"]["status"] = "changed in tab B"
    current["templates"].pop("obsolete")
    current["templates"]["current"] = "SELECT 3;"
    projects.write(worktree, initial["revision"], bundle_to_files(current))
    with pytest.raises(Problem, match="Concurrent edits conflict"):
        projects.write(worktree, initial["revision"], bundle_to_files(incoming))
    conflict = projects.snapshot(worktree)["conflicts"][0]
    expected_path = conflicting_file if conflicting_file.endswith(".sql") else "flow.json/nodes/report/label"
    assert conflict["paths"] == [expected_path]
    assert not conflict["assistant"]
    combined = copy.deepcopy(incoming)
    edit(combined, "combined")
    # The combined editor contains a stale project, including unrelated edits or omissions.
    combined["flow"]["description"] = "Must not replace the independent proposal"
    combined["templates"] = {}
    combined_files = bundle_to_files(combined)
    if refresh:
        snapshot = projects.snapshot(worktree)
        latest = snapshot["bundle"]
        edit(latest, "refreshed")
        latest["flow"]["nodes"][0]["params"]["status"] = "changed again in tab B"
        latest["documentation"]["project"] = "Later documentation"
        projects.write(worktree, snapshot["revision"], bundle_to_files(latest))
        with pytest.raises(Problem, match="Files changed again"):
            projects.resolve(conflict["id"], choice, combined_files)
        assert projects.snapshot(worktree)["files"] == bundle_to_files(latest)
    # Resolution must also work after the in-memory revision caches are lost.
    result = Projects(store).resolve(conflict["id"], choice, combined_files)
    node = result["bundle"]["flow"]["nodes"][0]
    version = "refreshed" if refresh and choice == "current" else choice
    if conflicting_file.endswith(".sql"):
        assert result["files"][conflicting_file] == sql + f"-- {version}\n"
    else:
        assert node["label"] == version
    assert node["params"]["status"] == ("changed again in tab B" if refresh else "changed in tab B")
    assert result["bundle"]["flow"]["description"] == "Independent proposal field"
    assert result["bundle"]["templates"] == {"incoming": "SELECT 2;", "current": "SELECT 3;"}
    if refresh:
        assert result["files"]["README.md"] == "Later documentation"
    assert result["conflicts"] == []


def test_refreshed_ui_conflict_includes_new_conflicting_fields(services):
    store, projects, _, _ = services
    worktree = projects.create("Refresh")["id"]
    initial = projects.snapshot(worktree)
    incoming = copy.deepcopy(initial["bundle"])
    incoming["flow"].update(name="Proposal", description="Proposal description")
    current = initial["bundle"]
    current["flow"]["name"] = "Current"
    saved = projects.write(worktree, initial["revision"], bundle_to_files(current))
    with pytest.raises(Problem, match="Concurrent edits conflict"):
        projects.write(worktree, initial["revision"], bundle_to_files(incoming))
    conflict = projects.snapshot(worktree)["conflicts"][0]
    assert conflict["paths"] == ["flow.json/name"]
    current["flow"]["description"] = "Later description"
    projects.write(worktree, saved["revision"], bundle_to_files(current))
    with pytest.raises(Problem, match="Files changed again"):
        projects.resolve(conflict["id"], "proposal")
    assert projects.conflict(conflict["id"])["paths"] == ["flow.json/description", "flow.json/name"]
    # Review evidence and node names are derived on read, never retained with the conflict.
    assert not {"fields", "merged", "node_names"} & set(store.get("conflict", conflict["id"]))
    result = projects.resolve(conflict["id"], "proposal")
    assert result["bundle"]["flow"]["name"] == "Proposal"
    assert result["bundle"]["flow"]["description"] == "Proposal description"


def test_snapshots_record_no_revision_and_a_restarted_save_finds_its_base(services, tmp_path):
    store, projects, _, _ = services
    worktree = projects.create("Revisions", example_bundle(tmp_path / "input.csv"))
    snapshot = projects.snapshot(worktree["id"], committed=True)
    external = copy.deepcopy(snapshot["bundle"])
    external["flow"]["nodes"][1]["params"]["threshold"] = 15
    (Path(worktree["path"]) / "flow.json").write_text(bundle_to_files(external)["flow.json"])
    projects.flush(worktree["id"])
    snapshot["bundle"]["flow"]["nodes"][1]["label"] = "Renamed filter"
    # A restarted service finds the edited revision among the branch's latest commits.
    restarted = Projects(store)
    result = restarted.write(worktree["id"], snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert result["bundle"]["flow"]["nodes"][1]["params"]["threshold"] == 15
    assert result["bundle"]["flow"]["nodes"][1]["label"] == "Renamed filter"
    with pytest.raises(Problem, match="unavailable"):
        restarted.write(worktree["id"], "unknown", bundle_to_files(snapshot["bundle"]))
    assert store.items("revision") == []


def test_watcher_observes_other_projects_while_a_repository_is_busy(services, tmp_path):
    _, projects, _, _ = services
    busy = projects.create("Busy", example_bundle(tmp_path / "busy.csv"))
    free = projects.create("Free", example_bundle(tmp_path / "free.csv"))
    heads = {w["id"]: projects.git(w["path"], "rev-parse", "HEAD") for w in (busy, free)}

    def saved(worktree):
        return projects.git(worktree["path"], "rev-parse", "HEAD") != heads[worktree["id"]]

    projects.start_watcher()
    with projects.repository(busy["project"]):
        for worktree in (busy, free):
            (Path(worktree["path"]) / "README.md").write_text("External save")
        wait_until(lambda: saved(free), message="A busy repository delayed the watcher")
        assert not saved(busy)
    wait_until(lambda: saved(busy), message="The released repository was not observed again")


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
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["flow"]["nodes"][0]["params"]["connection"] = files_connection(catalog)
    worktree = projects.create("Concurrent", bundle)["id"]
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


def test_invalid_template_keeps_only_its_declared_ports(tmp_path):
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["total"] = (
        "--@input source\n-- @output result\n-- @unknown\nSELECT * FROM {{ source }} -- @input ghost"
    )
    node = expand(bundle, tolerant=True)[0]["total"]
    assert node["parsed"]["inputs"] == ["source"]
    assert node["error"] == "Unknown template directive: @unknown"


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


def note_files(ids, edited=None):
    notes = [
        {"id": identity, "text": "edited" if index == edited else "original"}
        for index, identity in enumerate(ids)
    ]
    return {"flow.json": dumps({"notes": notes})}


def test_lists_with_unique_string_ids_merge_by_identity():
    merged, conflicts = merge_files(
        note_files(["a", "b"]), note_files(["a", "b"], 0), note_files(["a", "b"], 1)
    )
    assert conflicts == []
    assert [note["text"] for note in json.loads(merged["flow.json"])["notes"]] == ["edited", "edited"]


@pytest.mark.parametrize("ids", [[1, 2], ["a", "a"], [["a"], ["b"]], [None, "b"], [True, False]])
def test_lists_without_unique_string_ids_merge_as_whole_values(ids):
    current = note_files(ids, 0)
    merged, conflicts = merge_files(note_files(ids), current, note_files(ids, 1))
    assert conflicts == ["flow.json/notes"]
    assert merged == current


@pytest.mark.parametrize("delete", [False, True])
@pytest.mark.parametrize("name", ["README.md", "documentation.json", "flow.json", "views.json"])
def test_combined_resolution_preserves_deletions_and_logical_paths(name, delete):
    def content(value):
        if name == "README.md":
            return value
        if name == "documentation.json":
            return dumps({"nodes": {"nested/report~1": value}})
        if name == "flow.json":
            return dumps({"notes": [{"id": "second", "text": value}, {"id": "first", "text": "kept"}]})
        return dumps({"report:result": [{"name": "My/view", "filter": value}]})

    base, current, proposal = ({name: content(value)} for value in ("base", "current", "proposal"))
    current["templates/current.sql"] = "SELECT 1;"
    proposal["templates/proposal.sql"] = "SELECT 2;"
    _, paths = merge_files(base, current, proposal)
    combined = {} if delete else {name: content("combined")}
    merged, conflicts = merge_files(base, current, proposal, dict.fromkeys(paths, "combined"), [], combined)
    assert not conflicts
    assert merged["templates/current.sql"] == "SELECT 1;"
    assert merged["templates/proposal.sql"] == "SELECT 2;"
    if not delete:
        assert merged[name] == content("combined")
    elif name == "README.md":
        assert name not in merged
    elif name == "documentation.json":
        assert json.loads(merged[name]) == {"nodes": {}}
    elif name == "flow.json":
        assert json.loads(merged[name])["notes"] == [
            {"id": "second"},
            {"id": "first", "text": "kept"},
        ]
    else:
        assert json.loads(merged[name]) == {"report:result": [{"name": "My/view"}]}
