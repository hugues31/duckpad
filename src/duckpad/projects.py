"""Readable project files, optimistic saves, external batching and Git worktrees."""

import io
import logging
import shutil
import tarfile
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path

from . import git_command
from .builtin_templates import BUILTINS
from .bundle import ROOT_FILES, bundle_to_files, files_to_bundle, is_declarative, validate
from .comparison import commit_message
from .components import reconcile_documentation
from .git_workspace import GitWorkspace
from .identity import SYSTEM_IDENTITY, current_identity
from .merge import merge_files
from .remote import Remotes
from .templates import parse_template
from .util import Problem, atomic_write, digest, dumps, inside, now, uid

logger = logging.getLogger(__name__)

# The watcher polls files every WATCH_INTERVAL and commits a batch after QUIET_PERIOD without changes.
WATCH_INTERVAL = 0.1
QUIET_PERIOD = 0.5
CACHED_REVISIONS = 256
# After a restart, the base of a save is searched in this many latest commits of its branch.
BASE_SEARCH = 32
EXTERNAL_SAVE = "feat(project): save external changes"


def decode(name, content):
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise Problem(f"{name} is not valid UTF-8 text", 422) from error


class Projects:
    def __init__(self, store):
        self.store = store
        self.locks, self.locks_guard = {}, threading.Lock()
        # Guards the bounded caches, which requests read without a repository lock.
        self.cache_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.observed, self.pending = {}, {}
        self.commit_files, self.revisions = OrderedDict(), OrderedDict()
        self.on_change = lambda worktree: None
        self.thread = None
        self.versioning = GitWorkspace(self)
        self.remotes = Remotes(self.versioning)

    def repository(self, project_id):
        """The lock serializing changes to one project's Git repository and all its worktrees.

        Network Git and history validation run outside it. Nothing holds two repository locks,
        and a repository lock is always taken before the engine lock.
        """
        with self.locks_guard:
            return self.locks.setdefault(project_id, threading.RLock())

    @contextmanager
    def locked(self, worktree_id):
        """Hold the repository lock of a worktree's project; yield the worktree read under it."""
        with self.repository(self.get(worktree_id)["project"]):
            yield self.get(worktree_id)

    def identity(self):
        """The request's account, or the system for changes made outside a request."""
        return current_identity.get() or SYSTEM_IDENTITY

    def git(self, path, *args, identity=None, **options):
        """Run Git as the request's account; see git_command.run for the options."""
        return git_command.run(path, *args, identity=identity or self.identity(), **options)

    def create(self, name, bundle=None, action="create"):
        project_id, worktree_id = uid("project_"), uid("worktree_")
        path = self.store.home / "projects" / project_id
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
            self.commit(path, f"feat(project): {action} " + " ".join(name.split())[:64])
            project = {"id": project_id, "name": name, "main": worktree_id, "created": now()}
            worktree = {"id": worktree_id, "project": project_id, "branch": "main", "path": str(path)}
            with self.store.transaction():
                self.store.put("project", project_id, project)
                self.store.put("worktree", worktree_id, worktree)
        except Exception:
            # A project is either recorded with its repository or leaves nothing behind.
            shutil.rmtree(path, ignore_errors=True)
            raise
        self.observed[worktree_id] = self.read_files(worktree)
        return worktree

    def delete(self, project_id):
        with self.repository(project_id):
            worktrees = self.store.worktrees(project_id)
            artifacts = self.store.artifact_ids(project=project_id)
            self.store.delete("project", project_id)
            for identity in artifacts:
                (self.store.home / "artifacts" / identity).unlink(missing_ok=True)
            for worktree in worktrees:
                self.observed.pop(worktree["id"], None)
                self.pending.pop(worktree["id"], None)
            for worktree in worktrees:
                shutil.rmtree(worktree["path"], ignore_errors=True)
                shutil.rmtree(self.store.home / "exports" / worktree["id"], ignore_errors=True)
            shutil.rmtree(self.store.home / "resources" / project_id, ignore_errors=True)

    def get(self, worktree_id):
        result = self.store.get("worktree", worktree_id)
        if not result:
            raise Problem("Worktree not found", 404)
        return result

    def read_files(self, worktree):
        path = Path(worktree["path"])
        names = list(ROOT_FILES)
        names += [
            p.relative_to(path).as_posix()
            for folder, pattern in [("templates", "*.sql"), ("components", "*.json")]
            for p in sorted((path / folder).glob(pattern))
        ]
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

    def commit(self, path, message):
        tracked = self.git(path, "ls-files").splitlines()
        existing = self.read_files({"path": str(path)})
        head = self.git(path, "rev-parse", "--verify", "HEAD", check=False)
        previous_files = self.revision_files(path, head) if head else {}
        try:
            bundle = files_to_bundle(existing)
            head = self.git(path, "rev-parse", "--verify", "HEAD", check=False)
            previous = files_to_bundle(self.revision_files(path, head)) if head else None
            before = dumps(bundle["documentation"])
            reconcile_documentation(previous, bundle)
            if before != dumps(bundle["documentation"]):
                reconciled = bundle_to_files(bundle)
                for name in ("documentation.json", "README.md"):
                    atomic_write(Path(path) / name, reconciled[name])
                existing = self.read_files({"path": str(path)})
        except (Problem, KeyError, TypeError, AttributeError):
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
            context = (
                "external"
                if message == EXTERNAL_SAVE
                else "resolution"
                if "resolve concurrent" in message
                else "import"
                if "import" in message
                else ""
            )
            if head:
                message = commit_message(previous_files, self.read_files({"path": str(path)}), context)
            self.git(
                path,
                "commit",
                "--only",
                "-m",
                message,
                "--",
                *paths,
                identity=SYSTEM_IDENTITY if context == "external" else None,
            )
        return self.git(path, "rev-parse", "HEAD")

    def cached(self, cache, key, value=None):
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

    def revision_files(self, path, commit):
        """Declarative files of a commit, read through git archive and cached by commit.

        A commit never changes, so callers need no repository lock.
        """
        key = (str(path), commit)
        files = self.cached(self.commit_files, key)
        if files is None:
            content = self.git(path, "archive", "--format=tar", commit, binary=True)
            with tarfile.open(fileobj=io.BytesIO(content)) as archive:
                files = {
                    entry.name: decode(entry.name, archive.extractfile(entry).read())
                    for entry in archive
                    if entry.isfile() and is_declarative(entry.name)
                }
            self.cached(self.commit_files, key, files)
        return dict(files)

    def snapshot(self, worktree_id, committed=False):
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
        try:
            bundle = files_to_bundle(files)
            errors = validate(bundle)
        except Problem as error:
            bundle, errors = None, [{"file": "flow.json", "message": str(error)}]
        return {
            "worktree": worktree,
            "revision": revision,
            "commit": commit,
            "bundle": bundle,
            "files": files,
            "diagnostics": errors,
            "conflicts": self.store.conflicts(worktree_id),
        }

    def base(self, worktree, revision, current):
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

    def write(self, worktree_id, revision, proposal, message="feat(project): save workspace changes"):
        with self.locked(worktree_id) as worktree:
            current = self.read_files(worktree)
            base = self.base(worktree, revision, current)
            if base is None:
                raise Problem("The editing revision is unavailable. Reload before saving.", 409)
            merged, paths = merge_files(base, current, proposal)
            if paths:
                conflict = {
                    "id": uid("conflict_"),
                    "worktree": worktree_id,
                    "base": base,
                    "current": current,
                    "proposal": proposal,
                    "paths": paths,
                    "revision": digest(current),
                    "created": now(),
                }
                self.store.put("conflict", conflict["id"], conflict)
                raise Problem("Concurrent edits conflict. Both versions have been retained.", 409, conflict)
            # Finalize the independent external save unit before the UI action.
            if self.git(worktree["path"], "status", "--porcelain"):
                self.commit(worktree["path"], EXTERNAL_SAVE)
            self._write_files(worktree, merged, current)
            self.commit(worktree["path"], message)
            self.observed[worktree_id] = self.read_files(worktree)
            self.pending.pop(worktree_id, None)
            self.on_change(worktree_id)
            return self.snapshot(worktree_id)

    def _write_files(self, worktree, files, previous):
        path = Path(worktree["path"])
        for name in files.keys() | previous.keys():
            if not is_declarative(name):
                raise Problem("Only declarative project files can be edited here")
            target = inside(path, name)
            if name in files:
                atomic_write(target, files[name])
            elif target.exists():
                target.unlink()

    def conflict(self, conflict_id):
        conflict = self.store.get("conflict", conflict_id)
        if not conflict:
            raise Problem("Conflict not found", 404)
        return conflict

    def resolve(self, conflict_id, choice, files=None):
        with self.locked(self.conflict(conflict_id)["worktree"]):
            # Read it again: another request may have resolved it while this one waited.
            conflict = self.conflict(conflict_id)
            snapshot = self.snapshot(conflict["worktree"])
            if snapshot["revision"] != conflict["revision"]:
                conflict.update(current=snapshot["files"], revision=snapshot["revision"])
                self.store.put("conflict", conflict_id, conflict)
                raise Problem(
                    "Files changed again. Review the refreshed conflict before resolving.", 409, conflict
                )
            proposal = {"current": conflict["current"], "proposal": conflict["proposal"]}.get(choice, files)
            if proposal is None:
                raise Problem("Combined file contents are required")
            result = self.write(
                conflict["worktree"], snapshot["revision"], proposal, "fix(project): resolve concurrent edits"
            )
            self.store.delete("conflict", conflict_id)
            result["conflicts"] = [c for c in result["conflicts"] if c["id"] != conflict_id]
            return result

    def flush(self, worktree_id):
        with self.locked(worktree_id) as worktree:
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
            commit = self.commit(worktree["path"], EXTERNAL_SAVE)
            self.observed[worktree_id] = self.revision_files(worktree["path"], commit)
            self.pending.pop(worktree_id, None)
            if changed:
                self.on_change(worktree_id)
            return self.snapshot(worktree_id, committed=True)

    def start_watcher(self):
        for worktree in self.store.all("worktree"):
            head = self.git(worktree["path"], "rev-parse", "HEAD")
            self.observed[worktree["id"]] = self.revision_files(worktree["path"], head)

        def watch():
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

    def _observe(self, worktree):
        """Commit a worktree's external edits once they have been quiet for QUIET_PERIOD."""
        key = worktree["id"]
        current = self.read_files(worktree)
        if current != self.observed.get(key):
            self.observed[key] = current
            self.pending[key] = time.monotonic()
        if key in self.pending and time.monotonic() - self.pending[key] >= QUIET_PERIOD:
            self.commit(worktree["path"], EXTERNAL_SAVE)
            del self.pending[key]
            self.on_change(key)

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(2)

    def library(self, visible=None):
        """Templates and components of every project's main branch, available for import."""
        items = []
        for project in self.store.all("project"):
            if visible is not None and project["id"] not in visible:
                continue
            snapshot = self.snapshot(project["main"])
            bundle = snapshot["bundle"]
            if not bundle:
                continue
            for kind in ("templates", "components"):
                for identity, value in bundle[kind].items():
                    if kind == "templates":
                        try:
                            name = parse_template(value)["label"]
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

    def branch(self, worktree_id, name, revision=None):
        if revision:
            self.versioning.prevalidate(self.get(worktree_id)["path"], revision)
        with self.locked(worktree_id) as worktree:
            git_command.check_branch_name(worktree["path"], name)
            if self.git(
                worktree["path"], "rev-parse", "--verify", "--quiet", "refs/heads/" + name, check=False
            ):
                raise Problem(
                    "A branch with this name already exists. Choose another name.",
                    409,
                    {"code": "branch_exists"},
                )
            self.versioning.clean(worktree)
            key = uid("worktree_")
            path = self.store.home / "worktrees" / key
            path.parent.mkdir(parents=True, exist_ok=True)
            ref = self.versioning.resolve(worktree["path"], revision or "HEAD")
            if not self.git(
                worktree["path"], "for-each-ref", "--format=%(refname)", "--contains", ref, "refs/heads/"
            ):
                self.versioning.validate_history(worktree["path"], ref)
                try:
                    errors = validate(files_to_bundle(self.revision_files(worktree["path"], ref)))
                except (Problem, KeyError, TypeError, AttributeError) as error:
                    raise Problem("Incoming project definitions are invalid", 422) from error
                if errors:
                    raise Problem("Fix incoming project definitions before opening a branch", 422, errors)
            self.git(worktree["path"], "worktree", "add", "-b", name, str(path), ref)
            result = {"id": key, "project": worktree["project"], "branch": name, "path": str(path)}
            self.store.put("worktree", key, result)
            self.observed[key] = self.read_files(result)
            return result
