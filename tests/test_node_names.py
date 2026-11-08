"""Every user-facing node reference uses its caption, including historical and invalid graphs."""

import copy

import pytest
from helpers import join_run

from duckpad.builtin_templates import BUILTINS
from duckpad.bundle import bundle_to_files, file_node_names
from duckpad.comparison import commit_message
from duckpad.components import expand, group
from duckpad.node_names import node_name, node_names
from duckpad.util import Problem
from duckpad.validation import validate
from duckpad.variables import usages


@pytest.fixture
def named_bundle():
    return {
        "flow": {
            "nodes": [
                {"id": "node_source", "params": {}, "position": {"x": 0, "y": 0}},
                {
                    "id": "node_filter",
                    "template": "filter",
                    "params": {"condition": "amount > {{ var.minimum }}"},
                    "position": {"x": 200, "y": 0},
                },
            ],
            "edges": [],
        },
        "node_sql": {
            "nodes/node_source.sql": "-- @label Revenue report\n-- @output result\nSELECT 42 AS amount;"
        },
        "templates": {"filter": BUILTINS["filter"]},
        "components": {},
        "documentation": {},
        "variables": {"minimum": {"type": "number", "default": 0}},
    }


def test_names_and_diagnostics_do_not_require_an_explicit_label(named_bundle, services):
    store, projects, _, engine = services
    assert node_name(named_bundle, "node_source") == "Revenue report"
    assert node_name(named_bundle, "node_filter") == "Filter"
    assert usages(named_bundle)["minimum"][0]["label"] == "Filter"
    assert validate(named_bundle) == [
        {
            "file": "flow.json",
            "node": "node_filter",
            "code": "missing_input",
            "port": "source",
            "message": "Connect input 'source' on Filter",
        }
    ]
    worktree = projects.create("Display names", named_bundle)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    scoped = join_run(store, engine.launch(worktree, "dev", "node_source")["id"])
    assert scoped["scope_name"] == [{"label": "Revenue report", "template": "sql"}]
    assert run["nodes"]["node_filter"]["error"] == "Connect input source on Filter"
    assert run["nodes"]["node_filter"]["label"] == "Filter"
    with pytest.raises(Problem, match="Connect input 'source' on Filter"):
        engine.launch(worktree, "dev", "node_filter", entry_point="ui")
    assert projects.snapshot(worktree)["node_names"]["node_source"] == [
        {"label": "Revenue report", "template": "sql"}
    ]
    named_bundle["node_sql"]["nodes/node_source.sql"] = (
        "-- @label Revenue report\n-- @input source\n-- @output result\nSELECT * FROM {{ source }};"
    )
    assert expand(named_bundle, tolerant=True)[0]["node_source"]["error"] == (
        "Connect input source on Revenue report"
    )


def test_ui_run_reports_missing_inputs_only_in_its_scope(named_bundle, services):
    store, projects, _, engine = services
    worktree = projects.create("Incomplete pipeline", named_bundle)["id"]
    scoped = join_run(store, engine.launch(worktree, "dev", "node_source", entry_point="ui")["id"])
    assert scoped["status"] == "success"
    for target in (None, "node_filter"):
        with pytest.raises(Problem) as rejected:
            engine.launch(worktree, "dev", target, entry_point="ui")
        assert rejected.value.detail == validate(named_bundle)
        assert rejected.value.detail[0]["code"] == "missing_input"
        assert rejected.value.detail[0]["port"] == "source"
    named_bundle["flow"]["edges"] = [
        {
            "id": "input",
            "source": "node_source",
            "sourceHandle": "result",
            "target": "node_filter",
            "targetHandle": "source",
        }
    ]
    connected = projects.create("Connected pipeline", named_bundle)["id"]
    assert join_run(store, engine.launch(connected, "dev", entry_point="ui")["id"])["status"] == "success"


