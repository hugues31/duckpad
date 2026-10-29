import copy
import json
import subprocess
import threading
from pathlib import Path
from unittest.mock import Mock

import duckdb
import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.bundle import bundle_to_files
from duckpad.comparison import commit_message, compare_files
from duckpad.components import group
from duckpad.remote import validate_url
from duckpad.util import Problem


def bundle():
    return {
        "flow": {
            "name": "Revenue",
            "nodes": [
                {
                    "id": "orders",
                    "template": "orders",
                    "label": "Orders",
                    "params": {},
                    "position": {"x": 0, "y": 0},
                },
                {
                    "id": "filter",
                    "template": "filter",
                    "label": "Paid orders",
                    "params": {"minimum": 0},
                    "position": {"x": 220, "y": 0},
                },
                {
                    "id": "total",
                    "template": "total",
                    "label": "Regional revenue",
                    "params": {},
                    "position": {"x": 440, "y": 0},
                },
            ],
            "edges": [
                {
                    "id": "a",
                    "source": "orders",
                    "sourceHandle": "result",
                    "target": "filter",
                    "targetHandle": "source",
                },
                {
                    "id": "b",
                    "source": "filter",
                    "sourceHandle": "result",
                    "target": "total",
                    "targetHandle": "source",
                },
            ],
        },
        "templates": {
            "orders": "-- @label Orders\n-- @output result\nSELECT 1 AS amount;",
            "filter": "-- @label Filter\n-- @input source\n-- @param minimum: number = 0\n-- @output result\nSELECT * FROM {{ source }} WHERE amount > {{ minimum }};",
            "total": "-- @label Regional revenue\n-- @input source\n-- @output result\nSELECT SUM(amount) AS revenue FROM {{ source }};",
        },
        "components": {},
        "documentation": {},
    }


@pytest.fixture
def project(services):
    _, projects, _, _ = services
    return projects, projects.create("Revenue", bundle())


def edit(projects, worktree, action):
    snapshot = projects.snapshot(worktree["id"])
    action(snapshot["bundle"])
    return projects.write(worktree["id"], snapshot["revision"], bundle_to_files(snapshot["bundle"]))


def apply(projects, review, choices=None):
    proposal = projects.versioning.proposal(review["worktree"], review["id"], choices or {})
    return projects.versioning.apply(
        review["worktree"], review["id"], choices or {}, proposal["proposal_revision"]
    )


def test_comparison_freezes_working_files_without_saves_or_execution(project, monkeypatch):
    projects, main = project
    head = projects.git(main["path"], "rev-parse", "HEAD")
    files = projects.read_files(main)
    data = json.loads(files["flow.json"])
    data["nodes"][1]["params"]["minimum"] = 42
    Path(main["path"], "flow.json").write_text(json.dumps(data))
    before_status = projects.git(main["path"], "status", "--porcelain")
    before_records = projects.store.items("revision")

    def forbidden(*args, **kwargs):
        raise AssertionError("Comparison tried to mutate or execute")

    monkeypatch.setattr(projects, "flush", forbidden)
    monkeypatch.setattr(projects, "commit", forbidden)
    monkeypatch.setattr(projects, "on_change", forbidden)
    result = projects.versioning.compare(main["id"], "HEAD", "working")
    assert result["a"]["commit"] == head
    assert result["b"]["ref"].startswith("frozen_")
    assert result["impact"]["status"] == "partial"
    assert result["impact"]["direct"] == ["filter"]
    assert result["impact"]["downstream"] == ["total"]
    Path(main["path"], "flow.json").write_text(files["flow.json"])
    frozen = projects.versioning.compare(main["id"], result["a"]["ref"], result["b"]["ref"])
    assert frozen["entities"] == result["entities"]
    assert frozen["b"] == result["b"]
    assert frozen["a"]["commit"] == result["a"]["commit"]
    assert projects.git(main["path"], "rev-parse", "HEAD") == head
    assert before_status and not projects.git(main["path"], "status", "--porcelain")
    assert projects.store.items("revision") == before_records
    assert projects.store.all("run") == []


