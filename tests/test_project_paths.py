from pathlib import Path, PurePosixPath, PureWindowsPath

import pytest

from duckpad import projects as projects_module
from duckpad.builtin_templates import BUILTINS
from duckpad.example import create_example


def normalized_files(snapshot):
    # Git may normalize the CRLF written by Windows to LF in its archive.
    return {name: text.replace("\r\n", "\n") for name, text in snapshot["files"].items()}


@pytest.mark.parametrize("relative_path", [PurePosixPath, PureWindowsPath], ids=["posix", "windows"])
def test_example_definitions_survive_disk_and_git_round_trips(services, monkeypatch, relative_path):
    class ProjectPath(type(Path())):
        def relative_to(self, *other, **kwargs):
            # Exercise both path separators while keeping real filesystem and Git operations.
            return relative_path(*super().relative_to(*other, **kwargs).parts)

    monkeypatch.setattr(projects_module, "Path", ProjectPath)
    _, projects, catalog, _ = services
    worktree = create_example(projects, catalog)
    snapshot = projects.snapshot(worktree["id"])
    assert snapshot["diagnostics"] == []
    assert snapshot["bundle"]["templates"].keys() >= BUILTINS.keys()
    assert snapshot["bundle"]["components"].keys() == {"regional_summary", "regional_report"}
    assert "templates/load_csv.sql" in snapshot["files"]
    assert "components/regional_report.json" in snapshot["files"]
    assert all("\\" not in name for name in snapshot["files"])
    committed = projects.snapshot(worktree["id"], committed=True)
    assert committed["diagnostics"] == []
    assert normalized_files(committed) == normalized_files(snapshot)

    files = normalized_files(snapshot)
    files["templates/load_csv.sql"] += "\n-- Updated source documentation.\n"
    updated = projects.write(worktree["id"], snapshot["revision"], files)
    assert updated["diagnostics"] == []
    assert normalized_files(updated) == files
    assert normalized_files(projects.snapshot(worktree["id"], committed=True)) == files
