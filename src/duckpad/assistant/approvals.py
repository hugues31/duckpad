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

    def decide(self, user, token, identity, data):
        from .service import TurnRequest

        assistant = self.assistant
        with assistant.lock, assistant.store.transaction():
            record = assistant.owned(user, identity)
            if identity in assistant.active:
                raise Problem("A response is already in progress", 409)
            turn = record["turns"][-1] if record["turns"] else {}
            if turn.get("id") != data.turn or turn.get("status") != "awaiting_approval":
                raise Problem("This run request has already been answered", 409)
            card = next(
                (c for c in turn["tools"] if c["id"] == data.tool and c["id"] in turn["approvals"]), None
            )
            if card is None or card["approval"]["decision"] is not None:
                raise Problem("This run request has already been answered", 409)
            if data.approved and card["approval"].get("error"):
                raise Problem("This run request cannot be approved; decline it and request a new run", 409)
            if data.approved:
                assistant.services.engine.access.worktree(user, record["worktree"], "editor")
            card["approval"]["decision"] = data.approved
            card["status"] = "approved" if data.approved else "denied"
            waiting = any(
                c["approval"]["decision"] is None for c in turn["tools"] if c["id"] in turn["approvals"]
            )
            if waiting:
                assistant.save_turn(identity, turn)

                async def pending():
                    yield json.dumps({"type": "done", "turn": turn}) + "\n"

                return pending(), CancellationToken()
            request = TurnRequest(
                message=turn["user"],
                provider=turn["provider"],
                model=turn["model"],
                context=PageContext(
                    **{k: v for k, v in turn["context"].items() if k in PageContext.model_fields}
                ),
            )
            result = assistant.prepare(user, token, identity, request, resume=turn)
            # Consume the batch before yielding to the stream. A disconnect or process crash
            # must never make an accepted request replayable, even if its response was lost.
            turn["status"] = "resuming"
            assistant.save_turn(identity, turn)
            return result

    def launch(self, deps, identity, turn, tool_id, environment, node):
        card = next(
            (c for c in turn["tools"] if c["id"] == tool_id and c["id"] in turn.get("approvals", [])), None
        )
        if not card or card.get("approval", {}).get("decision") is not True or card.get("consumed"):
            raise Problem("Explicit run approval is required", 403)
        services = deps.services
        with self.assistant.lock, services.projects.locked(deps.context["worktree"]), services.engine.lock:
            user, _ = deps.check(write=True)
            self.assistant.owned(user, identity)
            cancellation = self.assistant.active.get(identity)
            if cancellation is None or cancellation.cancelled:
                raise Problem("The assistant response was stopped", 409)
            current = proposal(deps, environment, node)
            if any(current[k] != card["approval"][k] for k in ("environment", "node", "signature")):
                raise Problem(
                    "The run configuration changed. Request a new run and review its confirmation.", 409
                )
            card["consumed"] = True
            self.assistant.save_turn(identity, turn)
            result = services.engine.launch(
                deps.context["worktree"],
                current["environment"],
                node or None,
                "assistant",
                requester={"id": user["id"], "username": user["username"], "token_name": None},
            )
            card["run"] = run_summary(result)
            self.assistant.save_turn(identity, turn)
            return card["run"]