def test_layout_names_sql_and_parameters_have_distinct_categories():
    before = bundle()
    after = copy.deepcopy(before)
    after["flow"]["nodes"][1]["position"] = {"x": 800, "y": 800}
    report = compare_files(bundle_to_files(before), bundle_to_files(after))
    assert report["categories"] == {"processing": 0, "documentation": 0, "layout": 1}
    assert report["impact"]["direct"] == report["impact"]["downstream"] == []
    assert report["impact"]["status"] == "not_applicable"
    assert commit_message(bundle_to_files(before), bundle_to_files(after)).startswith(
        "style(canvas): reposition Paid orders"
    )
    after["flow"]["nodes"][1]["params"]["label"] = "sensitive-parameter-value"
    after["flow"]["nodes"][1]["label"] = "Renamed filter"
    report = compare_files(bundle_to_files(before), bundle_to_files(after))
    node = next(e for e in report["entities"] if e["id"] == "node/filter")
    assert set(node["categories"]) == {"processing", "layout", "documentation"}
    assert "sensitive-parameter-value" not in commit_message(bundle_to_files(before), bundle_to_files(after))
    after = copy.deepcopy(before)
    after["templates"]["total"] = after["templates"]["total"].replace("Regional revenue", "Regional sales")
    report = compare_files(bundle_to_files(before), bundle_to_files(after))
    assert report["categories"]["processing"] == 0
    assert not report["impact"]["direct"]
    after["templates"]["total"] += "\n-- SQL implementation change"
    entity = next(
        e
        for e in compare_files(bundle_to_files(before), bundle_to_files(after))["entities"]
        if e["id"] == "template/total"
    )
    assert set(entity["categories"]) == {"processing", "documentation"}


def test_deleted_nodes_and_edges_and_nested_scopes_remain_inspectable():
    before = bundle()
    after = copy.deepcopy(before)
    after["flow"]["nodes"].pop()
    after["flow"]["edges"].pop()
    report = compare_files(bundle_to_files(before), bundle_to_files(after))
    removed = [e for e in report["entities"] if e["status"] == "removed"]
    assert {e["id"] for e in removed} == {"node/total", "edge/b"}
    assert all(e["before"] and e["after"] is None for e in removed)
    nested, instance = group(before, ["filter", "total"], "Summary")
    outer, outer_instance = group(nested, [instance], "Nested report")
    changed = copy.deepcopy(outer)
    changed["templates"]["filter"] += "\n-- changed SQL"
    result = compare_files(bundle_to_files(outer), bundle_to_files(changed))
    assert f"{outer_instance}::{instance}::filter" in result["impact"]["direct"]
    assert f"{outer_instance}::{instance}::total" in result["impact"]["downstream"]
    assert outer_instance in result["impact"]["after_scopes"]
    changed["templates"]["filter"] = "not a valid definition"
    partial = compare_files(bundle_to_files(outer), bundle_to_files(changed))
    assert partial["impact"]["status"] == "partial"
    assert partial["impact"]["diagnostics"]


def test_commit_summaries_external_batches_multiple_entities_and_noop(project):
    projects, main = project
    first = projects.git(main["path"], "rev-parse", "HEAD")
    renamed = edit(projects, main, lambda b: b["flow"]["nodes"][1].update(label="Qualifying orders"))
    assert projects.history(main["id"])[0]["message"] == "docs(node): rename Qualifying orders"
    edit(projects, main, lambda b: None)
    assert projects.snapshot(main["id"])["commit"] == renamed["commit"]
    snapshot = projects.snapshot(main["id"])
    snapshot["bundle"]["flow"]["nodes"][1]["params"]["minimum"] = 10
    snapshot["bundle"]["templates"]["total"] += "\n-- change"
    for name, content in bundle_to_files(snapshot["bundle"]).items():
        Path(main["path"], name).write_text(content)
    projects.flush(main["id"])
    message = projects.git(main["path"], "log", "-1", "--format=%B")
    assert message.startswith("feat(project): update 2 elements")
    assert "[external]" in message and "Qualifying orders" in message and "Regional revenue" in message
    assert projects.git(main["path"], "cat-file", "-t", first) == "commit"
    Path(main["path"], "private.txt").write_text("never publish")
    projects.git(main["path"], "add", "private.txt")
    edit(projects, main, lambda b: b["documentation"].update(project="Description"))
    assert "private.txt" not in projects.git(main["path"], "ls-tree", "-r", "--name-only", "HEAD")
    assert "private.txt" in projects.git(main["path"], "diff", "--cached", "--name-only")


