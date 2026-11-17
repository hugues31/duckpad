"""Authenticated agent API and human-only, single-use execution decisions."""

import html
import json
import secrets
import threading
import time
from datetime import UTC, datetime
from urllib.parse import quote, urlparse

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse
from pydantic import ValidationError
from starlette.routing import Route

from . import agent_tools, mcp_server
from .api.http import problem_response
from .assistant.runs import proposal, run_summary
from .auth import session_key
from .uploads import limited_body
from .util import Problem, uid

PREFIX = "/api/agent"
LIFETIME = 15 * 60
MAX_REQUEST = 256 * 1024


def bearer(request):
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.startswith("dpk_"):
        raise Problem("An API token is required for external agent tools", 401)
    return token


def failure(error):
    return {
        "ok": False,
        "error": {
            "code": {
                401: "unauthenticated",
                403: "forbidden",
                404: "not_found",
                409: "conflict",
                413: "response_too_large",
                422: "invalid_request",
                429: "too_many_requests",
            }.get(error.status, "request_failed"),
            "status": error.status,
            "message": str(error),
            "details": error.detail,
        },
    }


class AgentAPI:
    def __init__(self, context):
        self.context = context
        self.pending = {}
        self.lock = threading.RLock()

        def request_run(ctx, node: str = ""):
            """Request human approval for a run or node preview; returns a review path. Does not execute."""
            deps = ctx.deps
            with self.lock:
                user, _ = deps.check(write=True)
                with deps.services.projects.locked(deps.context["worktree"]):
                    plan = proposal(deps, deps.context["environment"], node)
                    snapshot = deps.services.projects.snapshot(deps.context["worktree"])
                self.pending = {k: v for k, v in self.pending.items() if v["expires"] > time.time()}
                if len(self.pending) >= 1000:
                    raise Problem("Too many pending run requests; wait for expiry", 429)
                identity = uid("approval_")
                self.pending[identity] = {
                    "id": identity,
                    "owner": session_key(deps.token),
                    "requester": user["username"],
                    "worktree": deps.context["worktree"],
                    "project": deps.context["project"],
                    "branch": deps.context["branch"],
                    "commit": snapshot["commit"],
                    "plan": plan,
                    "expires": time.time() + LIFETIME,
                    "decision": None,
                    "consumed": False,
                    "csrf": secrets.token_urlsafe(32),
                }
                return self.receipt(self.pending[identity])

        def read_approval(ctx, approval: str):
            """Read a run request made by this token, including its human decision and expiry."""
            with self.lock:
                return self.receipt(self.owned(ctx.deps, approval))

        def launch_approved_run(ctx, approval: str):
            """Consume a human-approved request and launch it once; repeat calls return the same run."""
            deps = ctx.deps
            services = deps.services
            with self.lock:
                record = self.owned(deps, approval)
                if (record["worktree"], record["branch"]) != (
                    deps.context.get("worktree"),
                    deps.context.get("branch"),
                ):
                    raise Problem("Use the worktree of the approved request", 409)
                if record["decision"] is not True:
                    raise Problem("Explicit human run approval is required", 403)
                if record.get("run"):
                    return record["run"]
                if record["consumed"]:
                    raise Problem("This approval was consumed. Request a new run.", 409)
                reviewer = services.store.get("user", record["reviewer"])
                if not reviewer or not reviewer["active"] or reviewer.get("service"):
                    raise Problem("The approving account is no longer active", 403)
                self.context.access.worktree(self.context.auth.public(reviewer), record["worktree"], "editor")
                with services.projects.locked(record["worktree"]):
                    deps.check(write=True)
                    # Mark used before admission: a failed or lost request must not replay an approval.
                    record["consumed"] = True

                    def unchanged():
                        deps.check(write=True)
                        current = proposal(deps, record["plan"]["environment"], record["plan"]["node"])
                        if current["signature"] != record["plan"]["signature"]:
                            raise Problem("Run configuration changed. Request and review a new run.", 409)

                    user, _ = deps.check(write=True)
                    _, token_name = self.context.auth.check_api_token(deps.token)
                    result = services.engine.launch(
                        record["worktree"],
                        record["plan"]["environment"],
                        record["plan"]["node"] or None,
                        "assistant",
                        requester={
                            "id": user["id"],
                            "username": user["username"],
                            "token_name": token_name,
                            "service": user.get("auth_method") == "service",
                        },
                        guard=unchanged,
                    )
                    record["run"] = run_summary(result)
                    return record["run"]

        self.tools = dict(agent_tools.TOOLS)
        for function in (request_run, read_approval, launch_approved_run):
            self.tools[function.__name__] = agent_tools.Tool(function, write=function is not read_approval)

    @staticmethod
    def receipt(record):
        return {
            **{
                k: record[k]
                for k in ("id", "worktree", "branch", "commit", "plan", "expires", "decision", "consumed")
            },
            "review_path": f"{PREFIX}/approvals/{record['id']}/review",
            "run": record.get("run"),
        }

    def get(self, identity):
        record = self.pending.get(identity)
        if not record or record["expires"] <= time.time():
            raise Problem("Approval not found or expired. Request a new run.", 404)
        return record

    def owned(self, deps, identity):
        user, _ = deps.check()
        record = self.get(identity)
        if record["owner"] != session_key(deps.token):
            raise Problem("Approval not found", 404)
        self.context.access.worktree(user, record["worktree"])
        return record

    def human(self, request, identity):
        # A bearer session also cannot approve: require the signed-in browser cookie.
        if request.state.token_name is not None:
            raise Problem("API tokens cannot approve agent execution", 403)
        user = self.context.auth.check(request.cookies.get("duckpad_session", ""))
        record = self.get(identity)
        self.context.access.worktree(user, record["worktree"], "editor")
        return user, record

    def listing(self, token):
        self.context.auth.check_api_token(token)
        return [tool.public() for tool in self.tools.values()]

    async def mcp(self, scope, receive, send):
        """Streamable HTTP MCP for API tokens: the tools of /tools, without a bridge on the client."""
        request = Request(scope, receive)
        if request.method != "POST":
            # Stateless: no session to resume or delete, and no stream of server messages.
            response = problem_response(
                Problem("This MCP endpoint only accepts POST", 405), {"Allow": "POST"}
            )
            await response(scope, receive, send)
            return
        await limited_body(MAX_REQUEST, "request")(request)
        token = bearer(request)

        async def listing():
            return await run_in_threadpool(self.listing, token)

        async def call(name, arguments):
            return await run_in_threadpool(self.call, token, name, arguments)

        await mcp_server.serve_http(mcp_server.server(listing, call), scope, receive, send)

    def call(self, token, name, arguments):
        hidden = agent_tools.secrets(self.context, token)
        try:
            if name not in self.tools:
                raise Problem("Unknown agent tool", 404)
            result = self.tools[name].call(self.context, token, arguments, hidden)
            result = agent_tools.redact({"ok": True, "result": result}, hidden)
            if len(json.dumps(result).encode()) > agent_tools.MAX_RESPONSE:
                raise Problem("Response too large. Request fewer rows or a smaller section.", 413)
            return result
        except ValidationError as error:
            detail = [{"location": ".".join(map(str, e["loc"])), "message": e["msg"]} for e in error.errors()]
            result = failure(Problem("Invalid tool arguments", 422, detail))
        except Problem as error:
            result = failure(error)
        result = agent_tools.redact(result, hidden)
        if len(json.dumps(result).encode()) > agent_tools.MAX_RESPONSE:
            return failure(Problem("Error details exceed the response limit. Make a smaller change.", 413))
        return result

    def router(self):
        api = APIRouter(prefix=PREFIX)

        @api.get("/tools")
        def listing(request: Request):
            return self.listing(bearer(request))

        @api.post("/tools/{name}")
        async def call(name: str, request: Request):
            await limited_body(MAX_REQUEST, "request")(request)
            token = bearer(request)
            try:
                data = await request.json()
            except ValueError:
                raise Problem("Send a JSON object of tool arguments", 422) from None
            return await run_in_threadpool(self.call, token, name, data)

        @api.get("/approvals/{identity}/review", response_class=HTMLResponse)
        def review(identity: str, request: Request):
            with self.lock:
                _, record = self.human(request, identity)
                hidden = agent_tools.secrets(self.context, "")

                def escaped(value):
                    return html.escape(str(agent_tools.redact(value, hidden)))

                plan = record["plan"]
                fields = {
                    "Requested by": record["requester"],
                    "Branch": record["branch"],
                    "Commit": record["commit"],
                    "Environment": plan["environment"],
                    "Scope": plan["scope"],
                    "Nodes": plan["node_count"],
                    "Expires (UTC)": datetime.fromtimestamp(record["expires"], UTC).strftime(
                        "%Y-%m-%d %H:%M"
                    ),
                }
                details = "".join(
                    f"<dt>{label}</dt><dd>{escaped(value)}</dd>" for label, value in fields.items()
                )
                effects = "".join(
                    f"<h2>{label}</h2><pre>{escaped(json.dumps(plan[key], indent=2))}</pre>"
                    for label, key in (
                        ("External writes", "exports"),
                        ("Python nodes", "python_nodes"),
                        ("Variables", "variables"),
                    )
                    if plan[key]
                )
                action = f"{PREFIX}/approvals/{record['id']}/decision"
                form = (
                    f'<form method="post" action="{action}"><input type="hidden" name="csrf" value="{record["csrf"]}">'
                    '<button name="decision" value="approve">Approve this run</button> '
                    '<button name="decision" value="decline">Decline</button></form>'
                    if record["decision"] is None
                    else "<p>This request has already been answered. Return to your agent to continue.</p>"
                )
                return HTMLResponse(
                    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Review Duckpad run</title>'
                    '<meta name="viewport" content="width=device-width, initial-scale=1">'
                    "<style>body{font:16px system-ui;margin:3rem auto;padding:0 1rem;max-width:48rem;line-height:1.5}"
                    "dt{font-weight:600}dd{margin:0 0 1rem;overflow-wrap:anywhere}pre{white-space:pre-wrap}"
                    "button{font:inherit;padding:.6rem 1rem;cursor:pointer}h2{font-size:1.2rem}</style>"
                    "<body><main><h1>Review agent execution</h1>"
                    f'<p><a href="/worktrees/{quote(record["worktree"], safe="")}/history" target="_blank" rel="noopener">'
                    "Open this branch's history</a> and inspect the agent's changes before approving. "
                    "Exports and external writes cannot be undone.</p>"
                    f"<dl>{details}</dl>{effects}{form}</main></body></html>",
                    headers={
                        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
                    },
                )

        @api.post("/approvals/{identity}/decision", response_class=HTMLResponse)
        async def decide(identity: str, request: Request):
            await limited_body(4096, "decision")(request)
            async with request.form() as form:
                decision, csrf = form.get("decision"), form.get("csrf")

            def save():
                with self.lock:
                    user, record = self.human(request, identity)
                    origin = request.headers.get("origin")
                    if origin and urlparse(origin).netloc != request.headers.get("host"):
                        raise Problem("Cross-origin approvals are not allowed", 403)
                    if not isinstance(csrf, str) or not secrets.compare_digest(csrf, record["csrf"]):
                        raise Problem("Reload the review page before deciding", 403)
                    if decision not in ("approve", "decline"):
                        raise Problem("Choose approve or decline", 422)
                    if record["decision"] is not None:
                        raise Problem("This request has already been answered", 409)
                    record.update(decision=decision == "approve", reviewer=user["id"])
                return HTMLResponse("<p>Decision saved. Return to your agent to continue.</p>")

            return await run_in_threadpool(save)

        api.routes.append(Route(PREFIX + "/mcp", ASGIEndpoint(self.mcp), include_in_schema=False))
        return api


class ASGIEndpoint:
    """Mounts a handler as a raw ASGI app: Starlette wraps functions and methods as request handlers."""

    def __init__(self, handle):
        self.handle = handle

    async def __call__(self, scope, receive, send):
        await self.handle(scope, receive, send)
