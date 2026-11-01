"""Versioned automation contract, independent of the interface's internal routes."""

import asyncio
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, Header, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.openapi.utils import get_openapi
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field

from . import schemas
from .execution.runs import UNFINISHED_RUN_STATUSES
from .util import Problem


class Trigger(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(min_length=1, max_length=128)
    reference: str | None = Field(default=None, max_length=2048)


class LaunchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    trigger: Trigger | None = None


class Requester(BaseModel):
    id: str
    username: str
    token_name: str | None = None


class NodeCounts(BaseModel):
    total: int
    success: int
    failed: int
    running: int
    pending: int
    blocked: int
    canceled: int
    interrupted: int


class RunLinks(BaseModel):
    self: str
    log: str
    cancel: str


class Run(BaseModel):
    id: str
    job: str
    status: Literal[
        "preparing", "running", "canceling", "success", "failed", "partial_failure", "canceled", "interrupted"
    ]
    tag: str | None
    commit: str
    environment: str
    started: str
    finished: str | None
    nodes: NodeCounts
    trigger: Trigger | None
    requester: Requester | None
    links: RunLinks


class TagTarget(BaseModel):
    kind: Literal["tag"]
    tag: str
    commit: str


class BranchTarget(BaseModel):
    kind: Literal["branch"]
    branch: str


class Job(BaseModel):
    slug: str
    name: str
    description: str
    project: str
    target: TagTarget | BranchTarget
    environment: str
    scope: str | None
    last_run: Run | None


class ErrorDetail(BaseModel):
    code: Literal[
        "unauthenticated",
        "forbidden",
        "job_not_found",
        "run_not_found",
        "job_busy",
        "target_unavailable",
        "invalid_project",
        "invalid_request",
    ]
    run: str | None = None


class Error(BaseModel):
    error: str
    detail: ErrorDetail


def problem(error):
    """Add the v1 code to authentication and framework errors as well as service errors."""
    detail = error.detail if isinstance(error.detail, dict) else {"errors": error.detail}
    code = {401: "unauthenticated", 403: "forbidden"}.get(error.status, "invalid_request")
    return Problem(str(error), error.status, {"code": code, **detail})


def public_run(run):
    nodes = list(run["nodes"].values())
    path = f"/api/v1/runs/{run['id']}"
    return {
        "id": run["id"],
        "job": run["job"]["slug"],
        "status": run["status"],
        "tag": run.get("tag"),
        "commit": run["commit"],
        "environment": run["environment"],
        "started": run["started"],
        "finished": run.get("finished"),
        "nodes": {
            "total": len(nodes),
            **{
                status: sum(node["status"] == status for node in nodes)
                for status in (
                    "success",
                    "failed",
                    "running",
                    "pending",
                    "blocked",
                    "canceled",
                    "interrupted",
                )
            },
        },
        "trigger": run.get("external_trigger"),
        "requester": run.get("requester"),
        "links": {"self": path, "log": path + "/log", "cancel": path + "/cancel"},
    }


def run_log(run):
    """Render the persisted, secret-redacted snapshot; never include SQL or connection settings."""

    def line(value):
        # Keep client-controlled names and messages from forging new log lines or terminal escapes.
        return "".join(c if c.isprintable() else f"\\u{ord(c):04x}" for c in str(value))

    lines = [f"Run {line(run['id'])} | Job {line(run['job']['slug'])} | started {line(run['started'])}"]
    for key, node in run["nodes"].items():
        lines.append(f"Node {line(key)} ({line(node.get('label', key))}): {line(node['status'])}")
        if node.get("started"):
            lines.append(f"  started: {line(node['started'])}")
        for result in node.get("results", []):
            origin = result.get("origin", {})
            name = f" [{line(origin['name'])}]" if origin.get("name") else ""
            lines.append(f"  {line(result['level'])}{name}: {line(result['message'])}")
        if node.get("error"):
            lines.append(f"  error: {line(node['error'])}")
        if node.get("external_outcome"):
            lines.append(f"  external outcome: {line(node['external_outcome'])}")
        if node.get("finished"):
            lines.append(f"  finished: {line(node['finished'])}")
    if run.get("error"):
        lines.append(f"Error: {line(run['error'])}")
    lines.append(f"Outcome: {line(run['status'])}")
    if run.get("finished"):
        lines.append(f"Finished: {line(run['finished'])}")
    return "\n".join(lines) + "\n"


def router(jobs, access):
    api = APIRouter(
        prefix="/api/v1",
        tags=["Automation"],
        responses={status: {"model": Error} for status in (401, 403, 404, 409, 422)},
    )
    store = jobs.store

    def require(record, user, kind, role):
        if not record or not access.role(user, record["project"]):
            raise Problem(f"{kind.title()} not found", 404, {"code": f"{kind}_not_found"})
        access.require(user, record["project"], role)
        return record

    def get_job(slug, user, role="reader"):
        return require(store.get("job", slug), user, "job", role)

    def get_run(run_id, user, role="reader"):
        record = store.get("run", run_id)
        # Ad hoc runs stay on the internal API and cannot be canceled by Operators here.
        if record and record.get("trigger") != "job":
            record = None
        return require(record, user, "run", role)

    def authorize(request: Request):
        params = request.path_params
        role = "reader" if request.method == "GET" else "operator"
        if "slug" in params:
            request.state.automation_record = get_job(params["slug"], request.state.user, role)
        elif "run_id" in params:
            request.state.automation_record = get_run(params["run_id"], request.state.user, role)

    api.dependencies.append(Depends(authorize))

    def public_job(job):
        runs = jobs.runs(job, limit=1)
        return {
            **{key: job[key] for key in ("name", "description", "project", "target", "environment", "scope")},
            "slug": job["id"],
            "last_run": public_run(runs[0]) if runs else None,
        }

    @api.get("/jobs", response_model=list[Job], summary="List visible Jobs")
    def list_jobs(request: Request):
        return [
            public_job(job) for job in store.all("job") if access.role(request.state.user, job["project"])
        ]

    @api.get("/jobs/{slug}", response_model=Job, summary="Read a Job")
    def read_job(slug: str, request: Request):
        return public_job(request.state.automation_record)

    @api.post("/jobs/{slug}/runs", response_model=Run, status_code=202, summary="Launch a Job")
    def launch_job(
        slug: str,
        request: Request,
        data: Annotated[LaunchRequest, Body(default_factory=LaunchRequest)],
        idempotency_key: Annotated[str | None, Header(min_length=1, max_length=256)] = None,
    ):
        requester = {
            "id": request.state.user["id"],
            "username": request.state.user["username"],
            "token_name": request.state.token_name,
        }
        try:
            run = jobs.launch(
                slug,
                schemas.JobLaunch(),
                requester,
                external_trigger=data.trigger.model_dump() if data.trigger else None,
                idempotency_key=idempotency_key,
                body=data.model_dump(),
            )
        except Problem as error:
            # Jobs code their launch errors where they are raised; statuses pass through unchanged.
            # Uncoded 422s come from the pinned version at execution time, such as a strict scope.
            if error.status != 422 or (isinstance(error.detail, dict) and "code" in error.detail):
                raise
            detail = error.detail if isinstance(error.detail, dict) else {"errors": error.detail}
            raise Problem(str(error), 422, {"code": "invalid_project", **detail}) from error
        return public_run(run)

    @api.get("/runs/{run_id}", response_model=Run, summary="Read a run, optionally waiting for completion")
    async def read_run(run_id: str, request: Request, wait: Annotated[float, Query(ge=0, le=60)] = 0):
        deadline = time.monotonic() + wait
        while True:
            run = await run_in_threadpool(get_run, run_id, request.state.user)
            remaining = deadline - time.monotonic()
            if run["status"] not in UNFINISHED_RUN_STATUSES or remaining <= 0:
                return public_run(run)
            if await request.is_disconnected():
                return public_run(run)
            # No server worker is reserved while waiting. Reads briefly borrow one from the pool.
            await asyncio.sleep(min(0.1, remaining))

    @api.post("/runs/{run_id}/cancel", response_model=Run, summary="Request cancellation of a run")
    def cancel_run(run_id: str, request: Request):
        return public_run(jobs.engine.cancel(run_id))

    @api.get("/runs/{run_id}/log", response_class=PlainTextResponse, summary="Read the current text log")
    def log(run_id: str, request: Request):
        return run_log(request.state.automation_record)

    @api.get("/openapi.json", include_in_schema=False)
    def openapi():
        schema = get_openapi(title="Duckpad Automation API", version="1.0.0", routes=api.routes)
        schema["components"]["securitySchemes"] = {
            "BearerAuth": {"type": "http", "scheme": "bearer"},
            "SessionCookie": {"type": "apiKey", "in": "cookie", "name": "duckpad_session"},
        }
        schema["security"] = [{"BearerAuth": []}, {"SessionCookie": []}]
        return schema

    return api
