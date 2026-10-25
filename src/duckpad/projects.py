"""Readable project files, optimistic saves, external batching and Git worktrees."""

import io
import json
import re
import subprocess
import tarfile
import threading
import time
from pathlib import Path

from .components import expand, reconcile_documentation
from .templates import BUILTINS, parse_template
from .util import Problem, atomic_write, digest, dumps, inside, now, uid

MISSING = object()


def merge_values(base, current, proposed, path=""):
    """Three-way merge logical fields; arrays with stable IDs merge by identity."""
    if current == proposed or proposed == base:
        return current, []
    if current == base:
        return proposed, []
    if all(isinstance(v, dict) for v in (base, current, proposed)):
        result, conflicts = {}, []
        for key in base.keys() | current.keys() | proposed.keys():
            value, errors = merge_values(
                base.get(key, MISSING),
                current.get(key, MISSING),
                proposed.get(key, MISSING),
                path + "/" + key,
            )
            if value is not MISSING:
                result[key] = value
            conflicts.extend(errors)
        return result, conflicts
    if all(
        isinstance(v, list) and all(isinstance(x, dict) and "id" in x for x in v)
        for v in (base, current, proposed)
    ):
        mappings = [{x["id"]: x for x in v} for v in (base, current, proposed)]
        result, conflicts = merge_values(*mappings, path)
        order = list(dict.fromkeys([x["id"] for x in current + proposed]))
        return [result[k] for k in order if k in result], conflicts
    return current, [path or "/"]


def merge_files(base, current, proposal):
    result, conflicts = {}, []
    for name in base.keys() | current.keys() | proposal.keys():
        values = [v.get(name, MISSING) for v in (base, current, proposal)]
        try:
            if name.endswith(".json") and all(v is not MISSING for v in values):
                merged, errors = merge_values(*(json.loads(v) for v in values), name)
                content = dumps(merged)
            else:
                content, errors = merge_values(*values, name)
        except (ValueError, TypeError):
            content, errors = merge_values(*values, name)
        if content is not MISSING:
            result[name] = content
        conflicts.extend(errors)
    return result, conflicts


def files_to_bundle(files):
    try:
        return {
            "flow": json.loads(files["flow.json"]),
            "templates": {
                Path(n).stem: text
                for n, text in files.items()
                if n.startswith("templates/") and n.endswith(".sql")
            },
            "components": {
                Path(n).stem: json.loads(text)
                for n, text in files.items()
                if n.startswith("components/") and n.endswith(".json")
            },
            "documentation": json.loads(files.get("documentation.json", "{}")),
        }
    except (ValueError, KeyError) as error:
        raise Problem(f"Cannot read declarative project files: {error}") from error


def bundle_to_files(bundle):
    return {
        "flow.json": dumps(bundle["flow"]),
        "documentation.json": dumps(bundle.get("documentation", {})),
        **{f"templates/{key}.sql": value for key, value in bundle.get("templates", {}).items()},
        **{f"components/{key}.json": dumps(value) for key, value in bundle.get("components", {}).items()},
    }


def validate(bundle):
    errors = []
    for name, sql in bundle["templates"].items():
        try:
            parse_template(sql)
        except Exception as error:
            errors.append({"file": f"templates/{name}.sql", "message": str(error)})
    try:
        nodes, edges, _ = expand(bundle)
        identifiers = [n["id"] for n in bundle["flow"].get("nodes", [])]
        if len(set(identifiers)) != len(identifiers):
            raise Problem("Node identifiers must be unique")
        seen_inputs = set()
        for edge in edges:
            key = (edge["target"], edge["targetHandle"])
            if key in seen_inputs:
                raise Problem(f"Input {key[0]}.{key[1]} has more than one source")
            seen_inputs.add(key)
        for node in nodes.values():
            for port in node["parsed"]["inputs"]:
                if (node["id"], port) not in seen_inputs:
                    errors.append(
                        {
                            "file": "flow.json",
                            "node": node["id"],
                            "message": f"Connect input '{port}' on {node.get('label', node['id'])}",
                        }
                    )
        topological(nodes, edges)
    except Exception as error:
        errors.append({"file": "flow.json", "message": str(error)})
    return errors


