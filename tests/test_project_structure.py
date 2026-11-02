import copy
import json
import tomllib
from pathlib import Path

import pytest
from helpers import example_bundle, wait_run, wait_until

from duckpad import __version__
from duckpad.bundle import bundle_to_files, files_to_bundle
from duckpad.comparison import compare_files
from duckpad.util import Problem


def test_new_project_has_a_dependency_manifest_and_separate_markdown(services, tmp_path):
    _, projects, _, _ = services
    bundle = example_bundle(tmp_path / "input.csv")
    text = "# Revenue\n\nBusiness context: 東京.\n\n- Preserve **Markdown**."
    bundle["documentation"] = {"project": text, "nodes": {"filter": "Qualifying orders"}}
    worktree = projects.create('Revenue / "2026"', bundle)
    snapshot = projects.snapshot(worktree["id"], committed=True)
    files = snapshot["files"]
    assert files["README.md"] == text
    assert json.loads(files["documentation.json"]) == {"nodes": {"filter": "Qualifying orders"}}
    manifest = tomllib.loads(files["pyproject.toml"])
    assert manifest["project"] == {
        "name": "duckpad-project-revenue-2026",
        "version": "0.1.0",
        "readme": "README.md",
        "requires-python": ">=3.11",
        "dependencies": [f"duckpad=={__version__}"],
    }
    assert manifest["tool"]["uv"]["package"] is False
    assert snapshot["bundle"]["documentation"] == bundle["documentation"]
    assert not snapshot["diagnostics"]
    assert bundle_to_files(snapshot["bundle"]) == files
    assert projects.git(worktree["path"], "check-ignore", ".venv/lib/package.py")


def test_old_project_documentation_moves_to_readme_on_save():
    files = {
        "flow.json": '{"name":"Existing", "nodes":[], "edges":[]}',
        "documentation.json": '{"project":"Original context", "nodes":{"one":"Node context"}}',
    }
    saved = bundle_to_files(files_to_bundle(files))
    assert saved["README.md"] == "Original context"
    assert json.loads(saved["documentation.json"]) == {"nodes": {"one": "Node context"}}
    assert tomllib.loads(saved["pyproject.toml"])["project"]["dependencies"] == [f"duckpad=={__version__}"]
    # An intentionally empty README must never revive the old JSON text.
    assert "project" not in files_to_bundle({**files, "README.md": ""})["documentation"]