def test_review_field_choices_keeps_ancestry_and_rejects_stale_heads(project):
    projects, main = project
    feature = projects.branch(main["id"], "feature")
    edit(projects, main, lambda b: b["flow"]["nodes"][1]["params"].update(minimum=10))
    edit(projects, feature, lambda b: b["flow"]["nodes"][1]["params"].update(minimum=20))
    review = projects.versioning.prepare(main["id"], "refs/heads/feature")
    conflict = review["conflicts"][0]
    assert conflict["path"] == "flow.json/nodes/filter/params/minimum"
    assert [conflict[k]["value"] for k in ("base", "current", "incoming")] == [0, 10, 20]
    with pytest.raises(Problem, match="Resolve conflicts"):
        apply(projects, review)
    choices = {conflict["path"]: "incoming"}
    result = apply(projects, review, choices)
    assert result["bundle"]["flow"]["nodes"][1]["params"]["minimum"] == 20
    assert projects.git(main["path"], "show", "-s", "--format=%P", "HEAD").split() == [
        review["target_head"],
        review["source_head"],
    ]
    assert projects.history(main["id"])[0]["message"] == "chore(merge): merge feature into main"
    # Same files, different ancestry still invalidates the reviewed target.
    edit(projects, feature, lambda b: b["documentation"].update(project="New documentation"))
    stale = projects.versioning.prepare(main["id"], "refs/heads/feature")
    projects.git(main["path"], "commit", "--allow-empty", "-m", "chore: advance ancestry")
    with pytest.raises(Problem, match="heads changed"):
        apply(projects, stale)
    assert not projects.snapshot(main["id"])["bundle"]["documentation"]


def test_dirty_source_destination_and_invalid_combination_are_rejected(project):
    projects, main = project
    feature = projects.branch(main["id"], "feature")
    edit(projects, feature, lambda b: b["documentation"].update(project="Ready"))
    review = projects.versioning.prepare(main["id"], "refs/heads/feature")
    Path(feature["path"], "README.md").write_text("Still editing")
    with pytest.raises(Problem, match="Pending external"):
        apply(projects, review)
    assert projects.git(main["path"], "rev-parse", "HEAD") == review["target_head"]
    projects.flush(feature["id"])

    def remove_total(b):
        b["flow"]["nodes"].pop()
        b["flow"]["edges"].pop()

    def add_dependent(b):
        b["flow"]["nodes"].append({"id": "copy", "template": "filter", "params": {}})
        b["flow"]["edges"].append(
            {
                "id": "c",
                "source": "total",
                "sourceHandle": "result",
                "target": "copy",
                "targetHandle": "source",
            }
        )

    edit(projects, main, remove_total)
    edit(projects, feature, add_dependent)
    invalid = projects.versioning.prepare(main["id"], "refs/heads/feature")
    assert invalid["diagnostics"]
    with pytest.raises(Problem, match="validation errors"):
        apply(projects, invalid)


def test_history_pagination_real_merge_parents_and_element_filter(project):
    projects, main = project
    feature = projects.branch(main["id"], "feature")
    edit(projects, feature, lambda b: b["documentation"].update(project="Incoming"))
    edit(projects, main, lambda b: b["flow"]["nodes"][1].update(label="Paid"))
    review = projects.versioning.prepare(main["id"], "refs/heads/feature")
    merged = apply(projects, review)
    record = projects.versioning.history(main["id"], limit=1)
    assert record["items"][0]["parents"] == [review["target_head"], review["source_head"]]
    for index in range(101):
        projects.git(main["path"], "commit", "--allow-empty", "-m", f"chore: checkpoint {index}")
    first = projects.versioning.history(main["id"], limit=100)
    second = projects.versioning.history(main["id"], ref=first["head"], offset=first["next"], limit=100)
    assert len(first["items"]) == 100 and len(second["items"]) == 5
    assert not {c["commit"] for c in first["items"]} & {c["commit"] for c in second["items"]}
    node_history = projects.versioning.history(main["id"], ref=merged["commit"], entity="node/filter")
    assert any(c["commit"] == review["target_head"] for c in node_history["items"])


