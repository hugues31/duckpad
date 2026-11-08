"""Readable project files, optimistic saves, external batching and Git worktrees."""

from __future__ import annotations

import copy
import io
import logging
import shutil
import tarfile
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Collection, Generator, Iterable, Mapping
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Literal, TypeVar, Unpack, cast, overload

from . import python_environment, views
from .artifacts import Artifacts
from .builtin_templates import BUILTINS
from .bundle import bundle_to_files, file_node_names, files_to_bundle
from .comparison import CommitContext, commit_message
from .components import expand, reconcile_documentation
from .git import command
from .git.command import GitError, GitOptions
from .git.identity import SYSTEM_IDENTITY, current_identity
from .git.remote import Remotes
from .git.workspace import GitWorkspace, diagnose, history_cache_key, origin_key, require_valid
from .merge import conflict_details, merge_files
from .node_code import owned_paths
from .node_names import node_names
from .project_files import definition_names, is_declarative
from .python_nodes import remember_contracts
from .python_policy import get_policy
from .store import Store
from .templates import parse_template
from .types import Files, Record
from .util import Problem, atomic_write, digest, dumps, inside, now, uid

logger = logging.getLogger(__name__)

# The watcher polls files every WATCH_INTERVAL and commits a batch after QUIET_PERIOD without changes.
WATCH_INTERVAL = 0.1
QUIET_PERIOD = 0.5
CACHED_REVISIONS = 256
# After a restart, the base of a save is searched in this many latest commits of its branch.
BASE_SEARCH = 32
# A save keeps its backups in an untracked worktree folder named with this prefix.
SAVE_BACKUPS = ".duckpad-save-"
OPEN_FAILURE = "Git could not open this branch. It may be checked out outside Duckpad."


def decode(name: str, content: bytes) -> str:
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise Problem(f"{name} is not valid UTF-8 text", 422) from error


def conflict_view(conflict: Record) -> Record:
    """A retained conflict with its review evidence and the names of nodes in any of its versions."""
    return {
        **conflict_details(conflict),
        "node_names": file_node_names(conflict["base"], conflict["proposal"], conflict["current"]),
    }


CachedValue = TypeVar("CachedValue")


