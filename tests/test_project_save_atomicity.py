"""A refused save must never become an external save on the next watcher pass."""

import json
from pathlib import Path

import pytest

from duckpad import projects as project_module
from duckpad.comparison import CommitContext
from duckpad.git.command import GitError, GitTimeout
from duckpad.projects import QUIET_PERIOD, SAVE_BACKUPS
from duckpad.services import Services
from duckpad.util import dumps


def observe_after_quiet_period(projects, worktree):
    """Run the watcher twice, as if the changes it notices had been quiet for QUIET_PERIOD."""
    with projects.locked(worktree["id"]):
        projects._observe(worktree)
        if worktree["id"] in projects.pending:
            projects.pending[worktree["id"]] -= QUIET_PERIOD + 1
        projects._observe(worktree)


@pytest.mark.parametrize("linked", [False, True])
@pytest.mark.parametrize("staged", [False, True])
@pytest.mark.parametrize("failure", ["index_lock", "timeout", "completed_timeout", "disk"])
def test_failed_save_restores_files_index_and_head(services, monkeypatch, linked, staged, failure):
    _, projects, _, _ = services
    worktree = projects.create("Atomic saves")
    if linked:
        worktree = projects.branch(worktree["id"], "working")
    path = Path(worktree["path"])
    # Preserve an unrelated staged file as well as the declarative project.
    if staged:
        (path / "notes.txt").write_text("Staged outside Duckpad")
        projects.git(path, "add", "notes.txt")
    before = projects.snapshot(worktree["id"])
    index = Path(projects.git(path, "rev-parse", "--absolute-git-dir")) / "index"
    original_index = index.read_bytes()
    proposal = dict(before["files"])
    proposal["README.md"] = "Rejected documentation"
    flow = json.loads(proposal["flow.json"])
    flow["description"] = "Rejected description"
    proposal["flow.json"] = dumps(flow)
    proposal["modules/new.py"] = "VALUE = 1\n"
    proposal.pop("templates/filter.sql")
    git, write = projects.git, project_module.atomic_write
    writes = 0

    def failing_git(path, *args, **options):
        if args[0] == "commit":
            if failure == "completed_timeout":
                git(path, *args, **options)
            raise GitTimeout
        return git(path, *args, **options)

    def failing_write(target, content):
        nonlocal writes
        if content != before["files"].get(target.relative_to(path).as_posix()):
            writes += 1
            if writes >= 2:
                raise OSError("Simulated full disk")
        write(target, content)

    with monkeypatch.context() as fault:
        if failure == "index_lock":
            lock = index.with_name("index.lock")
            lock.write_text("Held by another process")
        elif failure == "disk":
            fault.setattr(project_module, "atomic_write", failing_write)
        else:
            fault.setattr(projects, "git", failing_git)
        with pytest.raises(OSError if failure == "disk" else GitError):
            projects.write(worktree["id"], before["revision"], proposal, assistant="conversation-test")
        if failure == "index_lock":
            assert lock.read_text() == "Held by another process"
            lock.unlink()

    assert projects.read_files(worktree) == before["files"]
    assert projects.git(path, "rev-parse", "HEAD") == before["commit"]
    assert index.read_bytes() == original_index
    if staged:
        assert (path / "notes.txt").read_text() == "Staged outside Duckpad"
    observe_after_quiet_period(projects, worktree)
    assert projects.git(path, "rev-parse", "HEAD") == before["commit"]
    assert worktree["id"] not in projects.pending