def test_missing_component_input_is_reported_on_its_instance(named_bundle, services):
    store, projects, _, engine = services
    named_bundle["flow"]["nodes"] = [
        {"id": "outer", "component": "wrapper", "params": {}, "position": {"x": 0, "y": 0}}
    ]
    named_bundle["node_sql"] = {
        "components/branch/other.sql": "-- @label Constant\n-- @output result\nSELECT 1 AS amount;"
    }
    named_bundle["components"] = {
        "branch": {
            "name": "Branch",
            "nodes": [
                {"id": "inner", "template": "filter", "params": {"condition": "amount > 0"}},
                {"id": "other", "params": {}},
            ],
            "edges": [],
            "inputs": {"rows": {"node": "inner", "port": "source"}},
            "outputs": {},
        },
        # Nested exposure: the outermost instance is where the input is connected.
        "wrapper": {
            "name": "Wrapper",
            "nodes": [{"id": "middle", "component": "branch", "params": {}}],
            "edges": [],
            "inputs": {"orders": {"node": "middle", "port": "rows"}},
            "outputs": {},
        },
    }
    assert validate(named_bundle) == [
        {
            "file": "flow.json",
            "node": "outer",
            "code": "missing_input",
            "port": "orders",
            "message": "Connect input 'orders' on Wrapper",
        }
    ]
    worktree = projects.create("Component input", named_bundle)["id"]
    unrelated = engine.launch(worktree, "dev", "outer::middle::other", entry_point="ui")
    assert join_run(store, unrelated["id"])["status"] == "success"
    for target in (None, "outer::middle::inner"):
        with pytest.raises(Problem, match="Connect input 'orders' on Wrapper"):
            engine.launch(worktree, "dev", target, entry_point="ui")


def test_commit_messages_name_added_removed_and_connected_nodes(named_bundle):
    before = copy.deepcopy(named_bundle)
    before["flow"]["nodes"] = []
    for node in named_bundle["flow"]["nodes"]:
        after = copy.deepcopy(before)
        after["flow"]["nodes"] = [node]
        name = node_name(named_bundle, node["id"])
        assert commit_message(bundle_to_files(before), bundle_to_files(after)).startswith(
            f"feat(node): add {name}\n"
        )
        assert commit_message(bundle_to_files(after), bundle_to_files(before)).startswith(
            f"feat(node): remove {name}\n"
        )
    before = bundle_to_files(named_bundle)
    named_bundle["flow"]["edges"] = [
        {
            "id": "edge_1",
            "source": "node_source",
            "sourceHandle": "result",
            "target": "node_filter",
            "targetHandle": "source",
        }
    ]
    assert commit_message(before, bundle_to_files(named_bundle)).startswith(
        "feat(flow): connect Revenue report → Filter\n"
    )


def test_nested_names_and_removed_conflict_nodes(named_bundle):
    bundle, instance = group(named_bundle, ["node_source"], "Reporting")
    bundle, outer = group(bundle, [instance], "Finance")
    identity = f"{outer}::{instance}::node_source"
    parent = next(key for key, value in bundle["components"].items() if value["name"] == "Reporting")
    # Exposed parameters are applied while expanding and must not alter the names.
    bundle["components"][parent]["parameters"] = {
        "limit": {"type": "number", "default": 1, "targets": [{"node": "node_source", "param": "limit"}]}
    }
    assert node_name(bundle, identity) == "Finance / Reporting / Revenue report"
    assert expand(bundle)[0][identity]["display_name"] == "Finance / Reporting / Revenue report"
    names = node_names(bundle)
    assert [part["label"] for part in names[identity]] == ["Finance", "Reporting", "Revenue report"]
    assert node_name(bundle, "node_source", parent) == "Reporting / Revenue report"
    current = copy.deepcopy(named_bundle)
    current["flow"]["nodes"] = []
    assert "node_filter" in file_node_names(bundle_to_files(named_bundle), bundle_to_files(current))
    current["flow"]["nodes"] = [{"id": "node_filter", "label": "Saved filter"}]
    assert file_node_names(bundle_to_files(named_bundle), bundle_to_files(current))["node_filter"] == [
        {"label": "Saved filter"}
    ]


def test_names_survive_invalid_sql_and_recursive_components(named_bundle):
    named_bundle["node_sql"]["nodes/node_source.sql"] = "-- @label Revenue report\nBROKEN SQL"
    assert node_name(named_bundle, "node_source") == "Revenue report"
    named_bundle["flow"]["nodes"][0]["label"] = "Explicit name"
    assert node_name(named_bundle, "node_source") == "Explicit name"
    named_bundle["flow"]["nodes"].append({"id": "loop", "component": "loop"})
    named_bundle["components"]["loop"] = {"name": "Loop", "nodes": [{"id": "self", "component": "loop"}]}
    assert node_names(named_bundle)["loop::self"] == [{"label": "Loop"}, {"label": "Loop"}]
    assert node_names(None) == {}
