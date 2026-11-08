"""Jobs HTTP routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response

from .. import schemas
from ..types import Record
from .context import Context
from .deps import requester
from .security import (
    job_role,
    project_role,
)


def router(ctx: Context) -> APIRouter:
    api = APIRouter()
    store = ctx.services.store
    jobs = ctx.jobs

    @api.get(
        "/api/projects/{project}/job-nodes",
        response_model=None,
        dependencies=[Depends(project_role("reader"))],
    )
    def job_target_nodes(project: str, kind: str, ref: str) -> Record:
        _, commit = jobs.resolve(project, kind, ref)
        return jobs.scope_nodes(project, commit)

    @api.get("/api/jobs/{slug}/nodes", response_model=None, dependencies=[Depends(job_role("reader"))])
    def job_scope_nodes(slug: str) -> Record:
        job = jobs.get(slug)
        return jobs.scope_nodes(job["project"], jobs.current_commit(job))

    @api.get(
        "/api/projects/{project}/jobs", response_model=None, dependencies=[Depends(project_role("reader"))]
    )
    def list_jobs(project: str) -> list[Record]:
        return jobs.listing(project)

    @api.post(
        "/api/projects/{project}/jobs",
        response_model=None,
        status_code=201,
        dependencies=[Depends(project_role("admin"))],
    )
    def create_job(project: str, data: schemas.NewJob, request: Request) -> Record:
        return jobs.create(project, data, request.state.user)

    @api.get("/api/jobs/{slug}", response_model=None, dependencies=[Depends(job_role("reader"))])
    def get_job(slug: str) -> Record:
        return jobs.public(jobs.get(slug))

    @api.patch("/api/jobs/{slug}", response_model=None, dependencies=[Depends(job_role("admin"))])
    def update_job(slug: str, data: schemas.JobChanges) -> Record:
        return jobs.update(slug, data)

    @api.delete("/api/jobs/{slug}", response_model=None, dependencies=[Depends(job_role("admin"))])
    def delete_job(slug: str) -> Record:
        jobs.delete(slug)
        return {"ok": True}

    @api.get("/api/jobs/{slug}/version", response_model=None, dependencies=[Depends(job_role("reader"))])
    def compare_job_version(slug: str, ref: str, kind: str = "tag") -> Record:
        return jobs.compare(slug, kind, ref)

    @api.post("/api/jobs/{slug}/version", response_model=None, dependencies=[Depends(job_role("admin"))])
    def promote_job(slug: str, data: schemas.JobPromotion, request: Request) -> Record:
        return jobs.promote(slug, data, request.state.user)

    @api.get("/api/jobs/{slug}/runs", response_model=None, dependencies=[Depends(job_role("reader"))])
    def job_runs(
        slug: str, response: Response, limit: int = Query(50, ge=1, le=100), cursor: str | None = None
    ) -> list[Record]:
        rows = jobs.runs(jobs.get(slug), limit=limit + 1, cursor=cursor)
        if len(rows) > limit:
            response.headers["X-Next-Cursor"] = store.run_cursor(rows[limit - 1])
        return rows[:limit]

    @api.post(
        "/api/jobs/{slug}/runs",
        response_model=None,
        status_code=202,
        dependencies=[Depends(job_role("operator"))],
    )
    def launch_job(slug: str, data: schemas.JobLaunch, request: Request) -> Record:
        return jobs.launch(
            slug,
            data,
            requester(request),
        )

    return api
