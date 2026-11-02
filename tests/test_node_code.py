"""Node-owned SQL follows the same execution, storage and Git contracts as templates."""

import copy
import io
import json
from pathlib import Path

import pytest
from helpers import example_bundle, wait_run

from duckpad.archive import archive_bundle, read_archive, write_archive
from duckpad.bundle import bundle_to_files, files_to_bundle, is_declarative, validate
from duckpad.comparison import compare_files
from duckpad.components import expand, group, import_definition
from duckpad.merge import merge_files
from duckpad.node_code import code_path, node_sql
from duckpad.search import node_entries
from duckpad.util import Problem


def detach(bundle, node, parent=None):
    text = node_sql(bundle, node, parent)
    node["origin"] = node.pop("template")
    bundle.setdefault("node_sql", {})[code_path(node["id"], parent)] = text


def test_owned_sql_storage_execution_and_conversions(services, tmp_path):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    old_nodes = copy.deepcopy(bundle["flow"]["nodes"])
    node = bundle["flow"]["nodes"][1]
    linked = engine.fingerprints.of(bundle, "dev")
    detach(bundle, node)
    assert engine.fingerprints.of(bundle, "dev") == linked
    assert bundle["flow"]["nodes"][0] == old_nodes[0]
    files = bundle_to_files(bundle)
    assert files["nodes/filter.sql"] == bundle["templates"]["filter"]
    assert "template" not in json.loads(files["flow.json"])["nodes"][1]
    assert files_to_bundle(files)["node_sql"] == bundle["node_sql"]
    assert validate(bundle) == []
    worktree = projects.create("Owned SQL", bundle)["id"]
    assert projects.snapshot(worktree)["files"]["nodes/filter.sql"] == files["nodes/filter.sql"]
    assert "WHERE amount" in engine.compile(worktree, "dev", "filter")[0]["sql"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["status"] == "success", run
    assert engine.preview(worktree, "dev", "total")["rows"]
    # Converting to a new shared definition does not change the SQL or parameters.
    bundle["templates"]["converted"] = "-- @label Converted\n" + bundle["node_sql"].pop("nodes/filter.sql")
    node["template"] = "converted"
    assert engine.fingerprints.of(bundle, "dev") == linked
    snapshot = projects.snapshot(worktree)
    projects.write(worktree, snapshot["revision"], bundle_to_files(bundle))
    assert "nodes/filter.sql" not in projects.read_files(projects.get(worktree))
    assert engine.preview(worktree, "dev", "total")["status"] == "valid"
    # Relinking to changed code invalidates only this node and its descendants.
    bundle["templates"]["filter"] = bundle["templates"]["filter"].replace("amount >", "amount >=")
    node["template"] = "filter"
    changed = engine.fingerprints.of(bundle, "dev")
    assert changed["source"] == linked["source"]
    assert changed["filter"] != linked["filter"]
    assert changed["total"] != linked["total"]


def test_group_nested_copy_and_archive_keep_owned_code(tmp_path):
    bundle = example_bundle(tmp_path / "input.csv")
    detach(bundle, bundle["flow"]["nodes"][1])
    grouped, instance = group(bundle, ["filter", "total"], "Summary")
    definition = next(n["component"] for n in grouped["flow"]["nodes"] if n["id"] == instance)
    path = code_path("filter", definition)
    assert "nodes/filter.sql" not in grouped["node_sql"]
    assert grouped["node_sql"][path] == bundle["node_sql"]["nodes/filter.sql"]
    assert expand(grouped)[0][instance + "::filter"]["template_sql"] == grouped["node_sql"][path]
    nested, _ = group(grouped, ["filter"], "Filter inside summary", parent=definition)
    assert path not in nested["node_sql"]
    assert validate(nested) == []
    destination = {"flow": {"nodes": [], "edges": []}, "templates": {}, "components": {}, "documentation": {}}
    imported, key = import_definition(destination, nested, "components", definition, {"project": "source"})
    assert imported["node_sql"]
    assert set(imported["node_sql"]).isdisjoint(nested["node_sql"])
    assert validate(imported) == []
    assert key in imported["components"]
    files = bundle_to_files(imported)
    restored = archive_bundle(read_archive(io.BytesIO(write_archive(files))))
    assert restored["node_sql"] == imported["node_sql"]
    assert restored["components"] == imported["components"]


def test_owned_sql_conflicts_comparison_and_search(services, tmp_path):
    _, projects, _, _ = services
    bundle = example_bundle(tmp_path / "input.csv")
    detach(bundle, bundle["flow"]["nodes"][1])
    bundle["node_sql"]["nodes/filter.sql"] = (
        "-- @label My independent filter\n" + bundle["node_sql"]["nodes/filter.sql"]
    )
    base = bundle_to_files(bundle)
    current = {**base, "nodes/filter.sql": base["nodes/filter.sql"].replace("amount >", "amount >=")}
    proposal = {**base, "nodes/filter.sql": base["nodes/filter.sql"].replace("amount >", "amount <")}
    assert merge_files(base, current, proposal)[1] == ["nodes/filter.sql"]
    comparison = compare_files(base, current)
    item = next(e for e in comparison["entities"] if e["id"] == "node/filter")
    assert item["status"] == "modified"
    assert item["file"] == "nodes/filter.sql"
    assert "sql" in item["fields"]
    assert comparison["impact"]["direct"] == ["filter"]
    assert next(n for n in node_entries(bundle) if n["node"] == "filter")["label"] == "My independent filter"
    worktree = projects.create("Conflicts", bundle)["id"]
    snapshot = projects.snapshot(worktree)
    projects.write(worktree, snapshot["revision"], current)
    with pytest.raises(Problem, match="Concurrent edits conflict"):
        projects.write(worktree, snapshot["revision"], proposal)
    conflict = projects.snapshot(worktree)["conflicts"][0]
    assert conflict["paths"] == ["nodes/filter.sql"]
    projects.resolve(conflict["id"], "proposal")
    assert projects.read_files(projects.get(worktree))["nodes/filter.sql"] == proposal["nodes/filter.sql"]


def test_missing_code_and_illegal_resources_are_blocked(services, tmp_path):
    _, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    detach(bundle, bundle["flow"]["nodes"][1])
    bundle["node_sql"]["nodes/filter.sql"] = "-- @output result\nSELECT * FROM read_csv('/undeclared.csv');"
    worktree = projects.create("Invalid code", bundle)["id"]
    with pytest.raises(Problem):
        engine.compile(worktree, "dev", "filter")
    del bundle["node_sql"]["nodes/filter.sql"]
    assert any("Missing node code" in item["message"] for item in validate(bundle))
    assert "error" in expand(bundle, tolerant=True)[0]["filter"]


def test_node_paths_are_bounded_and_symlinks_rejected(services, tmp_path):
    for path in ("nodes/a.sql", "components/c/a.sql"):
        assert is_declarative(path)
    for path in ("nodes/../a.sql", "nodes/a/b.sql", "components/c/../../a.sql", "/nodes/a.sql"):
        assert not is_declarative(path)
    _, projects, _, _ = services
    bundle = example_bundle(tmp_path / "input.csv")
    detach(bundle, bundle["flow"]["nodes"][1])
    worktree = projects.create("Paths", bundle)
    path = Path(worktree["path"]) / "nodes/filter.sql"
    path.unlink()
    path.symlink_to(tmp_path / "input.csv")
    with pytest.raises(Problem, match="symbolic links"):
        projects.read_files(worktree)


def test_deleting_node_removes_code_and_conflicts_with_concurrent_code_edit(services, tmp_path):
    _, projects, _, _ = services
    bundle = example_bundle(tmp_path / "input.csv")
    detach(bundle, bundle["flow"]["nodes"][1])
    worktree = projects.create("Delete owned code", bundle)["id"]
    base = projects.snapshot(worktree)
    removed = copy.deepcopy(base["bundle"])
    removed["flow"]["nodes"] = [n for n in removed["flow"]["nodes"] if n["id"] != "filter"]
    files = {**base["files"], "nodes/filter.sql": base["files"]["nodes/filter.sql"] + "\n-- concurrent edit"}
    projects.write(worktree, base["revision"], files)
    with pytest.raises(Problem, match="Concurrent edits conflict"):
        projects.write(worktree, base["revision"], bundle_to_files(removed))
    assert projects.snapshot(worktree)["conflicts"][0]["paths"] == ["nodes/filter.sql"]
    current = projects.snapshot(worktree)
    projects.write(worktree, current["revision"], bundle_to_files(removed))
    assert "nodes/filter.sql" not in projects.snapshot(worktree)["files"]


def test_local_descriptions_preserve_fingerprints_and_compare_as_documentation(services, tmp_path):
    _, _, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    detach(bundle, bundle["flow"]["nodes"][1])
    before = bundle_to_files(bundle)
    fingerprints = engine.fingerprints.of(bundle, "dev")
    bundle["node_sql"]["nodes/filter.sql"] = "-- @label New name\n" + bundle["node_sql"]["nodes/filter.sql"]
    assert engine.fingerprints.of(bundle, "dev") == fingerprints
    report = compare_files(before, bundle_to_files(bundle))
    assert next(e for e in report["entities"] if e["id"] == "node/filter")["categories"] == ["documentation"]
    assert report["impact"]["direct"] == []


def test_owned_export_download_and_lineage_use_local_code(services, tmp_path):
    from duckpad.builtin_templates import BUILTINS
    from duckpad.lineage import Lineage

    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    for node in bundle["flow"]["nodes"]:
        detach(bundle, node)
    bundle["flow"]["nodes"].append(
        {"id": "export", "origin": "export_csv", "params": {"destination": "totals.csv"}}
    )
    bundle["node_sql"]["nodes/export.sql"] = BUILTINS["export_csv"]
    bundle["flow"]["edges"].append(
        {
            "id": "export",
            "source": "total",
            "sourceHandle": "result",
            "target": "export",
            "targetHandle": "source",
        }
    )
    # Removing templates proves that no execution or access validation falls back to the origin.
    bundle["templates"] = {}
    worktree = projects.create("Owned exports", bundle)["id"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["status"] == "success", run
    preview = engine.preview(worktree, "dev", "total")
    lineage = Lineage(engine).explain(worktree, "dev", preview["id"], 0, "total")
    assert lineage["complete"]
    assert lineage["total"] == 2
    result = engine.exports.result(worktree, "dev", "export")
    assert result["status"] == "available", result
    with engine.exports.open(worktree, "dev", "export", run["id"]) as (stream, _):
        assert b"North,30,2" in stream.read()
    assert run["node_sql"] == bundle["node_sql"]