def test_failed_save_keeps_preexisting_external_edits_without_committing_them(services, monkeypatch):
    _, projects, _, _ = services
    worktree = projects.create("Pending external edit")
    before = projects.snapshot(worktree["id"])
    path = Path(worktree["path"])
    (path / "README.md").write_text("Independent external documentation")
    existing = projects.read_files(worktree)
    proposal = dict(before["files"])
    flow = json.loads(proposal["flow.json"])
    flow["description"] = "Rejected UI description"
    proposal["flow.json"] = dumps(flow)
    git = projects.git
    commits = 0

    def fail_second_commit(path, *args, **options):
        nonlocal commits
        if args[0] == "commit":
            commits += 1
            if commits == 2:
                raise GitTimeout
        return git(path, *args, **options)

    with monkeypatch.context() as fault:
        fault.setattr(projects, "git", fail_second_commit)
        with pytest.raises(GitTimeout):
            projects.write(worktree["id"], before["revision"], proposal)
    assert commits == 2
    assert projects.git(path, "rev-parse", "HEAD") == before["commit"]
    assert projects.read_files(worktree) == existing
    observe_after_quiet_period(projects, worktree)
    head = projects.git(path, "rev-parse", "HEAD")
    assert projects.revision_files(path, head) == existing
    assert projects.git(path, "rev-list", "--count", before["commit"] + "..HEAD") == "1"


def test_partial_disk_write_leaves_no_temporary_files(services, monkeypatch):
    _, projects, _, _ = services
    worktree = projects.create("Partial disk write")
    path = Path(worktree["path"])
    before = projects.snapshot(worktree["id"])
    write_bytes = Path.write_bytes
    writes = 0

    def full_disk(target, content):
        nonlocal writes
        if ".tmp-" in target.name:
            writes += 1
            if writes == 2:
                write_bytes(target, content[:10])
                raise OSError("Simulated partial write")
        return write_bytes(target, content)

    with monkeypatch.context() as fault:
        fault.setattr(Path, "write_bytes", full_disk)
        with pytest.raises(OSError, match="partial write"):
            projects.write(worktree["id"], before["revision"], {**before["files"], "README.md": "Rejected"})
    assert writes == 2
    assert projects.read_files(worktree) == before["files"]
    assert projects.git(path, "status", "--porcelain") == ""
    observe_after_quiet_period(projects, worktree)
    assert projects.git(path, "rev-parse", "HEAD") == before["commit"]


def test_failed_commit_restores_reconciled_documentation_and_owned_code(services):
    _, projects, _, _ = services
    worktree = projects.create("Reconciled documentation")
    snapshot = projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"] = [{"id": "source", "params": {}}]
    bundle["node_sql"] = {"nodes/source.sql": "-- @output result\nSELECT 1 AS value;\n"}
    bundle["documentation"] = {"nodes": {"source": "Keep this documentation"}}
    before = projects.write(worktree["id"], snapshot["revision"], project_module.bundle_to_files(bundle))
    path = Path(worktree["path"])
    bundle["flow"]["nodes"] = []
    (path / "flow.json").write_text(dumps(bundle["flow"]))
    existing = projects.read_files(worktree)
    index = Path(projects.git(path, "rev-parse", "--absolute-git-dir")) / "index"
    lock = index.with_name("index.lock")
    lock.touch()
    try:
        with pytest.raises(GitError):
            projects.commit(path, CommitContext.EXTERNAL)
    finally:
        lock.unlink()
    assert projects.read_files(worktree) == existing
    assert projects.git(path, "rev-parse", "HEAD") == before["commit"]
    # Retrying the genuine external edit still performs reconciliation.
    projects.commit(path, CommitContext.EXTERNAL)
    assert "nodes/source.sql" not in projects.read_files(worktree)
    assert "Keep this documentation" not in (path / "documentation.json").read_text()


def test_restart_removes_backups_left_by_an_interrupted_save(tmp_path):
    home = tmp_path / "instance"
    services = Services.open(home, isolated=False, enforce_access=False)
    worktree = services.projects.create("Interrupted save")
    leftover = Path(worktree["path"]) / (SAVE_BACKUPS + "interrupted")
    (leftover / "nodes").mkdir(parents=True)
    (leftover / "nodes" / "source.sql").write_text("SELECT 1 AS value;\n")
    services.close()
    services = Services.open(home, isolated=False, enforce_access=False)
    try:
        services.projects.start_watcher()
        assert not leftover.exists()
        assert services.projects.git(worktree["path"], "status", "--porcelain") == ""
    finally:
        services.close()