def topological(nodes, edges, tolerant=False):
    dependencies = {n: {e["source"] for e in edges if e["target"] == n} for n in nodes}
    ordered = []
    while dependencies:
        ready = [key for key, values in dependencies.items() if not values]
        if not ready:
            if not tolerant:
                raise Problem("The graph contains a cycle")
            for key in dependencies:
                nodes[key]["error"] = "This node is part of, or depends on, a graph cycle"
            ordered.extend(dependencies)
            break
        for key in ready:
            ordered.append(key)
            del dependencies[key]
        for values in dependencies.values():
            values.difference_update(ready)
    return ordered


def computational(bundle):
    """Strip descriptive metadata without dropping executable interfaces."""
    ignored = {"label", "name", "description", "documentation", "position", "selected", "origin"}

    def strip(value):
        if isinstance(value, dict):
            return {k: strip(v) for k, v in value.items() if k not in ignored}
        if isinstance(value, list):
            return [strip(v) for v in value]
        return value

    result = strip({"flow": bundle["flow"], "components": bundle["components"]})
    result["templates"] = {
        key: "\n".join(
            line for line in sql.splitlines() if not line.strip().startswith(("-- @label", "-- @description"))
        )
        for key, sql in bundle["templates"].items()
    }
    return result


class Projects:
    def __init__(self, store):
        self.store = store
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.observed, self.pending = {}, {}
        self.commit_files = {}
        self.on_change = lambda worktree: None
        self.thread = None

    def git(self, path, *args, check=True):
        identity = self.store.get(
            "settings", "identity", {"name": "Duckpad user", "email": "admin@duckpad.local"}
        )
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
        self.commit(path, "feat(project): create workspace")
        project = {"id": project_id, "name": name, "main": worktree_id, "created": now()}
        worktree = {"id": worktree_id, "project": project_id, "branch": "main", "path": str(path)}
        self.store.put("project", project_id, project)
        self.store.put("worktree", worktree_id, worktree)
        self.observed[worktree_id] = self.read_files(worktree)
        return worktree

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
        return {name: (path / name).read_text() for name in names if (path / name).is_file()}

    def commit(self, path, message):
        tracked = self.git(path, "ls-files").splitlines()
        existing = self.read_files({"path": str(path)})
        try:
            bundle = files_to_bundle(existing)
            head = self.git(path, "rev-parse", "--verify", "HEAD", check=False)
            previous = (
                files_to_bundle(self.revision_files({"id": str(path), "path": str(path)}, head))
                if head
                else None
            )
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
                if name in ("flow.json", "documentation.json", ".gitignore")
                or re.fullmatch(r"templates/[A-Za-z0-9_-]+\.sql|components/[A-Za-z0-9_-]+\.json", name)
            }
        )
        if paths:
            self.git(path, "add", "-A", "--", *paths)
        if self.git(path, "diff", "--cached", "--name-only"):
            self.git(path, "commit", "-m", message)
        return self.git(path, "rev-parse", "HEAD")

    def revision_files(self, worktree, commit):
        key = (worktree["id"], commit)
        if key not in self.commit_files:
            result = subprocess.run(
                ["git", "-C", worktree["path"], "archive", "--format=tar", commit],
                capture_output=True,
                check=True,
            )
            with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
                files = {
                    entry.name: archive.extractfile(entry).read().decode()
                    for entry in archive
                    if entry.isfile()
                    and (
                        entry.name in ("flow.json", "documentation.json")
                        or re.fullmatch(
                            r"templates/[A-Za-z0-9_-]+\.sql|components/[A-Za-z0-9_-]+\.json", entry.name
                        )
                    )
                }
            self.commit_files[key] = files
        return dict(self.commit_files[key])

    def snapshot(self, worktree_id, committed=False):
        with self.lock:
            worktree = self.get(worktree_id)
            commit = self.git(worktree["path"], "rev-parse", "HEAD")
            files = self.revision_files(worktree, commit) if committed else self.read_files(worktree)
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
                self.commit(worktree["path"], "feat(project): save external changes")
            self._write_files(worktree, merged, current)
            self.commit(worktree["path"], message)
            self.observed[worktree_id] = self.read_files(worktree)
            self.pending.pop(worktree_id, None)
            self.on_change(worktree_id)
            return self.snapshot(worktree_id)

    def _write_files(self, worktree, files, previous):
        path = Path(worktree["path"])
        for name in files.keys() | previous.keys():
            if not (
                name in ("flow.json", "documentation.json")
                or re.fullmatch(r"templates/[A-Za-z0-9_-]+\.sql|components/[A-Za-z0-9_-]+\.json", name)
            ):
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
            proposal = (
                conflict["current"]
                if choice == "current"
                else conflict["proposal"]
                if choice == "proposal"
                else files
            )
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
            commit = self.commit(worktree["path"], "feat(project): save external changes")
            self.observed[worktree_id] = self.revision_files(worktree, commit)
            self.pending.pop(worktree_id, None)
            if changed:
                self.on_change(worktree_id)
            return self.snapshot(worktree_id, committed=True)

    def start_watcher(self):
        for worktree in self.store.all("worktree"):
            head = self.git(worktree["path"], "rev-parse", "HEAD")
            self.observed[worktree["id"]] = self.revision_files(worktree, head)

        def watch():
            while not self.stop_event.wait(0.1):
                with self.lock:
                    for worktree in self.store.all("worktree"):
                        try:
                            key = worktree["id"]
                            current = self.read_files(worktree)
                            if current != self.observed.get(key):
                                self.observed[key] = current
                                self.pending[key] = time.monotonic()
                            if key in self.pending and time.monotonic() - self.pending[key] >= 0.5:
                                self.commit(worktree["path"], "feat(project): save external changes")
                                del self.pending[key]
                                self.on_change(key)
                        except (OSError, Problem) as error:
                            self.store.put("watcher_error", worktree["id"], {"message": str(error)})

        self.thread = threading.Thread(target=watch, name="duckpad-file-watcher", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(2)

    def history(self, worktree_id):
        path = self.get(worktree_id)["path"]
        log = self.git(path, "log", "-100", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s")
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
            self.flush(worktree_id)
            self.git(worktree["path"], "check-ref-format", "--branch", name)
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
            self.git(worktree["path"], "worktree", "add", "-b", name, str(path), ref)
            result = {"id": key, "project": worktree["project"], "branch": name, "path": str(path)}
            self.store.put("worktree", key, result)
            self.observed[key] = self.read_files(result)
            return result

    def merge_preview(self, worktree_id):
        source = self.get(worktree_id)
        project = self.store.get("project", source["project"])
        target = self.get(project["main"])
        if source["id"] == target["id"]:
            raise Problem("Open a working branch to merge into main")
        self.flush(source["id"])
        self.flush(target["id"])
        base = self.git(target["path"], "merge-base", "HEAD", source["branch"])
        names = self.git(target["path"], "ls-tree", "-r", "--name-only", base).splitlines()
        base_files = {
            n: self.git(target["path"], "show", f"{base}:{n}") + "\n"
            for n in names
            if n in ("flow.json", "documentation.json") or n.startswith(("templates/", "components/"))
        }
        current, proposed = self.read_files(target), self.read_files(source)
        merged, conflicts = merge_files(base_files, current, proposed)
        return {
            "source": source,
            "target": target,
            "source_revision": digest(proposed),
            "target_revision": digest(current),
            "base": base_files,
            "current": current,
            "proposal": proposed,
            "files": merged,
            "conflicts": conflicts,
            "diff": self.git(target["path"], "diff", "HEAD..." + source["branch"]),
        }

    def merge(self, worktree_id, source_revision, target_revision, files):
        with self.lock:
            preview = self.merge_preview(worktree_id)
            if preview["source_revision"] != source_revision or preview["target_revision"] != target_revision:
                raise Problem("Branches changed; compare again before merging", 409)
            errors = validate(files_to_bundle(files))
            if errors:
                raise Problem("Fix validation errors before merging", 422, errors)
            target = preview["target"]
            path = target["path"]
            source_commit = self.git(preview["source"]["path"], "rev-parse", "HEAD")
            self.git(path, "merge", "--no-commit", "--no-ff", source_commit, check=False)
            self._write_files(target, files, self.read_files(target))
            self.commit(path, f"feat(project): merge {preview['source']['branch']} into main")
            self.observed[target["id"]] = self.read_files(target)
            self.on_change(target["id"])
            return self.snapshot(target["id"])