def test_non_main_destination_and_protected_cleanup(project):
    projects, main = project
    feature = projects.branch(main["id"], "feature")
    target = projects.branch(main["id"], "release")
    edit(projects, feature, lambda b: b["documentation"].update(project="Ready"))
    review = projects.versioning.prepare(target["id"], "refs/heads/feature")
    apply(projects, review)
    for remove in (main, target):
        with pytest.raises(Problem, match="protected"):
            projects.versioning.cleanup(main["id"], remove["id"], target["id"], review["source_head"])
    projects.versioning.cleanup(main["id"], feature["id"], target["id"], review["source_head"])
    assert not Path(feature["path"]).exists()
    assert projects.store.get("worktree", feature["id"]) is None


@pytest.mark.parametrize("execute", [False, True])
def test_cleanup_releases_engine_contexts_and_catalog_remains_writable(tmp_path, execute):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        services = app.state.services
        projects, engine = services.projects, services.engine
        main = client.post("/api/projects", json={"name": "Cleanup"}).json()
        edit(projects, main, lambda b: b.update(bundle()))
        feature = projects.branch(main["id"], "feature")
        for environment in ("dev", "prod"):
            response = client.get(f"/api/worktrees/{feature['id']}/status?environment={environment}")
            assert response.status_code == 200
        if execute:
            run = engine.launch(feature["id"], "dev")
            assert engine.wait(run["id"])["status"] == "success"
        contexts = [context for context in engine.contexts.values() if context.worktree == feature["id"]]
        database = engine.context(feature["id"], "dev").db
        retained = engine.context(main["id"], "dev")
        edit(projects, feature, lambda b: b["documentation"].update(project="Ready"))
        review = projects.versioning.prepare(main["id"], "refs/heads/feature")
        apply(projects, review)
        cleanup = {
            "remove_worktree": feature["id"],
            "integrated_worktree": main["id"],
            "expected_head": review["source_head"],
        }
        # A rejected cleanup must preserve its contexts and any running SQL worker.
        response = client.post(
            f"/api/worktrees/{main['id']}/git/cleanup", json={**cleanup, "expected_head": "outdated"}
        )
        assert response.status_code == 409
        assert all(engine.contexts[(c.worktree, c.environment)] is c for c in contexts)
        if database:
            assert database.process.poll() is None
            canceled = threading.Event()
            cursor = Mock(wraps=database.cursor())
            engine.context(feature["id"], "dev").lineage["pending"] = {
                "nodes": {"total"},
                "canceled": canceled,
                "cursor": cursor,
            }
        engine.active[feature["id"]] = {"id": "pending"}
        try:
            response = client.post(f"/api/worktrees/{main['id']}/git/cleanup", json=cleanup)
            assert response.status_code == 409
            assert all(engine.contexts[(c.worktree, c.environment)] is c for c in contexts)
        finally:
            engine.active.pop(feature["id"])
        response = client.post(f"/api/worktrees/{main['id']}/git/cleanup", json=cleanup)
        assert response.status_code == 200, response.text
        assert not any(c.worktree == feature["id"] for c in engine.contexts.values())
        assert engine.context(main["id"], "dev") is retained
        if database:
            assert canceled.is_set()
            cursor.interrupt.assert_called_once_with()
            assert database.closed
            assert database.process.poll() is not None
        assert client.get(f"/api/worktrees/{feature['id']}/status?environment=dev").status_code == 404
        response = client.put(
            "/api/catalog/connector", json={"id": "cleanup_test", "name": "Cleanup test", "init_sql": ""}
        )
        assert response.status_code == 200, response.text
        assert services.store.get("connector", "cleanup_test")["name"] == "Cleanup test"
        assert client.delete("/api/catalog/connector/cleanup_test").status_code == 200
        assert services.store.get("connector", "cleanup_test") is None


