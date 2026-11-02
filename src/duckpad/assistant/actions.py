"""Durable chat action receipts and three-way inverses of their exact Git changes."""

from difflib import unified_diff

from pydantic import BaseModel, ConfigDict

from ..comparison import compare_files
from ..git.identity import commit_author
from ..util import Problem, digest
from .tools import PageContext, validate_context


class UndoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    context: PageContext
    turn: str
    action: str = ""


def describe(before, after):
    changes = [
        {k: c[k] for k in ("id", "name", "kind", "status")}
        for c in compare_files(before, after, impact=False)["entities"]
        if c["status"] != "unchanged"
    ]
    diffs, remaining = [], 8000
    for path in sorted(before.keys() | after.keys()):
        if path.endswith(".sql") and before.get(path) != after.get(path):
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
        with assistant.lock, self.projects.locked(deps.context["worktree"]):
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
                    )
            except Problem as error:
                self.retain_conflict(error, identity, turn, action, "write")
                action.update(describe(before["files"], files))
                card["action"] = deps.safe(action)
                assistant.save_turn(identity, turn)
                return {"error": str(error), "action": card["action"]}
            deps.editing_snapshot = result
            if result["commit"] == before["commit"]:
                return {"changed": False}
            action.update(commit=result["commit"], **describe(before["files"], result["files"]))
            card["action"] = deps.safe(action)
            # Save the receipt before returning to the provider, including for interrupted turns.
            assistant.save_turn(identity, turn)
            return {"action": card["action"]}

    def undo(self, user, identity, data):
        assistant = self.assistant
        with assistant.lock:
            record = assistant.owned(user, identity)
            context = validate_context(assistant.services, user, data.context)
            if any(record[k] != context[k] for k in ("project", "worktree", "branch")):
                raise Problem("Open the conversation's original branch before undoing", 409)
            assistant.services.engine.access.worktree(user, record["worktree"], "editor")
            if identity in assistant.active:
                raise Problem("Wait for the assistant response before undoing", 409)
            turn = next((t for t in record["turns"] if t.get("id") == data.turn), None)
            if turn is None:
                raise Problem("Assistant turn not found", 404)
            actions = [t["action"] for t in turn["tools"] if t.get("action") and t["action"].get("commit")]
            if data.action:
                actions = [a for a in actions if a["id"] == data.action]
            if not actions:
                raise Problem("Assistant action not found", 404)
            with self.projects.locked(record["worktree"]) as worktree:
                if self.store.has_conflicts(worktree["id"]) and not any(a.get("conflict") for a in actions):
                    raise Problem("Resolve the pending project conflict before editing", 409)
                if (
                    self.projects.git(worktree["path"], "symbolic-ref", "-q", "HEAD", check=False)
                    != "refs/heads/" + record["branch"]
                ):
                    raise Problem("The conversation branch changed. Start a new conversation.", 409)
                for action in reversed(actions):
                    if action["status"] == "undone":
                        continue
                    if action.get("conflict"):
                        break
                    after = self.projects.revision_files(worktree["path"], action["commit"])
                    before = self.projects.revision_files(worktree["path"], action["before"])
                    revision = digest(after)
                    # A receipt can outlive the short optimistic-save cache and restart recovery window.
                    self.projects.cached(self.projects.revisions, (worktree["id"], revision), after)
                    try:
                        with commit_author(assistant.auth.commit_identity(user)):
                            result = self.projects.write(
                                worktree["id"],
                                revision,
                                before,
                                validate=True,
                                assistant=identity,
                            )
                    except Problem as error:
                        self.retain_conflict(error, identity, turn, action, "undo")
                        assistant.save_turn(identity, turn)
                        break
                    action.update(status="undone", undo_commit=result["commit"])
                    assistant.save_turn(identity, turn)
            return assistant.public(assistant.owned(user, identity))

    def resolve(self, user, conflict_id, choice, files):
        """The usual conflict UI also finalizes the associated action receipt."""
        assistant = self.assistant
        with assistant.lock:
            conflict = self.projects.conflict(conflict_id)
            link = conflict.get("assistant_action")
            if link and link["conversation"] in assistant.active:
                raise Problem("Wait for the assistant response before resolving its conflict", 409)
            assistant.services.engine.access.worktree(user, conflict["worktree"], "editor")
            with self.projects.locked(conflict["worktree"]):
                before = self.projects.flush(conflict["worktree"])
                with commit_author(assistant.auth.commit_identity(user)):
                    result = self.projects.resolve(conflict_id, choice, files)
                record = self.store.get("assistant_conversation", link["conversation"]) if link else None
                if record:
                    turn = next(t for t in record["turns"] if t.get("id") == link["turn"])
                    action = next(t["action"] for t in turn["tools"] if t["id"] == link["action"])
                    action.pop("conflict", None)
                    if link["operation"] == "undo":
                        action.update(status="applied" if choice == "current" else "undone")
                        if choice != "current":
                            action["undo_commit"] = result["commit"]
                    elif choice == "current" or before["commit"] == result["commit"]:
                        action["status"] = "discarded"
                    else:
                        action.update(
                            status="applied",
                            before=before["commit"],
                            commit=result["commit"],
                            **describe(before["files"], result["files"]),
                        )
                    assistant.save_turn(link["conversation"], turn)
                return result
