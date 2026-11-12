"""Charts follow their nodes into component instances and disappear with them."""

import copy
import json

from helpers import example_bundle

from duckpad.bundle import bundle_to_files
from duckpad.components import group

BARS = {"name": "Amount by channel", "spec": {"mark": "bar"}}
LINE = {"name": "Running total", "spec": {"mark": "line"}}


def create(projects, tmp_path, charts):
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["charts"] = charts
    worktree = projects.create("Charts", bundle)
    return worktree, projects.snapshot(worktree["id"])


def without(bundle, node):
    bundle = copy.deepcopy(bundle)
    bundle["flow"]["nodes"] = [n for n in bundle["flow"]["nodes"] if n["id"] != node]
    bundle["flow"]["edges"] = [e for e in bundle["flow"]["edges"] if node not in (e["source"], e["target"])]
    return bundle


def committed_charts(projects, worktree):
    return json.loads(projects.revision_files(worktree["path"], "HEAD")["charts.json"])


def test_grouping_a_charted_node_moves_its_chart_to_the_instance(services, tmp_path):
    _, projects, _, _ = services
    worktree, snapshot = create(projects, tmp_path, {"filter:result": [BARS], "total:result": [LINE]})
    grouped, instance = group(snapshot["bundle"], ["filter"], "Qualifying orders")
    saved = projects.write(worktree["id"], snapshot["revision"], bundle_to_files(grouped))
    expected = {instance + "::filter:result": [BARS], "total:result": [LINE]}
    assert saved["bundle"]["charts"] == expected
    assert committed_charts(projects, worktree) == expected
    [definition] = saved["bundle"]["components"].values()
    assert "charts" not in definition
    assert "charts" not in json.dumps(definition.get("documentation", {}))


def test_deleting_a_node_deletes_its_charts_in_the_same_save(services, tmp_path):
    _, projects, _, _ = services
    worktree, snapshot = create(projects, tmp_path, {"filter:result": [BARS], "total:result": [LINE]})
    saved = projects.write(
        worktree["id"], snapshot["revision"], bundle_to_files(without(snapshot["bundle"], "total"))
    )
    assert saved["bundle"]["charts"] == {"filter:result": [BARS]}
    assert committed_charts(projects, worktree) == {"filter:result": [BARS]}


def test_deleting_an_instance_deletes_the_charts_of_its_nodes(services, tmp_path):
    _, projects, _, _ = services
    worktree, snapshot = create(projects, tmp_path, {"filter:result": [BARS], "total:result": [LINE]})
    grouped, instance = group(snapshot["bundle"], ["filter"], "Qualifying orders")
    saved = projects.write(worktree["id"], snapshot["revision"], bundle_to_files(grouped))
    saved = projects.write(
        worktree["id"], saved["revision"], bundle_to_files(without(saved["bundle"], instance))
    )
    assert saved["bundle"]["charts"] == {"total:result": [LINE]}
    assert committed_charts(projects, worktree) == {"total:result": [LINE]}


def test_charts_of_outputs_missing_for_another_reason_are_kept_silently(services, tmp_path):
    _, projects, _, _ = services
    worktree, snapshot = create(projects, tmp_path, {"ghost:result": [BARS], "filter:result": [LINE]})
    saved = projects.write(
        worktree["id"], snapshot["revision"], bundle_to_files(without(snapshot["bundle"], "total"))
    )
    assert saved["bundle"]["charts"] == {"ghost:result": [BARS], "filter:result": [LINE]}
    assert not [d for d in saved["diagnostics"] if d["file"] == "charts.json"]