@pytest.mark.parametrize("operation", ["save", "delete"])
def test_catalog_invalidation_discards_orphaned_worktree_contexts(project, services, operation):
    projects, main = project
    store, _, catalog, engine = services
    connector = {"id": "cleanup_test", "name": "Cleanup test", "init_sql": ""}
    catalog.save("connector", connector)
    feature = projects.branch(main["id"], "feature")
    engine.statuses(feature["id"], "dev")
    context = engine.context(feature["id"], "dev")
    edit(projects, feature, lambda b: b["documentation"].update(project="Ready"))
    review = projects.versioning.prepare(main["id"], "refs/heads/feature")
    apply(projects, review)
    # Bypass the HTTP cleanup hook to exercise defensive invalidation of an orphan.
    projects.versioning.cleanup(main["id"], feature["id"], main["id"], review["source_head"])
    engine.reset_catalog()
    if operation == "save":
        catalog.save("connector", {**connector, "name": "Updated"})
        assert store.get("connector", "cleanup_test")["name"] == "Updated"
    else:
        catalog.delete("connector", "cleanup_test")
        assert store.get("connector", "cleanup_test") is None
    assert not any(c.worktree == feature["id"] for c in engine.contexts.values())
    with pytest.raises(duckdb.ConnectionException, match="closed"):
        context.db.execute("SELECT 1")


@pytest.mark.parametrize(
    "url",
    [
        "https://user:secret@example.com/repo.git",
        "https://token@example.com/repo.git",
        "https://example.com/repo?token=secret",
        "ssh://git:secret@example.com/repo",
        "file:///tmp/repo",
        "ext::command",
        "-oops",
        "git@example.com:repo;evil",
        "https://example.com/repo#token",
    ],
)
def test_remote_urls_reject_credentials_and_unsafe_transports(url):
    with pytest.raises(Problem, match="credential-free") as caught:
        validate_url(url)
    assert url not in str(caught.value)


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/team/repo.git",
        "ssh://git@example.com:2222/team/repo.git",
        "git@example.com:team/repo.git",
    ],
)
def test_remote_urls_allow_https_and_ssh(url):
    assert validate_url(url) == url


