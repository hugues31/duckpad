"""Shared result views in views.json: validation, saves, merges, comparisons and archives."""

import copy
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient
from helpers import example_bundle, join_run

from duckpad.app import create_app
from duckpad.bundle import bundle_to_files, files_to_bundle, validate
from duckpad.comparison import commit_message, compare_files
from duckpad.components import group
from duckpad.merge import merge_files

PARTNERS = {
    "name": "Partner orders above 300",
    "rows": 100,
    "method": "first",
    "filter": "channel = 'Partner' AND amount > 300",
    "order": [["amount", "desc"]],
}
LARGE = {"name": "Large orders", "filter": "amount > 450"}


def project(tmp_path, views=None):
    bundle = example_bundle(tmp_path / "input.csv")
    if views is not None:
        bundle["views"] = views
    return bundle


def problems(bundle):
    return [item["message"] for item in validate(bundle) if item["file"] == "views.json"]


def test_views_round_trip_and_never_make_results_stale(services, tmp_path):
    store, projects, _, engine = services
    worktree = projects.create("Views", project(tmp_path))["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    snapshot = projects.snapshot(worktree)
    assert snapshot["bundle"]["views"] is None
    snapshot["bundle"]["views"] = {"filter:result": [PARTNERS, LARGE]}
    saved = projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert json.loads(saved["files"]["views.json"]) == {"filter:result": [PARTNERS, LARGE]}
    assert saved["bundle"]["views"]["filter:result"][1] == LARGE
    assert not saved["diagnostics"]
    assert engine.preview(worktree, "dev", "filter")["status"] == "valid"
    message = projects.versioning.history(worktree, limit=1)["items"][0]["message"]
    assert message.startswith("docs(project): update 2 elements (2 view)")


@pytest.mark.parametrize(
    ("views", "message"),
    [
        ([], "object of views"),
        ({"filter": []}, "node:port"),
        ({"filter:result": {}}, "must be a list"),
        ({"filter:result": ["x"]}, "must be an object"),
        ({"filter:result": [{"name": ""}]}, "needs a name"),
        ({"filter:result": [{"name": "a", "color": "red"}]}, "unknown fields: color"),
        ({"filter:result": [{"name": "a", "method": "last"}]}, "first or random"),
        ({"filter:result": [{"name": "a", "rows": 0}]}, "between 1 and"),
        ({"filter:result": [{"name": "a", "rows": True}]}, "between 1 and"),
        ({"filter:result": [{"name": "a", "seed": -1}]}, "positive integer seed"),
        ({"filter:result": [{"name": "a", "filter": 3}]}, "must be text"),
        ({"filter:result": [{"name": "a", "order": [["amount", "up"]]}]}, "asc or desc"),
        ({"filter:result": [{"name": "a", "order": [["x", "asc"], ["x", "desc"]]}]}, "each column once"),
        ({"filter:result": [{"name": "a"}, {"name": "a"}]}, "distinct names"),
        ("{", "not valid JSON"),
    ],
)
def test_invalid_views_are_reported_on_the_file(tmp_path, views, message):
    [problem] = problems(project(tmp_path, views))
    assert message in problem


def test_views_of_nested_nodes_are_valid(tmp_path):
    assert problems(project(tmp_path, {"instance::inner:result": [LARGE]})) == []


def test_views_merge_view_by_view(tmp_path):
    base = bundle_to_files(project(tmp_path, {"filter:result": [PARTNERS]}))

    def edited(change):
        bundle = files_to_bundle(base)
        change(bundle["views"])
        return bundle_to_files(bundle)

    current = edited(lambda views: views["filter:result"].append(LARGE))
    proposal = edited(lambda views: views["filter:result"][0].update(rows=50))
    merged, conflicts = merge_files(base, current, proposal)
    assert conflicts == []
    assert json.loads(merged["views.json"]) == {"filter:result": [{**PARTNERS, "rows": 50}, LARGE]}
    other = edited(lambda views: views["filter:result"][0].update(rows=10))
    assert merge_files(base, proposal, other)[1] == ["views.json/filter:result/Partner orders above 300/rows"]
    # Branches that both create the file merge their views.
    empty = bundle_to_files(project(tmp_path))
    first = {**empty, "views.json": json.dumps({"filter:result": [LARGE]})}
    second = {**empty, "views.json": json.dumps({"total:result": [PARTNERS]})}
    merged, conflicts = merge_files(empty, first, second)
    assert conflicts == []
    assert json.loads(merged["views.json"]) == {"filter:result": [LARGE], "total:result": [PARTNERS]}


def test_compare_lists_views_as_display_changes(tmp_path):
    before = bundle_to_files(project(tmp_path, {"filter:result": [PARTNERS]}))
    changed = files_to_bundle(before)
    changed["views"]["filter:result"][0]["filter"] = "amount > 400"
    after = bundle_to_files(changed)
    report = compare_files(before, after)
    [change] = [c for c in report["entities"] if c["status"] != "unchanged"]
    assert {k: change[k] for k in ("id", "kind", "file", "fields", "categories")} == {
        "id": "view/filter:result/Partner orders above 300",
        "kind": "view",
        "file": "views.json",
        "fields": ["filter"],
        "categories": ["documentation"],
    }
    assert report["impact"]["direct"] == []
    assert commit_message(before, after).startswith("docs(view): update Partner orders above 300")
    broken = compare_files(before, {**before, "views.json": "[]"})
    assert [c["id"] for c in broken["entities"] if c["status"] != "unchanged"] == [
        "file/views.json",
        "view/filter:result/Partner orders above 300",
    ]


def test_deleting_a_node_deletes_its_views_in_the_same_save(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create(
        "Views", project(tmp_path, {"filter:result": [LARGE], "total:result": [PARTNERS]})
    )
    snapshot = projects.snapshot(worktree["id"])
    bundle = copy.deepcopy(snapshot["bundle"])
    bundle["flow"]["nodes"] = [n for n in bundle["flow"]["nodes"] if n["id"] != "total"]
    bundle["flow"]["edges"] = [e for e in bundle["flow"]["edges"] if e["target"] != "total"]
    saved = projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    assert saved["bundle"]["views"] == {"filter:result": [LARGE]}
    committed = projects.revision_files(worktree["path"], "HEAD")
    assert json.loads(committed["views.json"]) == {"filter:result": [LARGE]}


def test_grouping_nodes_keeps_their_views(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create(
        "Views", project(tmp_path, {"filter:result": [LARGE], "total:result": [PARTNERS]})
    )
    snapshot = projects.snapshot(worktree["id"])
    grouped, instance = group(snapshot["bundle"], ["filter"], "Qualifying orders")
    saved = projects.write(worktree["id"], snapshot["revision"], bundle_to_files(grouped))
    assert saved["bundle"]["views"] == {instance + "::filter:result": [LARGE], "total:result": [PARTNERS]}


def test_views_travel_in_project_archives(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert (
            client.post("/api/login", json={"password": app.state.auth.initial_password}).status_code == 200
        )
        worktree = client.post("/api/projects", json={"name": "Views"}).json()
        snapshot = client.get(f"/api/worktrees/{worktree['id']}").json()
        bundle = {**snapshot["bundle"], "views": {"orders:result": [LARGE]}}
        saved = client.put(
            f"/api/worktrees/{worktree['id']}", json={"revision": snapshot["revision"], "bundle": bundle}
        )
        assert saved.status_code == 200, saved.text
        archive = client.get(f"/api/worktrees/{worktree['id']}/archive.zip")
        with zipfile.ZipFile(io.BytesIO(archive.content)) as content:
            assert json.loads(content.read("views.json")) == {"orders:result": [LARGE]}
        imported = client.post(
            "/api/projects/import", files={"file": ("project.zip", archive.content, "application/zip")}
        )
        assert imported.status_code == 200, imported.text
        copy_id = imported.json()["id"]
        assert client.get(f"/api/worktrees/{copy_id}").json()["bundle"]["views"] == {"orders:result": [LARGE]}


def test_invalid_views_do_not_block_saving_other_files(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create("Views", project(tmp_path))
    snapshot = projects.snapshot(worktree["id"])
    files = {**bundle_to_files(snapshot["bundle"]), "views.json": "{"}
    saved = projects.write(worktree["id"], snapshot["revision"], files)
    assert saved["bundle"]["views"] == "{"
    assert any(d["file"] == "views.json" for d in saved["diagnostics"])
