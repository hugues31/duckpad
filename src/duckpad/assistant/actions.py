"""Durable chat action receipts and three-way inverses of their exact Git changes."""

from contextlib import contextmanager
from difflib import unified_diff

from pydantic import BaseModel, ConfigDict

from ..comparison import compare_files
from ..git.identity import commit_author
from ..util import Problem
from .tools import PageContext, validate_context


class UndoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    context: PageContext
    turn: str
    action: str = ""


def describe(before, after, *, every=False):
    """The changed entities and the SQL diffs of a save.

    With `every`, the diff of every changed file, for a change its user must read before it is
    saved.
    """
    changes = [
        {k: c[k] for k in ("id", "name", "kind", "status")}
        for c in compare_files(before, after, impact=False)["entities"]
        if c["status"] != "unchanged"
    ]
    diffs, remaining = [], 40000 if every else 8000
    for path in sorted(before.keys() | after.keys()):
        if (every or path.endswith(".sql")) and before.get(path) != after.get(path):
            diff = "".join(
                unified_diff(
                    before.get(path, "").splitlines(keepends=True),
                    after.get(path, "").splitlines(keepends=True),
                    fromfile=path,
                    tofile=path,
                )
            )
            diffs.append({"path": path, "diff": diff[:remaining], "truncated": len(diff) > remaining})
            remaining = max(0, remaining - len(diff))
            if not remaining:
                break
    return {"changes": changes[:50], "change_count": len(changes), "sql_diffs": diffs}


class Actions:
    def __init__(self, assistant):
        self.assistant = assistant
        self.projects = assistant.services.projects
        self.store = assistant.store

    def retain_conflict(self, error, identity, turn, action, operation):
        if error.status != 409 or not isinstance(error.detail, dict) or not error.detail.get("id"):
            raise error
        conflict = error.detail
        conflict["assistant_action"] = {
            "conversation": identity,
            "turn": turn["id"],
            "action": action["id"],
            "operation": operation,
        }
        self.store.put("conflict", conflict["id"], conflict)
        action.update(conflict=conflict["id"], status="conflict" if operation == "write" else "undo_conflict")

    def apply(self, deps, identity, turn, tool_id, base, files, details):
        assistant = self.assistant
        deps.check(write=True)
        # `uv lock` can take long and use the network: resolve before taking any lock.
        files = self.projects.lock_dependencies(deps.context["worktree"], files)
        with assistant.lock(identity), self.projects.locked(deps.context["worktree"]):
            user, _ = deps.check(write=True)
            assistant.owned(user, identity)
            cancellation = assistant.active.get(identity)
            if cancellation is None or cancellation.cancelled:
                raise Problem("The assistant response was stopped", 409)
            if self.store.has_conflicts(deps.context["worktree"]):
                raise Problem("Resolve the pending project conflict before editing", 409)
            before = self.projects.flush(deps.context["worktree"])
            card = next(t for t in turn["tools"] if t["id"] == tool_id)
            action = {"id": tool_id, "before": before["commit"], "commit": "", "status": "applied", **details}
            try:
                with commit_author(assistant.auth.commit_identity(user)):
                    result = self.projects.write(
                        deps.context["worktree"],
                        base["revision"],
                        files,
                        validate=True,
                        assistant=identity,
                        relock=False,
                    )
            except Problem as error:
                self.retain_conflict(error, identity, turn, action, "write")
                action.update(describe(before["files"], files))
                card["action"] = deps.safe(action)
                assistant.save_turn(identity, turn)
                deps.failed.add(tool_id)
                return {"error": str(error), "action": card["action"]}
            deps.snapshots[deps.context["worktree"]] = result
            if result["commit"] == before["commit"]:
                return {"changed": False}
            action.update(commit=result["commit"], **describe(before["files"], result["files"]))
            card["action"] = deps.safe(action)
            # Save the receipt before returning to the provider, including for interrupted turns.
            assistant.save_turn(identity, turn)
            return {"action": card["action"]}

    def undo(self, user, identity, data):
        assistant = self.assistant
        with assistant.lock(identity):
            record = assistant.owned(user, identity)
            turn = next((t for t in record["turns"] if t["id"] == data.turn), None)
            if turn is None:
                raise Problem("Assistant turn not found", 404)
            # A turn edited the branch its message was sent from.
            context = validate_context(assistant.services, user, data.context)
            if any(turn["context"][k] != context[k] for k in ("project", "worktree", "branch")):
                raise Problem("Open the branch of this change before undoing", 409)
            assistant.services.engine.access.worktree(user, context["worktree"], "editor")
            if identity in assistant.active:
                raise Problem("Wait for the assistant response before undoing", 409)
            actions = [t["action"] for t in turn["tools"] if t.get("action") and t["action"].get("commit")]
            if data.action:
                actions = [a for a in actions if a["id"] == data.action]
            if not actions:
                raise Problem("Assistant action not found", 404)
            with self.projects.locked(context["worktree"]) as worktree:
                if self.store.has_conflicts(worktree["id"]) and not any(a.get("conflict") for a in actions):
                    raise Problem("Resolve the pending project conflict before editing", 409)
                if (
                    self.projects.git(worktree["path"], "symbolic-ref", "-q", "HEAD", check=False)
                    != "refs/heads/" + context["branch"]
                ):
                    raise Problem("The open branch changed. Try again.", 409)
                for action in reversed(actions):
                    if action["status"] == "undone":
                        continue
                    if action.get("conflict"):
                        break
                    try:
                        with commit_author(assistant.auth.commit_identity(user)):
                            result = self.projects.revert(
                                worktree["id"],
                                action["commit"],
                                action["before"],
                                validate=True,
                                assistant=identity,
                                # An undo restores its earlier dependency files without `uv lock`.
                                relock=False,
                            )
                    except Problem as error:
                        self.retain_conflict(error, identity, turn, action, "undo")
                        assistant.save_turn(identity, turn)
                        break
                    action.update(status="undone", undo_commit=result["commit"])
                    assistant.save_turn(identity, turn)
            return assistant.public(assistant.owned(user, identity))

    @contextmanager
    def resolving(self, conflict, choice):
        """Projects' resolution hook: a resolution finalizes the receipt of the assistant action
        whose save retained the conflict."""
        link = conflict.get("assistant_action")
        if not link:
            yield lambda before, result: None
            return
        assistant = self.assistant
        with assistant.lock(link["conversation"]):
            if link["conversation"] in assistant.active:
                raise Problem("Wait for the assistant response before resolving its conflict", 409)
            yield lambda before, result: self.resolved(link, choice, before, result)

    def resolved(self, link, choice, before, result):
        record = self.store.get("assistant_conversation", link["conversation"])
        if not record:
            return
        turn = next(t for t in record["turns"] if t["id"] == link["turn"])
        action = next(t["action"] for t in turn["tools"] if t["id"] == link["action"])
        action.pop("conflict", None)
        if link["operation"] == "undo":
            action.update(status="applied" if choice == "current" else "undone")
            if choice != "current":
                action["undo_commit"] = result["commit"]
        elif choice == "current" or before == result["commit"]:
            action["status"] = "discarded"
        else:
            previous = self.projects.revision_files(result["worktree"]["path"], before)
            action.update(
                status="applied",
                before=before,
                commit=result["commit"],
                **describe(previous, result["files"]),
            )
        self.assistant.save_turn(link["conversation"], turn)