def test_raw_manifest_survives_bundle_saves_and_documentation_reconciliation(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create("Dependencies", example_bundle(tmp_path / "input.csv"))
    snapshot = projects.snapshot(worktree["id"])
    manifest = (
        snapshot["files"]["pyproject.toml"].replace(
            f'"duckpad=={__version__}"', f'"duckpad=={__version__}", "pandas>=2"'
        )
        + '\n# Preserve custom configuration.\n[tool.custom]\nvalue = "custom"\n'
    )
    files = {**snapshot["files"], "pyproject.toml": manifest, "README.md": "# Context\n"}
    saved = projects.write(worktree["id"], snapshot["revision"], files)
    bundle = saved["bundle"]
    bundle["documentation"]["nodes"] = {"filter": "Filter context"}
    bundle["flow"]["nodes"] = [n for n in bundle["flow"]["nodes"] if n["id"] != "filter"]
    bundle["flow"]["edges"] = []
    result = projects.write(worktree["id"], saved["revision"], bundle_to_files(bundle))
    committed = projects.snapshot(worktree["id"], committed=True)
    assert result["files"] == committed["files"]
    assert committed["files"]["pyproject.toml"] == manifest
    assert committed["files"]["README.md"] == "# Context\n"
    assert "project" not in json.loads(committed["files"]["documentation.json"])
    assert not committed["bundle"]["documentation"]["nodes"]


@pytest.mark.parametrize("name", ["README.md", "pyproject.toml"])
def test_new_files_are_watched_and_conflicting_ui_edits_are_recoverable(services, name):
    _, projects, _, _ = services
    worktree = projects.create("Concurrent edits")
    initial = projects.snapshot(worktree["id"])
    external = initial["files"][name] + "\n# External edit\n"
    projects.start_watcher()
    Path(worktree["path"], name).write_text(external, encoding="utf-8")
    wait_until(
        lambda: projects.snapshot(worktree["id"], committed=True)["files"][name] == external,
        message="External edit was not committed",
    )
    proposal = {**initial["files"], name: initial["files"][name] + "\n# UI edit\n"}
    with pytest.raises(Problem, match="Concurrent edits conflict"):
        projects.write(worktree["id"], initial["revision"], proposal)
    conflict = projects.snapshot(worktree["id"])["conflicts"][0]
    assert conflict["paths"] == [name]
    assert conflict["current"][name] == external
    resolved = projects.resolve(conflict["id"], "proposal")
    assert resolved["files"][name] == proposal[name]
    assert projects.revision_files(worktree["path"], initial["commit"])[name] == initial["files"][name]


def test_readme_and_manifest_changes_merge_between_branches_without_changing_sql_results(services, tmp_path):
    store, projects, _, engine = services
    main = projects.create("Branching", example_bundle(tmp_path / "input.csv"))
    wait_run(store, engine.launch(main["id"], "dev"))
    branch = projects.branch(main["id"], "project-layout")
    before = projects.snapshot(main["id"])
    snapshot = projects.snapshot(branch["id"])
    files = {**snapshot["files"], "README.md": "# Shared context\n"}
    files["pyproject.toml"] += "\n# Additional dependencies can be declared above.\n"
    projects.write(branch["id"], snapshot["revision"], files)
    assert projects.snapshot(main["id"])["files"] == before["files"]
    report = compare_files(before["files"], files)
    changes = [item for item in report["entities"] if item["status"] != "unchanged"]
    assert {item["file"] for item in changes} == {"README.md", "pyproject.toml"}
    review = projects.versioning.prepare(main["id"], "refs/heads/project-layout")
    assert review["conflicts"] == []
    proposal = projects.versioning.proposal(main["id"], review["id"], {})
    projects.versioning.apply(main["id"], review["id"], {}, proposal["proposal_revision"])
    assert projects.snapshot(main["id"], committed=True)["files"] == files
    assert engine.preview(main["id"], "dev", "total")["status"] == "valid"


def test_invalid_toml_is_saved_with_a_file_diagnostic_and_can_be_repaired(services):
    _, projects, _, _ = services
    worktree = projects.create("TOML validation")
    before = projects.snapshot(worktree["id"])
    files = {**before["files"], "pyproject.toml": "[project\n"}
    invalid = projects.write(worktree["id"], before["revision"], files)
    assert invalid["bundle"] is not None
    assert invalid["diagnostics"][0]["file"] == "pyproject.toml"
    assert projects.snapshot(worktree["id"], committed=True)["files"]["pyproject.toml"] == "[project\n"
    # Saving another panel must not replace the invalid draft with generated defaults.
    bundle = copy.deepcopy(invalid["bundle"])
    bundle["documentation"]["project"] = "Business context"
    assert bundle_to_files(bundle)["pyproject.toml"] == "[project\n"
    repaired = projects.write(worktree["id"], invalid["revision"], before["files"])
    assert not repaired["diagnostics"]


@pytest.mark.parametrize("name", ["README.md", "pyproject.toml"])
def test_new_project_files_cannot_read_symlink_targets(services, tmp_path, name):
    _, projects, _, _ = services
    worktree = projects.create("Links")
    target = tmp_path / "private.txt"
    target.write_text("Private content")
    path = Path(worktree["path"], name)
    path.unlink()
    path.symlink_to(target)
    with pytest.raises(Problem, match="symbolic links"):
        projects.snapshot(worktree["id"])