class Projects:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.locks: dict[str, threading.RLock] = {}
        self.locks_guard = threading.Lock()
        # Guards the bounded caches, which requests read without a repository lock.
        self.cache_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.observed: dict[str, Files] = {}
        self.pending: dict[str, float] = {}
        self.commit_files: OrderedDict[tuple[str, str], Files] = OrderedDict()
        self.revisions: OrderedDict[tuple[str, str], Files] = OrderedDict()
        self.snapshot_definitions: OrderedDict[tuple[str, str], Record] = OrderedDict()
        self.views: OrderedDict[tuple[str, str], Record] = OrderedDict()
        self.on_change: Callable[[str], None] = lambda worktree: None
        self.thread: threading.Thread | None = None
        self.versioning = GitWorkspace(self)
        self.remotes = Remotes(self.versioning)

    def repository(self, project_id: str) -> threading.RLock:
        """The lock serializing changes to one project's Git repository and all its worktrees.

        Network Git and history validation run outside it. Nothing holds two repository locks,
        and a repository lock is always taken before the engine lock.
        """
        with self.locks_guard:
            return self.locks.setdefault(project_id, threading.RLock())

    @contextmanager
    def locked(self, worktree_id: str) -> Generator[Record, None, None]:
        """Hold the repository lock of a worktree's project; yield the worktree read under it."""
        with self.repository(self.get(worktree_id)["project"]):
            yield self.get(worktree_id)

    def activity(self, user: Record) -> list[Record]:
        visible = self.store.visible_projects(user)
        latest = self.store.latest_project_runs([project["id"] for project in visible])
        paths = {worktree["id"]: worktree["path"] for worktree in self.store.all("worktree")}
        # One git call per project: the dashboard loads this once, without polling.
        for project in visible:
            dates = self.git(
                paths[project["main"]],
                "for-each-ref",
                "--sort=-committerdate",
                "--count=1",
                "--format=%(committerdate:iso-strict)",
                "refs/heads",
                check=False,
            )
            project["updated"] = dates.strip() or project["created"]
            project["last_run"] = latest.get(project["id"])
        return visible

    def identity(self) -> dict[str, str]:
        """The request's account, or the system for changes made outside a request."""
        return current_identity.get() or SYSTEM_IDENTITY

    @overload
    def git(
        self,
        path: str | Path,
        *args: str,
        identity: Mapping[str, str] | None = None,
        binary: Literal[False] = False,
        **options: Unpack[GitOptions],
    ) -> str: ...

    @overload
    def git(
        self,
        path: str | Path,
        *args: str,
        identity: Mapping[str, str] | None = None,
        binary: Literal[True],
        **options: Unpack[GitOptions],
    ) -> bytes: ...

    @overload
    def git(
        self,
        path: str | Path,
        *args: str,
        identity: Mapping[str, str] | None = None,
        binary: bool,
        **options: Unpack[GitOptions],
    ) -> str | bytes: ...

    def git(
        self,
        path: str | Path,
        *args: str,
        identity: Mapping[str, str] | None = None,
        binary: bool = False,
        **options: Unpack[GitOptions],
    ) -> str | bytes:
        """Run Git as the request's account; see command.run for the options."""
        return command.run(path, *args, identity=identity or self.identity(), binary=binary, **options)

    def create(
        self,
        name: str,
        bundle: Record | None = None,
        action: str = "create",
        *,
        project_id: str | None = None,
        record: Callable[[Record], None] | None = None,
    ) -> Record:
        """Create a project repository and record it; record(worktree) joins the same transaction.

        A project is either recorded with its repository and related records, or leaves nothing behind.
        """
        project_id, worktree_id = project_id or uid("project_"), uid("worktree_")
        path = self.store.paths.project(project_id)
        path.mkdir(parents=True)
        try:
            self.git(path, "init", "-b", "main")
            atomic_write(
                path / ".gitignore", "data/\nexports/\n*.duckdb\n*.duckdb.wal\n.venv/\n__pycache__/\n"
            )
            if bundle is None:
                bundle = {
                    "flow": {"id": project_id, "name": name, "description": "", "nodes": [], "edges": []},
                    "templates": BUILTINS.copy(),
                    "components": {},
                    "documentation": {},
                }
            bundle["flow"].update(id=project_id, name=name)
            for file, content in bundle_to_files(bundle).items():
                atomic_write(path / file, content)
            self.commit(path, message=f"feat(project): {action} " + " ".join(name.split())[:64])
            project = {"id": project_id, "name": name, "main": worktree_id, "created": now()}
            worktree = {"id": worktree_id, "project": project_id, "branch": "main", "path": str(path)}
            with self.store.transaction():
                self.store.put("project", project_id, project)
                self.store.put("worktree", worktree_id, worktree)
                if record is not None:
                    record(worktree)
        except Exception:
            shutil.rmtree(path, ignore_errors=True)
            raise
        self.observed[worktree_id] = self.read_files(worktree)
        return worktree

    def delete(self, project_id: str) -> None:
        self.delete_files(project_id, *self.delete_records(project_id))

    def delete_records(self, project_id: str) -> tuple[list[Record], list[Record]]:
        """Detach metadata while the caller prevents new runs for the project."""
        with self.repository(project_id):
            with self.store.transaction():
                worktrees = self.store.worktrees(project_id)
                artifacts = self.store.artifacts(project=project_id)
                # Example connections own files inside this project's resources directory.
                self.store.delete("connection", "sample_" + project_id)
                self.store.delete("settings", "python:" + project_id)
                self.store.delete(
                    "settings", history_cache_key(self.store.paths.project(project_id) / ".git")
                )
                self.store.delete("project", project_id)
            return worktrees, artifacts

    def delete_files(self, project_id: str, worktrees: list[Record], artifacts: list[Record]) -> None:
        self.discard(worktrees, artifacts)
        shutil.rmtree(self.store.paths.resources(project_id), ignore_errors=True)

    def open_worktree(self, worktree: Record, branch: str, start: str | None = None) -> Record:
        """Check out a branch, created at start when given, in a new recorded worktree.

        The caller holds the repository lock. The record follows the checkout and is never left
        without its directory: a failure removes the checkout and the branch it created.
        """
        repository, key = worktree["path"], uid("worktree_")
        path = self.store.paths.worktree(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Forget directories removed by an interrupted cleanup; Git would keep their branch checked out.
        self.git(repository, "worktree", "prune")
        self.git(
            repository,
            "worktree",
            "add",
            *(["-b", branch, str(path), start] if start else [str(path), branch]),
            failure=command.FAILURE if start else OPEN_FAILURE,
        )
        result = {"id": key, "project": worktree["project"], "branch": branch, "path": str(path)}
        try:
            files = self.read_files(result)
            if start:
                self.git(repository, "config", origin_key(branch), worktree["branch"])
            self.store.put("worktree", key, result)
        except Exception:
            shutil.rmtree(path, ignore_errors=True)
            with suppress(GitError):
                self.git(repository, "worktree", "prune")
            if start:
                with suppress(GitError):
                    self.git(repository, "update-ref", "-d", "refs/heads/" + branch, start)
            raise
        self.observed[key] = files
        return result

    def discard(self, worktrees: Iterable[Record], artifacts: Iterable[Record]) -> None:
        """Remove the files of deleted worktree and artifact records, after their deletion.

        Every step tolerates files that are already gone, so an interrupted cleanup can run again.
        """
        storage = Artifacts(self.store)
        for record in artifacts:
            storage.remove(record["id"], record=record)
        for worktree in worktrees:
            self.observed.pop(worktree["id"], None)
            self.pending.pop(worktree["id"], None)
            shutil.rmtree(worktree["path"], ignore_errors=True)
            shutil.rmtree(self.store.paths.exports(worktree["id"]), ignore_errors=True)
            partition_artifacts = self.store.paths.partition_artifacts(worktree["id"])
            shutil.rmtree(partition_artifacts, ignore_errors=True)
            with suppress(OSError):
                partition_artifacts.parent.rmdir()

    def job_worktree(self, project: str, commit: str) -> Record:
        """Create an internal detached checkout; the caller holds the repository lock."""
        main = self.get(self.store.get("project", project)["main"])
        key = uid("worktree_")
        path = self.store.paths.worktree(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.git(main["path"], "worktree", "add", "--detach", str(path), commit)
        worktree = {
            "id": key,
            "project": project,
            "branch": "job:" + key,
            "path": str(path),
            "read_only": True,
        }
        try:
            self.store.put("worktree", key, worktree)
        except Exception:
            self.git(main["path"], "worktree", "remove", "--force", str(path))
            raise
        return worktree

    @staticmethod
    def writable(worktree: Record) -> None:
        if worktree.get("read_only"):
            raise Problem("Job results are read-only", 403)

    def get(self, worktree_id: str) -> Record:
        result = self.store.get("worktree", worktree_id)
        if not result:
            raise Problem("Worktree not found", 404)
        return cast(Record, result)

    def read_files(self, worktree: Mapping[str, str]) -> Files:
        path = Path(worktree["path"])
        names = definition_names(path)
        if any(
            (path / name).is_symlink() or not (path / name).resolve().is_relative_to(path.resolve())
            for name in names
        ):
            raise Problem("Project definitions cannot be symbolic links", 422)
        return {
            name: decode(name, (path / name).read_bytes())
            for name in names
            if is_declarative(name) and (path / name).is_file()
        }

    def commit(
        self,
        path: str | Path,
        context: CommitContext = CommitContext.SAVE,
        *,
        message: str | None = None,
        assistant: str | None = None,
    ) -> str:
        with self._save_transaction(path):
            return self._commit(path, context, message=message, assistant=assistant)

    @contextmanager
    def _save_transaction(self, path: str | Path) -> Generator[None, None, None]:
        """Restore files, index and HEAD on failure while the caller holds the repository lock.

        Backups are prepared before changing anything, on each destination's filesystem.
        Rollback renames them into place rather than writing more data to a possibly full disk.
        """
        path = Path(path)

        def present(root: Path) -> set[str]:
            return {n for n in definition_names(root) if is_declarative(n) and (root / n).is_file()}

        original = present(path)
        head = self.git(path, "rev-parse", "--verify", "HEAD", check=False)
        index = Path(self.git(path, "rev-parse", "--absolute-git-dir")) / "index"
        with (
            tempfile.TemporaryDirectory(prefix=SAVE_BACKUPS, dir=path) as directory,
            tempfile.TemporaryDirectory(prefix="duckpad-index-", dir=index.parent) as git_directory,
        ):
            backup = Path(directory)
            for name in original:
                target = backup / name
                target.parent.mkdir(parents=True, exist_ok=True)
                # Symbolic links, which saves refuse, are kept as links rather than followed.
                shutil.copy2(path / name, target, follow_symlinks=False)
            saved_index = Path(git_directory) / "index"
            if index.exists():
                shutil.copy2(index, saved_index)
            try:
                yield
            except Exception:
                for name in present(path) - original:
                    (path / name).unlink(missing_ok=True)
                for name in original:
                    target = path / name
                    if not target.is_file() or target.read_bytes() != (backup / name).read_bytes():
                        (backup / name).replace(target)
                # A timeout can arrive after Git has already advanced the branch.
                latest = self.git(path, "rev-parse", "--verify", "HEAD", check=False)
                if latest != head:
                    if head:
                        self.git(path, "update-ref", "HEAD", head, latest)
                    else:
                        self.git(path, "update-ref", "-d", "HEAD", latest)
                if saved_index.exists():
                    saved_index.replace(index)
                else:
                    index.unlink(missing_ok=True)
                raise

    def _commit(
        self,
        path: str | Path,
        context: CommitContext = CommitContext.SAVE,
        *,
        message: str | None = None,
        assistant: str | None = None,
    ) -> str:
        tracked = self.git(path, "ls-files").splitlines()
        existing = self.read_files({"path": str(path)})
        head = self.git(path, "rev-parse", "--verify", "HEAD", check=False)
        previous_files = self.revision_files(path, head) if head else {}
        try:
            bundle = files_to_bundle(existing)
            previous = files_to_bundle(previous_files) if head else None
            if previous is not None:
                for name in owned_paths(previous) - owned_paths(bundle):
                    if name in existing:
                        (Path(path) / name).unlink(missing_ok=True)
                        existing.pop(name)
            before = dumps([bundle["documentation"], bundle.get("views")])
            reconcile_documentation(previous, bundle)
            if before != dumps([bundle["documentation"], bundle.get("views")]):
                reconciled = bundle_to_files(bundle)
                for name in ("documentation.json", "README.md", views.FILE):
                    if name in reconciled:
                        atomic_write(Path(path) / name, reconciled[name])
                existing = self.read_files({"path": str(path)})
        except Problem:
            # An unavailable schema or malformed definition is never a deletion.
            pass
        paths = sorted(
            {
                name
                for name in [*tracked, *existing, ".gitignore"]
                if name == ".gitignore" or is_declarative(name)
            }
        )
        if paths:
            self.git(path, "add", "-A", "--", *paths)
        if self.git(path, "diff", "--cached", "--name-only", "--", *paths):
            if message is None:
                message = commit_message(previous_files, self.read_files({"path": str(path)}), context)
            if assistant:
                message += "\n\nDuckpad-Assistant: " + assistant
            self.git(
                path,
                "commit",
                "--only",
                "-m",
                message,
                "--",
                *paths,
                identity=SYSTEM_IDENTITY if context is CommitContext.EXTERNAL else None,
            )
        return self.git(path, "rev-parse", "HEAD")

    def cached(
        self,
        cache: OrderedDict[tuple[str, str], CachedValue],
        key: tuple[str, str],
        value: CachedValue | None = None,
    ) -> CachedValue | None:
        """Read a bounded cache entry, or store one, evicting the least recently used."""
        with self.cache_lock:
            if value is None:
                value = cache.get(key)
            else:
                cache[key] = value
            if value is not None:
                cache.move_to_end(key)
                if len(cache) > CACHED_REVISIONS:
                    cache.popitem(last=False)
        return value

    def revision_files(self, path: str | Path, commit: str) -> Files:
        """Declarative files of a commit, read through git archive and cached by commit.

        A commit never changes, so callers need no repository lock.
        """
        key = (str(path), commit)
        files = self.cached(self.commit_files, key)
        if files is None:
            content = self.git(path, "archive", "--format=tar", commit, binary=True)
            with tarfile.open(fileobj=io.BytesIO(content)) as archive:
                files = {}
                for entry in archive:
                    if entry.isfile() and is_declarative(entry.name):
                        stream = archive.extractfile(entry)
                        assert stream is not None
                        files[entry.name] = decode(entry.name, stream.read())
            self.cached(self.commit_files, key, files)
        return dict(files)

    def snapshot(self, worktree_id: str, committed: bool = False) -> Record:
        """Files of a worktree with their revision, the base of a later save.

        Committed files are read without a lock. Working files are read under the repository
        lock, so they never mix two parts of a save. Revisions are kept in memory only.
        """
        if committed:
            worktree = self.get(worktree_id)
            commit = self.git(worktree["path"], "rev-parse", "HEAD")
            files = self.revision_files(worktree["path"], commit)
        else:
            with self.locked(worktree_id) as worktree:
                commit = self.git(worktree["path"], "rev-parse", "HEAD")
                files = self.read_files(worktree)
        revision = digest(files)
        self.cached(self.revisions, (worktree_id, revision), dict(files))
        key = (worktree_id, revision)
        definitions = self.cached(self.snapshot_definitions, key)
        if definitions is None:
            bundle, errors = diagnose(files)
            definitions = {"bundle": bundle, "node_names": node_names(bundle), "diagnostics": errors}
            self.cached(self.snapshot_definitions, key, definitions)
        return {
            "worktree": worktree,
            "revision": revision,
            "commit": commit,
            **copy.deepcopy(definitions),
            "files": files,
            "conflicts": [conflict_view(c) for c in self.store.conflicts(worktree_id)],
        }

    def base(self, worktree: Record, revision: str, current: Files) -> Files | None:
        """The files a save was edited from, or None when its revision is unknown.

        After a restart, a client still edits a committed snapshot of its branch.
        """
        if digest(current) == revision:
            return current
        files = self.cached(self.revisions, (worktree["id"], revision))
        if files is not None:
            return dict(files)
        path = worktree["path"]
        for commit in self.git(path, "rev-list", f"--max-count={BASE_SEARCH}", "HEAD").splitlines():
            files = self.revision_files(path, commit)
            if digest(files) == revision:
                return files
        return None

    def transform(
        self,
        worktree: str,
        revision: str,
        fn: Callable[[Record], tuple[Record, Record]],
        message: str,
        *,
        context: CommitContext = CommitContext.SAVE,
    ) -> Record:
        """Read, validate and transform one revision under the same repository lock."""
        with self.locked(worktree):
            snapshot = self.snapshot(worktree)
            if revision != snapshot["revision"]:
                raise Problem(message, 409)
            if snapshot["bundle"] is None:
                raise Problem("Project files are invalid", 422, snapshot["diagnostics"])
            bundle, metadata = fn(snapshot["bundle"])
            return {**self.write(worktree, revision, bundle_to_files(bundle), context), **metadata}

    def write(
        self,
        worktree_id: str,
        revision: str,
        proposal: Files,
        context: CommitContext = CommitContext.SAVE,
        *,
        message: str | None = None,
        validate: bool = False,
        assistant: str | None = None,
        relock: bool = True,
    ) -> Record:
        """Save a proposal; `relock=False` keeps its uv.lock for changes that leave dependencies alone."""
        # A rejected save writes nothing, not even part of the proposal.
        if not all(is_declarative(name) for name in proposal):
            raise Problem("Only declarative project files can be edited here")
        proposal = dict(proposal)
        record = self.get(worktree_id)
        self.writable(record)
        if relock:
            proposal = self._locked_dependencies(record, proposal)
        with self.locked(worktree_id) as worktree:
            self.writable(worktree)
            current = self.read_files(worktree)
            base = self.base(worktree, revision, current)
            if base is None:
                raise Problem("The editing revision is unavailable. Reload before saving.", 409)
            manifest_edited = proposal.get("pyproject.toml") != base.get("pyproject.toml")
            if not manifest_edited and current.get("pyproject.toml") != base.get("pyproject.toml"):
                # Another save changed the dependencies: this one keeps its base lock, so the
                # merge takes that save's manifest together with the lock resolved for it.
                if "uv.lock" in base:
                    proposal["uv.lock"] = base["uv.lock"]
                else:
                    proposal.pop("uv.lock", None)
            try:
                removed = owned_paths(files_to_bundle(base)) - owned_paths(files_to_bundle(proposal))
                for name in removed:
                    proposal.pop(name, None)
            except Problem:
                # Malformed graph edits cannot establish ownership changes.
                pass
            merged, paths = merge_files(base, current, proposal)
            if paths:
                if assistant:
                    # Choosing the incoming side must still preserve independent later edits.
                    proposal, _ = merge_files(
                        base, current, proposal, choices=dict.fromkeys(paths, "incoming"), evidence=[]
                    )
                conflict = {
                    "id": uid("conflict_"),
                    "worktree": worktree_id,
                    "base": base,
                    "current": current,
                    "proposal": proposal,
                    "paths": paths,
                    "revision": digest(current),
                    "created": now(),
                    "assistant": assistant,
                }
                self.store.put("conflict", conflict["id"], conflict)
                raise Problem("Concurrent edits conflict. Both versions have been retained.", 409, conflict)
            if (
                manifest_edited
                and merged.get("pyproject.toml") != proposal.get("pyproject.toml")
                and any(name.endswith(".py") for name in merged)
            ):
                raise Problem(
                    "Python dependencies changed concurrently. Reload and save to resolve the merged manifest.",
                    409,
                )

            merged = remember_contracts(merged)
            if validate:
                # Problems already saved, such as an input not connected yet, do not block the change.
                require_valid(merged, "The proposed changes are invalid", baseline=current)
            # Check before creating the transaction's untracked backup directory.
            external = self.git(worktree["path"], "status", "--porcelain")
            with self._save_transaction(worktree["path"]):
                # Retain the independent external save unit only if the whole save succeeds.
                if external:
                    self._commit(worktree["path"], CommitContext.EXTERNAL)
                previous = self.git(worktree["path"], "rev-parse", "--verify", "HEAD", check=False)
                self._write_files(worktree, merged, current)
                commit = self._commit(worktree["path"], context, message=message, assistant=assistant)
            self.observed[worktree_id] = self.read_files(worktree)
            self.pending.pop(worktree_id, None)
            self.on_change(worktree_id)
            # The commit of this save, which an undo reverts; None when it changed nothing.
            return {**self.snapshot(worktree_id), "change": commit if commit != previous else None}

    def revert(
        self,
        worktree_id: str,
        commit: str,
        before: str | None = None,
        *,
        validate: bool = False,
        assistant: str | None = None,
    ) -> Record:
        """Save the three-way inverse of a change, keeping later independent edits.

        The change goes from `before` (by default the parent of a commit of the branch)
        to `commit`. Reverting the commit of a revert redoes the original change.
        """
        path = self.get(worktree_id)["path"]
        if before is None:
            # Only commits of the branch itself are undone.
            if self.git(path, "merge-base", commit, "HEAD", check=False) != commit:
                raise Problem("This change is no longer part of the branch history", 409)
            before = self.git(path, "rev-parse", "--verify", "--quiet", commit + "^", check=False)
            if not before:
                raise Problem("The first commit of a project cannot be undone", 409)
        after = self.revision_files(path, commit)
        revision = digest(after)
        # The base of the inverse save, even when the commit is older than the revision cache.
        self.cached(self.revisions, (worktree_id, revision), after)
        return self.write(
            worktree_id, revision, self.revision_files(path, before), validate=validate, assistant=assistant
        )

    def _locked_dependencies(self, record: Record, proposal: Files) -> Files:
        """The proposal with a uv.lock resolved for its manifest; resolution runs before any lock."""
        policy = get_policy(self.store, record["project"])
        if not (policy.get("enabled") and any(name.endswith(".py") for name in proposal)):
            return proposal
        saved = self.read_files(record)
        lock = saved.get("uv.lock")
        if (
            lock
            and "<<<<<<<" not in lock
            and all(proposal.get(n) == saved.get(n) for n in ("pyproject.toml", "uv.lock"))
        ):
            # Untouched dependencies keep their lock; a launch reports a manifest this server cannot use.
            return proposal

        return {
            **proposal,
            "uv.lock": python_environment.lock_files(
                proposal,
                self.store.home,
                allow_builds=policy.get("allow_builds", False),
                project=record["project"],
            ),
        }

    def prune_column_documentation(
        self, worktree_id: str, node: str, columns: dict[str, list[str]], current: Callable[[Record], bool]
    ) -> None:
        """Remove the documentation of columns that a node's published outputs no longer have.

        `columns` lists the column names of each output port. `current(bundle)` tells whether
        those outputs still match the files; the documentation of an outdated result is kept.
        Component outputs that expose a port of the node are pruned with it.
        """
        with self.locked(worktree_id) as worktree:
            if worktree.get("read_only"):
                return
            snapshot = self.snapshot(worktree_id)
            bundle = snapshot["bundle"]
            if not bundle or not current(bundle):
                return
            documentation = bundle["documentation"].get("columns", {})
            schemas = {f"{node}:{port}": set(names) for port, names in columns.items()}
            try:
                _, _, boundaries = expand(bundle, tolerant=True)
                for parent, boundary in boundaries.items():
                    for port, target in boundary["outputs"].items():
                        if target[0] == node and target[1] in columns:
                            schemas[f"{parent}:{port}"] = schemas[f"{node}:{target[1]}"]
            except Problem:
                pass
            changed = False
            for key, names in schemas.items():
                if key in documentation:
                    pruned = {name: text for name, text in documentation[key].items() if name in names}
                    if pruned != documentation[key]:
                        documentation[key] = pruned
                        changed = True
            if changed:
                self.write(
                    worktree_id,
                    snapshot["revision"],
                    bundle_to_files(bundle),
                    message="docs(schema): remove documentation for removed columns",
                    relock=False,
                )

    def _write_files(self, worktree: Record, files: Files, previous: Files) -> None:
        """Write merged files, whose names come from the checked proposal and the project files."""
        path = Path(worktree["path"])
        for name in files.keys() | previous.keys():
            target = inside(path, name)
            if name in files:
                atomic_write(target, files[name])
            elif target.exists():
                target.unlink()

    def conflict(self, conflict_id: str) -> Record:
        conflict = self.store.get("conflict", conflict_id)
        if not conflict:
            raise Problem("Conflict not found", 404)
        return cast(Record, conflict)

    def resolve(self, conflict_id: str, choice: str, files: Files | None = None) -> Record:
        stored = self.conflict(conflict_id)
        if choice in ("current", "proposal", "combined") and (choice != "combined" or files is not None):
            # Resolve dependencies before the repository lock; the save below then reuses that lock.
            with suppress(Problem):
                self._locked_dependencies(
                    self.get(stored["worktree"]),
                    merge_files(
                        stored["base"],
                        stored["current"],
                        stored["proposal"],
                        choices=dict.fromkeys(
                            stored["paths"], "incoming" if choice == "proposal" else choice
                        ),
                        evidence=[],
                        resolutions=files if choice == "combined" else None,
                    )[0],
                )
        with self.locked(stored["worktree"]):
            # Read it again: another request may have resolved it while this one waited.
            conflict = self.conflict(conflict_id)
            snapshot = self.snapshot(conflict["worktree"])
            if snapshot["revision"] != conflict["revision"]:
                if conflict.get("assistant"):
                    _, paths = merge_files(conflict["current"], snapshot["files"], conflict["proposal"])
                    conflict["proposal"], _ = merge_files(
                        conflict["current"],
                        snapshot["files"],
                        conflict["proposal"],
                        choices=dict.fromkeys(paths, "incoming"),
                        evidence=[],
                    )
                conflict.update(current=snapshot["files"], revision=snapshot["revision"])
                _, conflict["paths"] = merge_files(
                    conflict["base"], conflict["current"], conflict["proposal"]
                )
                self.store.put("conflict", conflict_id, conflict)
                raise Problem(
                    "Files changed again. Review the refreshed conflict before resolving.", 409, conflict
                )
            if choice not in ("current", "proposal", "combined"):
                raise Problem("Choose current, proposal or combined")
            if choice == "combined" and files is None:
                raise Problem("Combined file contents are required")
            proposal, _ = merge_files(
                conflict["base"],
                conflict["current"],
                conflict["proposal"],
                choices=dict.fromkeys(conflict["paths"], "incoming" if choice == "proposal" else choice),
                evidence=[],
                resolutions=files if choice == "combined" else None,
            )
            result = self.write(
                conflict["worktree"],
                snapshot["revision"],
                proposal,
                CommitContext.RESOLUTION,
                validate=bool(conflict.get("assistant")),
                assistant=conflict.get("assistant"),
            )
            self.store.delete("conflict", conflict_id)
            result["conflicts"] = [c for c in result["conflicts"] if c["id"] != conflict_id]
            return result

    def flush(self, worktree_id: str) -> Record:
        with self.locked(worktree_id) as worktree:
            if worktree.get("read_only"):
                return self.snapshot(worktree_id, committed=True)
            previous = self.read_files(worktree)
            # A stable read precedes capture; file writers may still begin a new
            # save after capture, which is handled by the next watcher batch.
            for _ in range(10):
                time.sleep(0.015)
                current = self.read_files(worktree)
                if previous == current:
                    break
                previous = current
            else:
                raise Problem("Project files are changing continuously; retry once saves settle", 409)
            changed = current != self.observed.get(worktree_id)
            commit = self.commit(worktree["path"], CommitContext.EXTERNAL)
            self.observed[worktree_id] = self.revision_files(worktree["path"], commit)
            self.pending.pop(worktree_id, None)
            if changed:
                self.on_change(worktree_id)
            return self.snapshot(worktree_id, committed=True)

    def start_watcher(self) -> None:
        worktrees = self.store.all("worktree")
        # Finish cleanups interrupted after their records were deleted: the directories of
        # unrecorded worktrees are removed, and Git forgets them before it next opens a branch.
        recorded = {worktree["id"] for worktree in worktrees}
        for folder in self.store.paths.worktree_directories():
            for path in folder.glob("worktree_*"):
                if path.name not in recorded:
                    shutil.rmtree(path, ignore_errors=True)
        for worktree in worktrees:
            if worktree.get("read_only"):
                continue
            path = worktree["path"]
            try:
                if not Path(path).is_dir():
                    raise FileNotFoundError(f"No directory at {path}")
                # A process stopped during a save leaves its backups behind.
                for backup in Path(path).glob(SAVE_BACKUPS + "*"):
                    shutil.rmtree(backup, ignore_errors=True)
                head = self.git(path, "rev-parse", "HEAD")
                self.observed[worktree["id"]] = self.revision_files(path, head)
            except (OSError, Problem) as error:
                # The watcher skips unobserved worktrees, so one lost directory never stops the instance.
                logger.error("Worktree %s is unavailable and is not observed: %s", worktree["id"], error)

        def watch() -> None:
            while not self.stop_event.wait(WATCH_INTERVAL):
                for worktree in self.store.all("worktree"):
                    lock = self.repository(worktree["project"])
                    # A busy repository is observed on a later pass instead of delaying the others.
                    if not lock.acquire(blocking=False):
                        continue
                    try:
                        # Removal stops observation under this lock.
                        if worktree["id"] in self.observed:
                            self._observe(worktree)
                    except Exception:
                        # Keep watching other worktrees; the next save or run reports the error.
                        logger.warning("Cannot observe worktree %s", worktree["id"], exc_info=True)
                    finally:
                        lock.release()

        self.thread = threading.Thread(target=watch, name="duckpad-file-watcher", daemon=True)
        self.thread.start()

    def _observe(self, worktree: Record) -> None:
        """Commit a worktree's external edits once they have been quiet for QUIET_PERIOD."""
        if worktree.get("read_only"):
            return
        key = worktree["id"]
        current = self.read_files(worktree)
        if current != self.observed.get(key):
            self.observed[key] = current
            self.pending[key] = time.monotonic()
        if key in self.pending and time.monotonic() - self.pending[key] >= QUIET_PERIOD:
            self.commit(worktree["path"], CommitContext.EXTERNAL)
            del self.pending[key]
            self.on_change(key)

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join(2)

    def library(self, visible: Collection[str] | None = None) -> list[Record]:
        """Templates and components of every project's main branch, available for import."""
        items = []
        for project in self.store.all("project"):
            if visible is not None and project["id"] not in visible:
                continue
            snapshot = self.snapshot(project["main"], committed=True)
            bundle = snapshot["bundle"]
            if not bundle:
                continue
            for kind in ("templates", "components"):
                for identity, value in bundle[kind].items():
                    if kind == "templates":
                        try:
                            name = parse_template(value, "python" if identity.endswith(".py") else "sql")[
                                "label"
                            ]
                        except Problem:
                            continue
                    else:
                        name = value.get("name") if isinstance(value, dict) else None
                    items.append(
                        {
                            "project": project["id"],
                            "project_name": project["name"],
                            "kind": kind,
                            "id": identity,
                            "name": name or identity,
                            "worktree": project["main"],
                            "commit": snapshot["commit"],
                        }
                    )
        return items

    def branch(self, worktree_id: str, name: str, revision: str | None = None) -> Record:
        if revision:
            self.versioning.prevalidate(self.get(worktree_id)["path"], revision)
        with self.locked(worktree_id) as worktree:
            command.check_branch_name(worktree["path"], name)
            if self.git(
                worktree["path"], "rev-parse", "--verify", "--quiet", "refs/heads/" + name, check=False
            ):
                raise Problem(
                    "A branch with this name already exists. Choose another name.",
                    409,
                    {"code": "branch_exists"},
                )
            self.versioning.clean(worktree)
            ref = self.versioning.resolve(worktree["path"], revision or "HEAD")
            if not self.git(
                worktree["path"], "for-each-ref", "--format=%(refname)", "--contains", ref, "refs/heads/"
            ):
                self.versioning.validate_history(worktree["path"], ref)
                require_valid(
                    self.revision_files(worktree["path"], ref),
                    "Fix incoming project definitions before opening a branch",
                )
            return self.open_worktree(worktree, name, ref)
