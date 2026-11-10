import copy

import pytest
from helpers import example_bundle, wait_run

from duckpad.bundle import bundle_to_files
from duckpad.components import expand, group
from duckpad.lineage import Lineage
from duckpad.project_schema import problems
from duckpad.util import Problem


def set_muted(projects, worktree, node, muted):
    snapshot = projects.snapshot(worktree)
    next(n for n in snapshot["bundle"]["flow"]["nodes"] if n["id"] == node)["muted"] = muted
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))


def test_mute_invalidates_results_passes_through_and_restores_code(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["flow"]["nodes"][1]["params"]["threshold"] = 15
    wt = projects.create("Mute", bundle)["id"]
    assert wait_run(store, engine.launch(wt, "dev", "total"))["status"] == "success"
    assert engine.preview(wt, "dev", "filter")["count"] == 2
    set_muted(projects, wt, "filter", True)
    assert engine.preview(wt, "dev", "filter")["status"] == "stale"
    assert engine.preview(wt, "dev", "total")["status"] == "stale"
    assert wait_run(store, engine.launch(wt, "dev", "total"))["status"] == "success"
    assert engine.preview(wt, "dev", "filter")["count"] == 3
    preview = engine.preview(wt, "dev", "filter")
    trace = Lineage(engine).explain(wt, "dev", preview["id"], 0, "amount")
    assert trace["complete"] and trace["total"] == 1
    assert engine.preview(wt, "dev", "total")["rows"][0]["values"] == ["North", 30, 2]
    saved = projects.snapshot(wt)["bundle"]
    assert saved["templates"] == bundle["templates"]
    assert saved["flow"]["edges"] == bundle["flow"]["edges"]
    set_muted(projects, wt, "filter", False)
    assert engine.preview(wt, "dev", "total")["status"] == "stale"
    assert wait_run(store, engine.launch(wt, "dev", "total"))["status"] == "success"
    assert engine.preview(wt, "dev", "filter")["count"] == 2


def test_muted_code_parameters_and_checks_do_not_execute(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["flow"]["nodes"][1]["muted"] = True
    bundle["templates"]["filter"] = """-- @input source
-- @param connection: connection
-- @param required: number
-- @output result
SELECT missing FROM {{ source }} WHERE amount > {{ required }};
-- @test never
SELECT error('must not run');
"""
    wt = projects.create("Skipped code", bundle)["id"]
    run = wait_run(store, engine.launch(wt, "dev", "total"))
    assert run["status"] == "success", run
    assert len(run["nodes"]["filter"]["statements"]) == 1
    assert engine.preview(wt, "dev", "filter")["count"] == 3


@pytest.mark.parametrize("component", [False, True])
def test_multiple_ports_route_in_order_and_fan_out(services, tmp_path, component):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["second"] = "-- @output result\nSELECT 99 AS amount;"
    bundle["templates"]["filter"] = """-- @input source
-- @input other
-- @output first
SELECT error('skipped');
-- @output second
SELECT error('skipped');
-- @output third
SELECT error('skipped');"""
    bundle["flow"]["nodes"].append({"id": "second", "template": "second"})
    bundle["flow"]["edges"].append(
        {"id": "c", "source": "second", "sourceHandle": "result", "target": "filter", "targetHandle": "other"}
    )
    bundle["flow"]["edges"][1]["sourceHandle"] = "first"
    target = "filter"
    ports = ["first", "second", "third"]
    if component:
        bundle, target = group(bundle, ["filter"], "Muted group")
        definition = next(n for n in bundle["flow"]["nodes"] if n["id"] == target)["component"]
        ports = list(bundle["components"][definition]["outputs"])
    next(n for n in bundle["flow"]["nodes"] if n["id"] == target)["muted"] = True
    wt = projects.create("Multiple ports", bundle)["id"]
    run = wait_run(store, engine.launch(wt, "dev", target))
    assert run["status"] == "success", run
    assert engine.preview(wt, "dev", target, ports[0])["count"] == 3
    assert engine.preview(wt, "dev", target, ports[1])["rows"][0]["values"] == [99]
    assert engine.preview(wt, "dev", target, ports[2])["count"] == 3
    assert not any(key.startswith(target + "::") for key in run["nodes"])


def test_mute_inside_nested_component_and_component_with_identical_port_names(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["flow"]["nodes"][1].update(muted=True, params={"threshold": 1000})
    bundle, target = group(bundle, ["filter"], "Inner")
    bundle, target = group(bundle, [target], "Outer")
    definition = next(n for n in bundle["flow"]["nodes"] if n["id"] == target)["component"]
    wt = projects.create("Nested mute", bundle)["id"]
    assert wait_run(store, engine.launch(wt, "dev", "total"))["status"] == "success"
    assert engine.preview(wt, "dev", "total")["rows"][0]["values"] == ["North", 30, 2]
    # Component inputs and outputs can share names, unlike SQL template ports.
    definition = bundle["components"][definition]
    definition["outputs"] = {"input_1": next(iter(definition["outputs"].values()))}
    bundle["flow"]["edges"][1]["sourceHandle"] = "input_1"
    next(n for n in bundle["flow"]["nodes"] if n["id"] == target)["muted"] = True
    wt = projects.create("Same port names", bundle)["id"]
    run = wait_run(store, engine.launch(wt, "dev", "total"))
    assert run["status"] == "success", run


def test_muted_export_does_not_write_or_require_unused_inputs(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    destination = tmp_path / "should-not-exist.csv"
    bundle["templates"]["export"] = (
        f"-- @input source\nCOPY (SELECT * FROM {{{{ source }}}}) TO '{destination}';"
    )
    bundle["flow"]["nodes"].append({"id": "export", "template": "export", "muted": True})
    wt = projects.create("Muted export", bundle)["id"]
    run = wait_run(store, engine.launch(wt, "dev", "export", entry_point="ui"))
    assert run["status"] == "success", run
    assert run["nodes"]["export"]["statements"] == []
    assert not destination.exists()


def test_unused_muted_input_does_not_block_a_target_run(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["filter"] = (
        "-- @input source\n-- @input unused\n-- @output result\nSELECT * FROM {{ source }};"
    )
    bundle["flow"]["nodes"][1]["muted"] = True
    wt = projects.create("Unused port", bundle)["id"]
    run = wait_run(store, engine.launch(wt, "dev", "total", entry_point="ui"))
    assert run["status"] == "success", run


def test_muted_python_needs_no_python_execution_permission(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    node = bundle["flow"]["nodes"][1]
    del node["template"]
    node.update(
        language="python",
        muted=True,
        python_contract={"inputs": ["source"], "outputs": ["result"], "parameters": []},
    )
    bundle["node_sql"] = {"nodes/filter.py": "raise RuntimeError('must not run')"}
    wt = projects.create("Muted Python", bundle)["id"]
    run = wait_run(store, engine.launch(wt, "dev", "total"))
    assert run["status"] == "success", run


def test_source_mute_is_rejected_and_state_must_be_boolean(tmp_path):
    bundle = example_bundle(tmp_path / "input.csv")
    original = copy.deepcopy(bundle)
    bundle["flow"]["nodes"][0]["muted"] = True
    with pytest.raises(Problem, match="Only nodes with inputs"):
        expand(bundle)
    assert expand(bundle, tolerant=True)[0]["source"]["error"]
    original["flow"]["nodes"][1]["muted"] = "false"
    assert problems(original)[0]["code"] == "project_structure"


def test_changing_mute_routes_invalidates_results(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["filter"] = (
        "-- @input source\n-- @input other\n-- @output result\nSELECT * FROM {{ source }};"
    )
    bundle["templates"]["other"] = "-- @output result\nSELECT 99 AS amount;"
    bundle["flow"]["nodes"][1]["muted"] = True
    bundle["flow"]["nodes"].append({"id": "other", "template": "other"})
    bundle["flow"]["edges"].append(
        {
            "id": "other",
            "source": "other",
            "sourceHandle": "result",
            "target": "filter",
            "targetHandle": "other",
        }
    )
    wt = projects.create("Route order", bundle)["id"]
    assert wait_run(store, engine.launch(wt, "dev", "filter"))["status"] == "success"
    snapshot = projects.snapshot(wt)
    snapshot["bundle"]["templates"]["filter"] = bundle["templates"]["filter"].replace(
        "-- @input source\n-- @input other", "-- @input other\n-- @input source"
    )
    projects.write(wt, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert engine.preview(wt, "dev", "filter")["status"] == "stale"
    assert wait_run(store, engine.launch(wt, "dev", "filter"))["status"] == "success"
    assert engine.preview(wt, "dev", "filter")["rows"][0]["values"] == [99]


def test_muting_keeps_documentation_of_temporarily_absent_columns(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["documentation"] = {"columns": {"total:result": {"total": "Regional revenue"}}}
    bundle["flow"]["nodes"][2]["muted"] = True
    wt = projects.create("Muted documentation", bundle)["id"]
    assert wait_run(store, engine.launch(wt, "dev", "total"))["status"] == "success"
    assert projects.snapshot(wt)["bundle"]["documentation"] == bundle["documentation"]