@pytest.fixture
def local_remote(project, tmp_path, monkeypatch):
    projects, main = project
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(remote)], check=True, capture_output=True)
    url = "https://example.invalid/project.git"
    projects.remotes.credentials.save_hosts("", ["https://example.invalid/"])

    def network(path, *args, key=None):
        assert key is None
        argv = [str(remote) if arg == url else arg for arg in args]
        result = subprocess.run(["git", "-C", str(path), *argv], capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise Problem("Remote changed or rejected the push; fetch again", 409)
        return result.stdout.strip()

    monkeypatch.setattr(projects.remotes, "network", network)
    status = projects.remotes.status(main["id"])
    status = projects.remotes.configure(main["id"], url, "main", status["config_revision"])
    return projects, main, remote, status


def push(projects, main, state, **kwargs):
    return projects.remotes.push(
        main["id"], state["config_revision"], state["local_head"], state["remote_head"], **kwargs
    )


def test_fetch_first_publication_incoming_pull_and_push(local_remote):
    projects, main, remote, state = local_remote
    state = projects.remotes.fetch(main["id"], state["config_revision"])
    assert state["state"] == "new_remote_branch"
    state = push(projects, main, state)
    assert state["state"] == "up_to_date"
    incoming = projects.branch(main["id"], "incoming")
    edit(projects, incoming, lambda b: b["documentation"].update(project="Remote documentation"))
    projects.git(incoming["path"], "push", str(remote), "HEAD:main")
    old_files = projects.read_files(main)
    state = projects.remotes.fetch(main["id"], state["config_revision"])
    assert state["state"] == "behind" and state["behind"] == 1
    assert projects.read_files(main) == old_files
    review = projects.remotes.pull(
        main["id"], state["config_revision"], state["local_head"], state["remote_head"]
    )
    apply(projects, review)
    remote_before_push = projects.git(remote, "rev-parse", "main")
    assert remote_before_push == review["source_head"]
    state = push(projects, main, projects.remotes.status(main["id"]))
    assert state["state"] == "up_to_date"
    assert projects.git(remote, "rev-parse", "main") != remote_before_push
    assert projects.snapshot(main["id"])["bundle"]["documentation"]["project"] == "Remote documentation"


def test_remote_divergence_race_dirty_state_and_configuration_changes(local_remote, monkeypatch):
    projects, main, remote, state = local_remote
    state = push(projects, main, projects.remotes.fetch(main["id"], state["config_revision"]))
    other = projects.branch(main["id"], "other")
    edit(projects, other, lambda b: b["documentation"].update(project="Other"))
    edit(projects, main, lambda b: b["flow"]["nodes"][1].update(label="Local"))
    projects.git(other["path"], "push", str(remote), "HEAD:main")
    with pytest.raises(Problem, match="Remote head changed"):
        push(projects, main, projects.remotes.status(main["id"]))
    state = projects.remotes.fetch(main["id"], state["config_revision"])
    assert state["state"] == "diverged" and state["ahead"] == state["behind"] == 1
    with pytest.raises(Problem, match="requires integration"):
        push(projects, main, state)
    review = projects.remotes.pull(
        main["id"], state["config_revision"], state["local_head"], state["remote_head"]
    )
    updated = projects.remotes.configure(main["id"], state["url"], "renamed", state["config_revision"])
    with pytest.raises(Problem, match="configuration"):
        apply(projects, review)
    with pytest.raises(Problem, match="configuration"):
        push(projects, main, state)
    state = projects.remotes.configure(main["id"], state["url"], "main", updated["config_revision"])
    apply(
        projects,
        projects.remotes.pull(
            main["id"], state["config_revision"], state["local_head"], state["remote_head"]
        ),
    )
    state = projects.remotes.status(main["id"])
    network = projects.remotes.network

    # Advance between ls-remote and receive-pack: the exact-head lease must reject it.
    def race(path, *args, key=None):
        if args[0] == "push":
            edit(projects, other, lambda b: b["documentation"].update(project="Concurrent remote"))
            projects.git(other["path"], "push", str(remote), "HEAD:main")
        return network(path, *args, key=key)

    monkeypatch.setattr(projects.remotes, "network", race)
    with pytest.raises(Problem, match="rejected"):
        push(projects, main, state)
    assert projects.git(remote, "rev-parse", "main") == projects.git(other["path"], "rev-parse", "HEAD")
    Path(main["path"], "README.md").write_text("Unsaved")
    with pytest.raises(Problem, match="Pending external"):
        push(projects, main, state)


def test_remote_deletion_recreation_invalid_imports_and_unrelated_history(local_remote):
    projects, main, remote, state = local_remote
    state = push(projects, main, projects.remotes.fetch(main["id"], state["config_revision"]))
    projects.git(remote, "update-ref", "-d", "refs/heads/main")
    state = projects.remotes.fetch(main["id"], state["config_revision"])
    assert state["state"] == "remote_deleted"
    with pytest.raises(Problem, match="deleted"):
        push(projects, main, state)
    state = push(projects, main, state, recreate=True)
    other = projects.branch(main["id"], "invalid")
    Path(other["path"], "flow.json").write_text("{")
    projects.flush(other["id"])
    projects.git(other["path"], "push", str(remote), "HEAD:main")
    state = projects.remotes.fetch(main["id"], state["config_revision"])
    with pytest.raises(Problem, match="invalid"):
        projects.remotes.pull(main["id"], state["config_revision"], state["local_head"], state["remote_head"])
    assert projects.snapshot(main["id"])["bundle"] is not None
    unrelated = projects.create("Unrelated", bundle())
    projects.git(unrelated["path"], "push", str(remote), "HEAD:unrelated")
    state = projects.remotes.configure(main["id"], state["url"], "unrelated", state["config_revision"])
    state = projects.remotes.fetch(main["id"], state["config_revision"])
    assert state["state"] == "unrelated"
    with pytest.raises(Problem, match="Unrelated"):
        projects.remotes.pull(main["id"], state["config_revision"], state["local_head"], state["remote_head"])


def test_unsupported_files_in_ancestry_are_never_synchronized(local_remote):
    projects, main, _, state = local_remote
    Path(main["path"], "secret.txt").write_text("private")
    projects.git(main["path"], "add", "secret.txt")
    projects.git(main["path"], "commit", "-m", "chore: accidental file")
    projects.git(main["path"], "rm", "secret.txt")
    projects.git(main["path"], "commit", "-m", "chore: remove accidental file")
    state = projects.remotes.fetch(main["id"], state["config_revision"])
    # Repeat to ensure a failed history validation cannot poison the safe-head cache.
    for _ in range(2):
        with pytest.raises(Problem, match="unsupported files"):
            push(projects, main, state)


def test_commit_comparison_shows_only_project_definitions(project):
    projects, main = project
    template = Path(main["path"], "templates", "orders.sql")
    template.write_text(template.read_text().replace("SELECT 1 AS amount", "SELECT 2 AS amount"))
    Path(main["path"], "secret.txt").write_text("private value")
    projects.git(main["path"], "add", "secret.txt", "templates/orders.sql")
    projects.git(main["path"], "commit", "-m", "chore: external commit")
    comparison = projects.versioning.compare(main["id"], "HEAD~1", "HEAD")
    assert comparison["b"]["message"] == "chore: external commit"
    assert "SELECT 2 AS amount" in json.dumps(comparison["entities"])
    assert "secret.txt" not in json.dumps(comparison) and "private value" not in json.dumps(comparison)
    Path(main["path"], "secret.txt").write_text("another private value")
    projects.git(main["path"], "commit", "-am", "chore: change only an external file")
    comparison = projects.versioning.compare(main["id"], "HEAD~1", "HEAD")
    assert comparison["b"]["message"] == "chore: change only an external file"
    assert not comparison["counts"].get("modified") and "private value" not in json.dumps(comparison)


def test_network_errors_never_echo_authentication_material(project, monkeypatch):
    projects, main = project

    def failure(*args, **kwargs):
        return subprocess.CompletedProcess(
            args[0], 128, "", "Authentication failed https://user:secret@example.com/repo"
        )

    monkeypatch.setattr(subprocess, "run", failure)
    with pytest.raises(Problem, match="requires authentication") as caught:
        projects.remotes.network(main["path"], "ls-remote", "https://example.com/repo")
    assert "secret" not in str(caught.value)
    with pytest.raises(Problem, match="authentication failed") as caught:
        projects.remotes.network(main["path"], "ls-remote", "git@example.com:repo", key="private")
    assert "secret" not in str(caught.value)

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 30)

    monkeypatch.setattr(subprocess, "run", timeout)
    with pytest.raises(Problem, match="timed out"):
        projects.remotes.network(main["path"], "fetch", "https://example.com/repo")


def test_integration_locks_both_reviewed_heads_during_checkout(project, monkeypatch):
    projects, main = project
    feature = projects.branch(main["id"], "feature")
    edit(projects, feature, lambda b: b["documentation"].update(project="Reviewed"))
    review = projects.versioning.prepare(main["id"], "refs/heads/feature")
    run = projects.versioning.run
    attempts = []

    def concurrent(path, *args, **kwargs):
        if args[:3] == ("read-tree", "-m", "-u"):
            for ref in ("main", "feature"):
                result = subprocess.run(
                    ["git", "-C", path, "update-ref", "refs/heads/" + ref, review["source_head"]],
                    capture_output=True,
                )
                attempts.append(result.returncode)
        return run(path, *args, **kwargs)

    monkeypatch.setattr(projects.versioning, "run", concurrent)
    merged = apply(projects, review)
    assert len(attempts) == 2 and all(attempts)
    assert merged["bundle"]["documentation"]["project"] == "Reviewed"
