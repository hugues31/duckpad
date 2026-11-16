import copy
import json

import pytest
from helpers import example_bundle

from duckpad.merge import conflict_details
from duckpad.util import Problem


def test_review_scopes_evidence_and_prefills_a_merge_without_mutating_retained_versions(services, tmp_path):
    store, projects, _, _ = services
    tree = projects.create("Conflict review", example_bundle(tmp_path / "input.csv"))
    base = projects.snapshot(tree["id"])
    current = {**base["files"], "README.md": "Saved documentation", "templates/review.sql": "SELECT 2;"}
    projects.write(tree["id"], base["revision"], current)
    proposal = {
        **base["files"],
        "templates/review.sql": "SELECT 3;",
        "documentation.json": '{"project":"Incoming documentation"}',
    }
    with pytest.raises(Problem, match="Concurrent edits"):
        projects.write(tree["id"], base["revision"], proposal)
    retained = copy.deepcopy(store.conflicts(tree["id"])[0])
    review = projects.snapshot(tree["id"])["conflicts"][0]
    assert [field["path"] for field in review["fields"]] == ["templates/review.sql"]
    assert review["fields"][0]["base"] == {"present": False, "value": None}
    assert review["merged"]["templates/review.sql"] == "SELECT 3;"
    assert review["merged"]["README.md"] == "Saved documentation"
    assert json.loads(review["merged"]["documentation.json"])["project"] == "Incoming documentation"
    assert store.conflicts(tree["id"])[0] == retained
    combined = {**review["merged"], "templates/review.sql": "SELECT 4;"}
    resolved = projects.resolve(review["id"], "combined", combined)
    assert resolved["files"]["templates/review.sql"] == "SELECT 4;"
    assert resolved["files"]["README.md"] == "Saved documentation"
    assert not resolved["conflicts"]


def test_review_uses_semantic_fields_including_deletions_and_escaped_names():
    def files(value):
        return {"flow.json": json.dumps({"nodes": [{"id": "filter", "params": value}]})}

    review = conflict_details(
        {
            "base": files({"a/b": "base", "threshold": 1}),
            "current": files({"a/b": "saved", "threshold": 2}),
            "proposal": files({"threshold": 3}),
            "paths": ["flow.json/nodes/filter/params/a~1b", "flow.json/nodes/filter/params/threshold"],
        }
    )
    assert len(review["fields"]) == 2
    assert review["fields"][0]["incoming"] == {"present": False, "value": None}
    assert review["fields"][1]["base"]["value"] == 1
    assert json.loads(review["merged"]["flow.json"])["nodes"][0]["params"] == {"threshold": 3}
