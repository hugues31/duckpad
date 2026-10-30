"""Frozen comparisons and reviewed Git integration for project repositories."""

import tempfile
import threading
from collections import OrderedDict
from contextlib import suppress
from pathlib import Path

from . import git_command
from .bundle import files_to_bundle, is_declarative, validate
from .comparison import compare_files
from .git_command import GitError
from .merge import merge_files
from .util import Problem, digest, now, uid

MAX_REPORTS = 128
MAX_HISTORY = 10000


def diagnose(files):
    """The bundle of project files and its validation errors; malformed definitions are errors."""
    try:
        bundle = files_to_bundle(files)
        return bundle, validate(bundle)
    except (Problem, KeyError, TypeError, AttributeError) as error:
        return None, [{"file": "flow.json", "message": str(error)}]


def require_valid(files, message):
    """Reject project files that cannot be adopted, with their validation errors."""
    _, errors = diagnose(files)
    if errors:
        raise Problem(message, 422, errors)


class GitWorkspace:
    def __init__(self, projects):
        self.projects = projects
        self.store = projects.store
        self.git = projects.git
        self.frozen = OrderedDict()
        self.reviews = OrderedDict()
        # Requests on different repositories record reports concurrently.
        self.reports_lock = threading.Lock()
        # Validation outcomes per commit, which is immutable: accepted histories, and the error of
        # each rejected head and offending commit.
        self.safe_heads = set()
        self.rejected = OrderedDict()

    def remember(self, cache, key, value):
        with self.reports_lock:
            cache[key] = value
            while len(cache) > MAX_REPORTS:
                cache.popitem(last=False)
        return value

    def resolve(self, path, ref):
        if not ref or ref.startswith("-") or len(ref) > 256:
            raise Problem("Choose a branch or commit")
        commit = self.git(
            path, "rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}", check=False
        )
        if not commit:
            raise Problem("Branch or commit not found. Choose an existing branch or commit.", 404)
        return commit

    def metadata(self, path, commit, name=None):
        text = self.git(path, "show", "-s", "--format=%H%x1f%an%x1f%aI%x1f%P%x1f%s", commit, "--")
        value = dict(
            zip(("commit", "author", "date", "parents", "message"), text.split("\x1f", 4), strict=True)
        )
        return {**value, "parents": value["parents"].split(), "ref": commit, "name": name or commit[:8]}

    def revision(self, worktree, ref):
        path = worktree["path"]
        if ref == "empty":
            return {"ref": "empty", "name": "Empty tree", "commit": None, "parents": [], "files": {}}
        if ref.startswith("frozen_"):
            frozen = self.frozen.get(ref)
            if not frozen or frozen["worktree"] != worktree["id"]:
                raise Problem("Frozen working state expired. Select Working files to capture it again.", 409)
            return frozen
        if ref == "working":
            head = self.resolve(path, "HEAD")
            files = self.projects.read_files(worktree)
            # A comparison never asks the watcher to flush or records a revision in the database.
            if files != self.projects.read_files(worktree) or head != self.resolve(path, "HEAD"):
                raise Problem("Working files changed during capture. Retry the same comparison.", 409)
            key = uid("frozen_")
            return self.remember(
                self.frozen,
                key,
                {
                    **self.metadata(path, head, worktree["branch"]),
                    "ref": key,
                    "name": "Frozen working files",
                    "captured": now(),
                    "worktree": worktree["id"],
                    "files": files,
                    "revision": digest(files),
                },
            )
        commit = self.resolve(path, ref)
        return {**self.metadata(path, commit, ref), "files": self.projects.revision_files(path, commit)}

    def compare(self, worktree_id, reference, target):
        with self.projects.locked(worktree_id) as worktree:
            a, b = (self.revision(worktree, ref) for ref in (reference, target))
            return {
                "a": {k: v for k, v in a.items() if k != "files"},
                "b": {k: v for k, v in b.items() if k != "files"},
                **compare_files(a["files"], b["files"]),
            }

    def history(self, worktree_id, ref="HEAD", offset=0, limit=50, entity=None):
        worktree = self.projects.get(worktree_id)
        path = worktree["path"]
        head = self.resolve(path, ref)
        limit = min(max(limit, 1), 100)
        commits = self.git(
            path, "rev-list", f"--skip={max(offset, 0)}", f"--max-count={limit + 1}", head, "--"
        ).splitlines()
        items = []
        for commit in commits[:limit]:
            metadata = self.metadata(path, commit)
            if entity:
                parents = metadata["parents"] or [None]
                if not any(
                    any(
                        c["id"] == entity and c["status"] != "unchanged"
                        for c in compare_files(
                            self.projects.revision_files(path, parent) if parent else {},
                            self.projects.revision_files(path, commit),
                            impact=False,
                        )["entities"]
                    )
                    for parent in parents
                ):
                    continue
            items.append(metadata)
        return {"items": items, "head": head, "next": offset + limit if len(commits) > limit else None}

    def clean(self, worktree):
        if (
            self.git(worktree["path"], "symbolic-ref", "-q", "HEAD", check=False)
            != "refs/heads/" + worktree["branch"]
        ):
            raise Problem(
                "The worktree branch changed outside Duckpad. Restore its assigned branch before integration.",
                409,
            )
        head = self.resolve(worktree["path"], "HEAD")
        files = self.projects.read_files(worktree)
        if (
            files != self.projects.revision_files(worktree["path"], head)
            or worktree["id"] in self.projects.pending
        ):
            raise Problem(
                "Pending external saves: wait for automatic versioning, then reload the review.", 409
            )
        if self.git(worktree["path"], "diff", "--cached", "--name-only") or self.git(
            worktree["path"], "diff", "--name-only"
        ):
            raise Problem("This worktree has pending Git edits. Save them before integration.", 409)
        if self.store.has_conflicts(worktree["id"]):
            raise Problem("Resolve concurrent editing conflicts before integration.", 409)
        return head, files

    def branches(self, worktree_id):
        worktree = self.projects.get(worktree_id)
        trees = {w["branch"]: w for w in self.store.worktrees(worktree["project"])}
        rows = self.git(
            worktree["path"],
            "for-each-ref",
            "--format=%(refname)%09%(objectname)",
            "refs/heads",
            "refs/remotes/origin",
        ).splitlines()
        result = []
        for row in rows:
            ref, head = row.split("\t")
            remote = ref.startswith("refs/remotes/")
            name = ref.removeprefix("refs/remotes/").removeprefix("refs/heads/")
            tree = trees.get(name) if not remote else None
            dirty = tree and (
                self.projects.read_files(tree) != self.projects.revision_files(tree["path"], head)
                or tree["id"] in self.projects.pending
            )
            tracking = self.projects.remotes.status(tree["id"]) if tree else None
            result.append(
                {
                    "ref": ref,
                    "name": name,
                    "head": head,
                    "remote": remote,
                    "current": bool(tree and tree["id"] == worktree_id),
                    "worktree": tree["id"] if tree else None,
                    "state": "pending" if dirty else "clean" if tree else "closed",
                    "upstream": tracking["remote_branch"] if tracking else None,
                    "ahead": tracking["ahead"] if tracking else None,
                    "behind": tracking["behind"] if tracking else None,
                    "sync_state": tracking["state"] if tracking else None,
                }
            )
        return result

    def open_branch(self, worktree_id, name):
        with self.projects.locked(worktree_id) as worktree:
            git_command.check_branch_name(worktree["path"], name)
            tree = self.store.find_worktree(worktree["project"], name)
            if tree:
                return tree
            self.resolve(worktree["path"], "refs/heads/" + name)
            return self.projects.open_worktree(worktree, name)

    def cleanup(self, current_id, remove_id, integrated_id, expected_head):
        with self.projects.locked(current_id):
            current, remove, target = (
                self.projects.get(key) for key in (current_id, remove_id, integrated_id)
            )
            if len({w["project"] for w in (current, remove, target)}) != 1:
                raise Problem("Choose worktrees from this project", 404)
            project = self.store.get("project", current["project"])
            if remove_id in (current_id, integrated_id, project["main"]):
                raise Problem("Main, current and destination worktrees are protected", 409)
            head, _ = self.clean(remove)
            target_head, _ = self.clean(target)
            if head != expected_head or not self.ancestor(remove["path"], head, target_head):
                raise Problem("The branch changed or has unmerged commits. Review it again.", 409)
            # Like `git worktree remove` without --force, keep untracked files and locked worktrees.
            gitdir = Path(self.git(remove["path"], "rev-parse", "--absolute-git-dir"))
            if (gitdir / "locked").exists() or self.git(
                remove["path"], "status", "--porcelain", "--untracked-files=normal"
            ):
                raise Problem(
                    "Duckpad kept this worktree because it contains untracked files or is locked.", 409
                )
            # The record goes first: an interrupted cleanup leaves files to remove again, never a
            # record whose directory is gone.
            with self.store.transaction():
                artifacts = self.store.artifact_ids(worktree=remove_id)
                self.store.delete("worktree", remove_id)
            self.projects.discard([remove], artifacts)
            # Git logs each failure; a branch left behind is only listed as closed.
            for args in (("worktree", "prune"), ("update-ref", "-d", "refs/heads/" + remove["branch"], head)):
                with suppress(GitError):
                    self.git(current["path"], *args)
            return {"ok": True}

    def ancestor(self, path, older, newer):
        return self.git(path, "merge-base", older, newer, check=False) == older

    def prevalidate(self, path, ref):
        """Validate a branch's history before the caller takes the repository lock.

        Accepted and rejected commits are both cached, so the check repeated under the lock is
        immediate. Errors are left to that check, which reports them in its usual order.
        """
        with suppress(Problem):
            self.validate_history(path, self.resolve(path, ref))

    def validate_history(self, path, head):
        """Reject non-declarative history, symlinks and submodules before adoption/publication.

        A history that descends from a rejected commit is rejected without inspecting any tree.
        """
        if head in self.safe_heads:
            return
        if message := self.rejected.get(head):
            raise Problem(message, 422)
        commits = self.git(path, "rev-list", f"--max-count={MAX_HISTORY + 1}", head).splitlines()
        if len(commits) > MAX_HISTORY:
            self.reject("History exceeds the validation limit; use a smaller project repository.", head)
        for commit in commits:
            if message := self.rejected.get(commit):
                self.reject(message, head)
        for commit in commits:
            if commit in self.safe_heads:
                continue
            for row in self.git(path, "ls-tree", "-r", "--full-tree", commit).splitlines():
                metadata, name = row.split("\t", 1)
                mode, kind, _ = metadata.split()
                if mode != "100644" or kind != "blob" or not (is_declarative(name) or name == ".gitignore"):
                    self.reject(
                        "Git history contains unsupported files or file modes. Synchronize only declarative Duckpad project history.",
                        head,
                        commit,
                    )
        self.safe_heads.update(commits)

    def reject(self, message, *commits):
        for commit in commits:
            self.remember(self.rejected, commit, message)
        raise Problem(message, 422)

    def prepare(self, destination, source_ref, remote_guard=None):
        if source_ref.startswith(("refs/heads/", "refs/remotes/origin/")):
            self.prevalidate(self.projects.get(destination)["path"], source_ref)
        with self.projects.locked(destination) as target:
            path = target["path"]
            target_head, current = self.clean(target)
            require_valid(current, "Fix destination project definitions before review")
            if not source_ref.startswith(("refs/heads/", "refs/remotes/origin/")):
                raise Problem("Choose an explicit local or fetched remote branch")
            source_head = self.resolve(path, source_ref)
            if source_ref.startswith("refs/remotes/"):
                config = self.projects.remotes.config(target)
                self.projects.remotes.checked_config(target, digest(config))
                if not config.get("checked"):
                    raise Problem("Fetch origin before reviewing a remote branch", 409)
            source_tree = (
                self.store.find_worktree(target["project"], source_ref.removeprefix("refs/heads/"))
                if source_ref.startswith("refs/heads/")
                else None
            )
            if source_tree:
                self.clean(source_tree)
            elif source_ref.startswith("refs/heads/"):
                raise Problem("Open the source branch in an isolated worktree before review", 409)
            self.validate_history(path, source_head)
            base = self.git(path, "merge-base", target_head, source_head, check=False)
            if not base:
                raise Problem(
                    "Unrelated histories cannot be integrated. Choose a branch from this project.", 409
                )
            incoming = self.projects.revision_files(path, source_head)
            require_valid(incoming, "Fix incoming project definitions before integration")
            key = uid("review_")
            review = {
                "id": key,
                "worktree": destination,
                "source_ref": source_ref,
                "source_head": source_head,
                "target_head": target_head,
                "source_worktree": source_tree["id"] if source_tree else None,
                "source_revision": digest(incoming),
                "target_revision": digest(current),
                "base_head": base,
                "source": source_ref.removeprefix("refs/heads/").removeprefix("refs/remotes/"),
                "destination": target["branch"],
                "base": self.projects.revision_files(path, base),
                "current": current,
                "incoming": incoming,
                "remote_guard": remote_guard
                or (
                    digest(self.store.get("git_remote", target["project"], {}))
                    if source_ref.startswith("refs/remotes/")
                    else None
                ),
            }
            self.remember(self.reviews, key, review)
            return self.proposal(destination, key, {})

    def review(self, worktree_id, key):
        review = self.reviews.get(key)
        if not review or review["worktree"] != worktree_id:
            raise Problem("Review expired. Start a new review.", 409)
        return review

    def proposal(self, worktree_id, key, choices):
        review = self.review(worktree_id, key)
        evidence = []
        files, unresolved = merge_files(
            review["base"], review["current"], review["incoming"], choices, evidence
        )
        if set(choices) - {c["path"] for c in evidence} or any(
            c not in ("base", "current", "incoming") for c in choices.values()
        ):
            raise Problem("Choose base, current or incoming for a reported conflict")
        _, errors = diagnose(files)
        return {
            **{k: v for k, v in review.items() if k not in ("base", "current", "incoming", "remote_guard")},
            "choices": choices,
            "conflicts": evidence,
            "unresolved": unresolved,
            "diagnostics": errors,
            "files": files,
            "proposal_revision": digest(files),
            "comparison": compare_files(review["current"], files),
        }

    def verify_review(self, review):
        target = self.projects.get(review["worktree"])
        head, files = self.clean(target)
        if (
            head != review["target_head"]
            or digest(files) != review["target_revision"]
            or self.resolve(target["path"], review["source_ref"]) != review["source_head"]
        ):
            raise Problem("Branch heads changed. Start a new review before applying.", 409)
        if review["source_worktree"]:
            source_head, source_files = self.clean(self.projects.get(review["source_worktree"]))
            if source_head != review["source_head"] or digest(source_files) != review["source_revision"]:
                raise Problem("Source edits changed. Start a new review.", 409)
        if review["remote_guard"]:
            config = self.store.get("git_remote", target["project"], {})
            if digest(config) != review["remote_guard"]:
                raise Problem("Remote configuration or fetched state changed. Fetch and review again.", 409)
            self.projects.remotes.checked_config(target, review["remote_guard"])
        return target

    def run(self, path, *args, env=None, input=None):
        return self.git(
            path,
            *args,
            env=env,
            input=input,
            failure="Git could not complete the reviewed operation. Reload and retry.",
        )

    def install(self, target, review, commit):
        """Hold both Git ref locks across checkout, so another Git client cannot advance either head."""
        path = target["path"]
        with git_command.session(
            path, "update-ref", "--stdin", identity=self.projects.identity()
        ) as transaction:
            installed = False

            def request(commands, acknowledgement):
                transaction.stdin.write(commands)
                transaction.stdin.flush()
                if transaction.stdout.readline().strip() != acknowledgement:
                    raise Problem("Git heads changed or are locked. Reload and review again.", 409)

            try:
                request("start\n", "start: ok")
                request(
                    f"update refs/heads/{target['branch']} {commit} {review['target_head']}\nverify {review['source_ref']} {review['source_head']}\nprepare\n",
                    "prepare: ok",
                )
                self.verify_review(review)
                # Two-tree checkout refuses dirty files and untracked collisions.
                self.run(path, "read-tree", "-m", "-u", review["target_head"], commit)
                installed = True
                request("commit\n", "commit: ok")
            except (Problem, BrokenPipeError) as error:
                if installed and self.resolve(path, "HEAD") == review["target_head"]:
                    self.run(path, "read-tree", "-m", "-u", commit, review["target_head"])
                raise Problem(
                    "Git integration was rejected. Local edits are retained; reload and review again.", 409
                ) from error

    def apply(self, worktree_id, key, choices, proposal_revision):
        with self.projects.locked(worktree_id):
            review = self.review(worktree_id, key)
            proposal = self.proposal(worktree_id, key, choices)
            if proposal["unresolved"] or proposal["diagnostics"]:
                raise Problem(
                    "Resolve conflicts and validation errors before applying", 422, proposal["diagnostics"]
                )
            if proposal["proposal_revision"] != proposal_revision:
                raise Problem("The proposal changed. Review the combined changes again.", 409)
            target = self.verify_review(review)
            path = target["path"]
            if self.ancestor(path, review["source_head"], review["target_head"]):
                return self.projects.snapshot(worktree_id)
            files = proposal["files"]
            # Build the reviewed tree away from the worktree/index. Both real parents are retained.
            with tempfile.TemporaryDirectory(prefix="duckpad-merge-") as directory:
                env = {"GIT_INDEX_FILE": str(Path(directory) / "index")}
                self.run(path, "read-tree", review["target_head"], env=env)
                for name in sorted(review["current"].keys() | files.keys()):
                    if name in files:
                        blob = self.run(path, "hash-object", "-w", "--stdin", input=files[name])
                        self.run(
                            path, "update-index", "--add", "--cacheinfo", f"100644,{blob},{name}", env=env
                        )
                    else:
                        self.run(path, "update-index", "--force-remove", "--", name, env=env)
                tree = self.run(path, "write-tree", env=env)
                message = f"chore(merge): merge {review['source']} into {review['destination']}"
                commit = self.run(
                    path,
                    "commit-tree",
                    tree,
                    "-p",
                    review["target_head"],
                    "-p",
                    review["source_head"],
                    "-m",
                    message,
                )
            self.verify_review(review)
            self.install(target, review, commit)
            self.projects.observed[worktree_id] = files
            self.projects.on_change(worktree_id)
            self.reviews.pop(key, None)
            return self.projects.snapshot(worktree_id)
