"""Persisted, owner-only decisions for Pydantic AI deferred run calls."""

import json

from pydantic import BaseModel, ConfigDict
from pydantic_ai import CancellationToken

from ..util import Problem
from .runs import proposal, run_summary
from .tools import PageContext


class ApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    turn: str
    tool: str
    approved: bool


async def answered(turn):
    """The response to a decision that resumes no model run."""
    yield json.dumps({"type": "done", "turn": turn}) + "\n"


class Approvals:
    def __init__(self, assistant):
        self.assistant = assistant

    def capture(self, deps, turn, requests):
        turn["approvals"] = []
        for call in requests.approvals:
            card = next((c for c in turn["tools"] if c["id"] == call.tool_call_id), None)
            if card is None:
                card = {
                    "id": call.tool_call_id,
                    "name": call.tool_name,
                    "args": call.args_as_dict(),
                    "summary": "",
                }
                turn["tools"].append(card)
            try:
                card["approval"] = proposal(deps, **call.args_as_dict())
            except Problem as error:
                card["approval"] = {"decision": None, "error": deps.safe(str(error))}
            card["status"] = "awaiting_approval"
            turn["approvals"].append(call.tool_call_id)
        turn["status"] = "awaiting_approval"

    @staticmethod
    def pending(record, data):
        """The last turn and its unanswered run request that a decision answers."""
        turn = record["turns"][-1] if record["turns"] else None
        card = None
        if turn and turn["id"] == data.turn and turn["status"] == "awaiting_approval":
            card = next(
                (c for c in turn["tools"] if c["id"] == data.tool and c["id"] in turn["approvals"]), None
            )
        if card is None or card["approval"]["decision"] is not None:
            raise Problem("This run request has already been answered", 409)
        return turn, card

    def decide(self, user, token, identity, data):
        from .service import TurnRequest

        assistant = self.assistant
        # The conversation lock serializes this decision; a Store transaction would also hold the
        # Store lock while `prepare` reads the branch with Git.
        with assistant.lock(identity):
            record = assistant.owned(user, identity)
            if identity in assistant.active:
                raise Problem("A response is already in progress", 409)
            turn, card = self.pending(record, data)
            if data.approved and card["approval"].get("error"):
                raise Problem("This run request cannot be approved; decline it and request a new run", 409)
            if data.approved:
                assistant.services.engine.access.worktree(user, record["worktree"], "editor")
            card["approval"]["decision"] = data.approved
            card["status"] = "approved" if data.approved else "denied"
            if any(c["approval"]["decision"] is None for c in turn["tools"] if c["id"] in turn["approvals"]):
                assistant.save_turn(identity, turn)
                return answered(turn), CancellationToken()
            request = TurnRequest(
                message=turn["user"],
                provider=turn["provider"],
                model=turn["model"],
                context=PageContext(
                    **{k: v for k, v in turn["context"].items() if k in PageContext.model_fields}
                ),
            )
            try:
                result = assistant.prepare(user, token, identity, request, resume=turn)
            except Problem:
                if data.approved:
                    raise
                # Declining needs no response: when the turn cannot resume, for example after an
                # administrator removed its model, close it here. The next prompt answers its calls.
                assistant.close_turn(identity, turn)
                return answered(turn), CancellationToken()
            # Consume the batch before yielding to the stream. A disconnect or process crash
            # must never make an accepted request replayable, even if its response was lost.
            turn["status"] = "resuming"
            assistant.save_turn(identity, turn)
            return result

    def launch(self, deps, identity, turn, tool_id, environment, node):
        """Start an approved run, if its configuration still has the approved signature.

        The conversation and repository locks keep the turn and the project files unchanged until
        the run is admitted. The engine lock is never held here: preparing the launch would block
        status, cancellation and previews of every project.
        """
        card = next(
            (c for c in turn["tools"] if c["id"] == tool_id and c["id"] in turn.get("approvals", [])), None
        )
        if not card or card.get("approval", {}).get("decision") is not True or card.get("consumed"):
            raise Problem("Explicit run approval is required", 403)
        services, approved = deps.services, card["approval"]
        with self.assistant.lock(identity), services.projects.locked(deps.context["worktree"]):
            user, _ = deps.check(write=True)
            self.assistant.owned(user, identity)
            cancellation = self.assistant.active.get(identity)
            if cancellation is None or cancellation.cancelled:
                raise Problem("The assistant response was stopped", 409)
            # Consumed before anything can run: a lost response never makes the approval replayable.
            card["consumed"] = True
            self.assistant.save_turn(identity, turn)

            def unchanged():
                # Checked once the worktree is reserved, so that changes refused during a run,
                # such as Python policy changes, cannot follow the check.
                current = proposal(deps, environment, node)
                if any(current[k] != approved[k] for k in ("environment", "node", "signature")):
                    raise Problem(
                        "The run configuration changed. Request a new run and review its confirmation.", 409
                    )

            result = services.engine.launch(
                deps.context["worktree"],
                approved["environment"],
                node or None,
                "assistant",
                requester={"id": user["id"], "username": user["username"], "token_name": None},
                guard=unchanged,
            )
            card["run"] = run_summary(result)
            self.assistant.save_turn(identity, turn)
            return card["run"]
