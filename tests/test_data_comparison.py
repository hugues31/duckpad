import copy

import pytest
from helpers import join_run

from duckpad import data_comparison
from duckpad.bundle import bundle_to_files
from duckpad.git.workspace import origin_key
from duckpad.util import Problem


@pytest.fixture
def branches(services):
    store, projects, _, engine = services
    store.put("settings", "sql_resources", {"threads": 1})
    bundle = {
        "flow": {
            "name": "Rows",
            "nodes": [{"id": "rows", "template": "rows", "params": {}, "position": {"x": 0, "y": 0}}],
            "edges": [],
        },
        "templates": {
            "rows": "-- @output result\nSELECT * FROM (VALUES (1, 'old'), (2, 'same'), (3, 'removed')) t(id, value);"
        },
        "components": {},
        "documentation": {},
    }
    main = projects.create("Rows", bundle)
    run = engine.launch(main["id"], "dev")
    assert join_run(store, run["id"], timeout=120)["status"] == "success"
    feature = projects.branch(main["id"], "experiment/rows")
    changed = copy.deepcopy(bundle)
    changed["templates"]["rows"] = (
        "-- @output result\nSELECT * FROM (VALUES (1, 'new'), (2, 'same'), (4, 'added')) t(id, value);"
    )
    projects.write(feature["id"], projects.snapshot(feature["id"])["revision"], bundle_to_files(changed))
    run = engine.launch(feature["id"], "dev")
    assert join_run(store, run["id"], timeout=120)["status"] == "success"
    proposal = projects.versioning.prepare_origin(feature["id"])
    review = projects.versioning.review(main["id"], proposal["id"])
    return engine.results, review, feature, main


def compare(results, review, **overrides):
    pair = data_comparison.available_results(results, review, "dev")[0]
    return data_comparison.compare_result(
        results,
        review,
        "dev",
        pair["node"],
        pair["port"],
        pair["before"]["id"],
        pair["after"]["id"],
        **overrides,
    )


def test_rows_count_replacements_or_keyed_updates_without_execution(branches, services):
    results, review, _, _ = branches
    store, _, _, _ = services
    runs = store.all("run")
    unkeyed = compare(results, review)
    assert (unkeyed["added"], unkeyed["removed"], unkeyed["modified"]) == (2, 2, None)
    keyed = compare(results, review, key="id")
    assert (keyed["added"], keyed["removed"], keyed["modified"]) == (1, 1, 1)
    assert store.all("run") == runs


def test_missing_stale_and_replaced_results_are_not_comparable(branches):
    results, review, feature, _ = branches
    assert data_comparison.available_results(results, review, "prod") == []
    pair = data_comparison.available_results(results, review, "dev")[0]
    with pytest.raises(Problem, match="Results changed"):
        data_comparison.compare_result(
            results, review, "dev", "rows", "result", "old-generation", pair["after"]["id"]
        )
    context, dataset = results.find_dataset(feature["id"], "dev", "rows")
    dataset.status = "stale"
    assert data_comparison.available_results(results, review, "dev") == []
    dataset.status = "valid"
    dataset.incomplete = {"reason": "missing partitions"}
    assert data_comparison.available_results(results, review, "dev") == []
    assert not context.lineage


def test_key_validation_limits_and_column_changes(branches, monkeypatch):
    results, review, feature, _ = branches
    with pytest.raises(Problem, match="common column"):
        compare(results, review, key="missing")
    context, dataset = results.find_dataset(feature["id"], "dev", "rows")
    cursor = context.db.cursor()
    cursor.execute(f'UPDATE "{dataset.relation}" SET id = 1')
    cursor.close()
    with pytest.raises(Problem, match="duplicates"):
        compare(results, review, key="id")
    cursor = context.db.cursor()
    cursor.execute(f'UPDATE "{dataset.relation}" SET id = NULL')
    cursor.close()
    with pytest.raises(Problem, match="null values"):
        compare(results, review, key="id")
    monkeypatch.setattr(data_comparison, "MAX_ROWS", 2)
    with pytest.raises(Problem, match="up to 2 rows"):
        compare(results, review)
    dataset.columns = [{"name": "id", "type": "BIGINT"}, {"name": "extra", "type": "VARCHAR"}]
    pair = data_comparison.available_results(results, review, "dev")[0]
    assert pair["columns"]["added"] == ["extra"]
    assert pair["columns"]["removed"] == ["value"]
    with pytest.raises(Problem, match="Column types changed"):
        compare(results, review)


def test_only_processing_changes_of_the_source_branch_are_compared(branches, services):
    results, _, _, main = branches
    store, projects, _, engine = services
    moved = projects.branch(main["id"], "experiment/moved")
    snapshot = projects.snapshot(moved["id"])
    bundle = copy.deepcopy(snapshot["bundle"])
    bundle["flow"]["nodes"][0].update(position={"x": 300, "y": 40}, label="Renamed rows")
    projects.write(moved["id"], snapshot["revision"], bundle_to_files(bundle))
    run = engine.launch(moved["id"], "dev")
    assert join_run(store, run["id"], timeout=120)["status"] == "success"
    # The destination changes the node meanwhile: the merge keeps that change, not the branch's.
    snapshot = projects.snapshot(main["id"])
    bundle = copy.deepcopy(snapshot["bundle"])
    bundle["templates"]["rows"] = bundle["templates"]["rows"].replace("'same'", "'main'")
    projects.write(main["id"], snapshot["revision"], bundle_to_files(bundle))
    run = engine.launch(main["id"], "dev")
    assert join_run(store, run["id"], timeout=120)["status"] == "success"
    proposal = projects.versioning.prepare_origin(moved["id"])
    review = projects.versioning.review(main["id"], proposal["id"])
    assert data_comparison.available_results(results, review, "dev") == []


def test_origin_is_persistent_and_nested_branches_review_their_parent(branches, services):
    _, _, feature, main = branches
    _, projects, _, _ = services
    nested = projects.branch(feature["id"], "experiment/nested")
    proposal = projects.versioning.prepare_origin(nested["id"])
    assert proposal["worktree"] == feature["id"]
    assert proposal["source"] == nested["branch"]
    # An origin that exists without an open worktree must be opened first.
    projects.git(main["path"], "branch", "experiment/closed", "main")
    projects.git(main["path"], "config", origin_key(nested["branch"]), "experiment/closed")
    with pytest.raises(Problem, match="Open experiment/closed"):
        projects.versioning.prepare_origin(nested["id"])
    # A deleted origin, such as a parent merged and cleaned up, falls back to main.
    projects.git(main["path"], "config", origin_key(nested["branch"]), "missing")
    assert projects.versioning.prepare_origin(nested["id"])["worktree"] == main["id"]
    # Deleting a merged branch forgets its origin, so a branch reusing the name starts afresh.
    head = projects.git(nested["path"], "rev-parse", "HEAD")
    projects.versioning.cleanup(main["id"], nested["id"], feature["id"], head)
    assert not projects.git(main["path"], "config", "--get", origin_key(nested["branch"]), check=False)
