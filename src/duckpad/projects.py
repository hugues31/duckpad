"""Readable project files, optimistic saves, external batching and Git worktrees."""

import io
import logging
import subprocess
import tarfile
import threading
import time
from collections import OrderedDict
from pathlib import Path

from .builtin_templates import BUILTINS
from .bundle import bundle_to_files, files_to_bundle, is_declarative, validate
from .comparison import commit_message
from .components import reconcile_documentation
from .git_workspace import GitWorkspace
from .merge import merge_files
from .remote import Remotes
from .templates import parse_template
from .util import Problem, atomic_write, digest, dumps, inside, now, uid

logger = logging.getLogger(__name__)

DEFAULT_IDENTITY = {"name": "Duckpad user", "email": "admin@duckpad.local"}
HISTORY_LENGTH = 100
# The watcher polls files every WATCH_INTERVAL and commits a batch after QUIET_PERIOD without changes.
WATCH_INTERVAL = 0.1
QUIET_PERIOD = 0.5
CACHED_REVISIONS = 256
EXTERNAL_SAVE = "feat(project): save external changes"


def decode(name, content):
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise Problem(f"{name} is not valid UTF-8 text", 422) from error


class Projects:
    def __init__(self, store):
        self.store = store
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.observed, self.pending = {}, {}
        self.commit_files = OrderedDict()
        self.on_change = lambda worktree: None
        self.thread = None
        self.versioning = GitWorkspace(self)
        self.remotes = Remotes(self.versioning)

    def identity(self):
        """The Git author recorded for UI and external saves."""
        return self.store.get("settings", "identity", DEFAULT_IDENTITY)

    def git(self, path, *args, check=True):
        identity = self.identity()
        command = [
            "git",
            "-c",
            f"user.name={identity['name']}",
            "-c",
            f"user.email={identity['email']}",
            "-C",
            str(path),
            *args,
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode and check:
            raise Problem(result.stderr.strip() or result.stdout.strip())
        return result.stdout.strip()

    def create(self, name, bundle=None):
        project_id, worktree_id = uid("project_"), uid("worktree_")
        path = self.store.home / "projects" / project_id
        path.mkdir(parents=True)
        self.git(path, "init", "-b", "main")
        atomic_write(path / ".gitignore", "data/\nexports/\n*.duckdb\n*.duckdb.wal\n")
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
        self.commit(path, "feat(project): create " + " ".join(name.split())[:64])
        project = {"id": project_id, "name": name, "main": worktree_id, "created": now()}
        worktree = {"id": worktree_id, "project": project_id, "branch": "main", "path": str(path)}
        self.store.put("project", project_id, project)
        self.store.put("worktree", worktree_id, worktree)
        self.observed[worktree_id] = self.read_files(worktree)
        return worktree

    def delete(self, project_id):
        import shutil

        with self.lock:
            worktrees = [w for w in self.store.all("worktree") if w["project"] == project_id]
            for worktree in worktrees:
                self.store.delete("worktree", worktree["id"])
                self.observed.pop(worktree["id"], None)
                self.pending.pop(worktree["id"], None)
            for kind in ("run", "conflict"):
                for record in self.store.all(kind):
                    if record.get("worktree") in {w["id"] for w in worktrees}:
                        self.store.delete(kind, record["id"])
            self.store.delete("project", project_id)
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
        names = ["flow.json", "documentation.json"]
        names += [
            str(p.relative_to(path))
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
                atomic_write(Path(path) / "documentation.json", dumps(bundle["documentation"]))
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
            self.git(path, "commit", "--only", "-m", message, "--", *paths)
        return self.git(path, "rev-parse", "HEAD")

    def revision_files(self, path, commit):
        """Declarative files of a commit, read through git archive and cached by commit."""
        key = (str(path), commit)
        if key not in self.commit_files:
            result = subprocess.run(
                ["git", "-C", str(path), "archive", "--format=tar", commit],
                capture_output=True,
                check=True,
            )
            with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
                files = {
                    entry.name: decode(entry.name, archive.extractfile(entry).read())
                    for entry in archive
                    if entry.isfile() and is_declarative(entry.name)
                }
            self.commit_files[key] = files
            if len(self.commit_files) > CACHED_REVISIONS:
                self.commit_files.popitem(last=False)
        self.commit_files.move_to_end(key)
        return dict(self.commit_files[key])

    def snapshot(self, worktree_id, committed=False):
        with self.lock:
            worktree = self.get(worktree_id)
            commit = self.git(worktree["path"], "rev-parse", "HEAD")
            files = self.revision_files(worktree["path"], commit) if committed else self.read_files(worktree)
            revision = digest(files)
            self.store.put("revision", worktree_id + ":" + revision, files)
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
                "conflicts": [c for c in self.store.all("conflict") if c["worktree"] == worktree_id],
            }

    def write(self, worktree_id, revision, proposal, message="feat(project): save workspace changes"):
        with self.lock:
            worktree = self.get(worktree_id)
            current = self.read_files(worktree)
            base = self.store.get("revision", worktree_id + ":" + revision)
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

    def resolve(self, conflict_id, choice, files=None):
        with self.lock:
            conflict = self.store.get("conflict", conflict_id)
            if not conflict:
                raise Problem("Conflict not found", 404)
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
        with self.lock:
            worktree = self.get(worktree_id)
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
                with self.lock:
                    for worktree in self.store.all("worktree"):
                        try:
                            self._observe(worktree)
                        except Exception:
                            # Keep watching other worktrees; the next save or run reports the error.
                            logger.warning("Cannot observe worktree %s", worktree["id"], exc_info=True)

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

    def history(self, worktree_id):
        path = self.get(worktree_id)["path"]
        log = self.git(path, "log", f"-{HISTORY_LENGTH}", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s")
        return [
            dict(zip(("commit", "author", "email", "date", "message"), line.split("\x1f", 4), strict=True))
            for line in log.splitlines()
        ]

    def diff(self, worktree_id, commit):
        path = self.get(worktree_id)["path"]
        resolved = self.git(path, "rev-parse", "--verify", "--end-of-options", f"{commit}^{{commit}}")
        return self.git(path, "show", "--format=fuller", resolved, "--")

    def branch(self, worktree_id, name, revision=None):
        with self.lock:
            worktree = self.get(worktree_id)
            self.versioning.clean(worktree)
            self.git(worktree["path"], "check-ref-format", "refs/heads/" + name)
            key = uid("worktree_")
            path = self.store.home / "worktrees" / key
            path.parent.mkdir(parents=True, exist_ok=True)
            ref = self.git(
                worktree["path"],
                "rev-parse",
                "--verify",
                "--end-of-options",
                f"{revision or 'HEAD'}^{{commit}}",
            )
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

    def merge_preview(self, worktree_id):
        """Compatibility for local callers; all applications still require the frozen review."""
        source = self.get(worktree_id)
        project = self.store.get("project", source["project"])
        review = self.versioning.prepare(project["main"], "refs/heads/" + source["branch"])
        return {**review, "source_revision": review["id"], "target_revision": review["target_head"]}

    def merge(self, worktree_id, source_revision, target_revision, files):
        source = self.get(worktree_id)
        project = self.store.get("project", source["project"])
        review = self.versioning.review(project["main"], source_revision)
        if review["target_head"] != target_revision or review["source_worktree"] != worktree_id:
            raise Problem("Branches changed; compare again before merging", 409)
        return self.versioning.apply(project["main"], source_revision, {}, digest(files))
