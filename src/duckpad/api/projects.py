"""Projects HTTP routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile as FormFile

from .. import schemas
from ..archive import MAX_ARCHIVE_BYTES, archive_bundle, import_warnings, read_archive
from ..example import create_example
from ..python_policy import save_policy
from ..python_progress import environment_status
from ..search import search_instance
from ..types import Record
from ..uploads import limited_body
from ..util import Problem
from .context import Context
from .security import (
    instance_admin,
    project_role,
    signed_in,
)


def router(ctx: Context) -> APIRouter:
    api = APIRouter()
    store = ctx.services.store
    projects = ctx.services.projects
    catalog = ctx.services.catalog
    engine = ctx.services.engine
    access = ctx.access
    assistant = ctx.assistant

    @api.get("/api/search", response_model=None, dependencies=[Depends(signed_in)])
    def search(
        request: Request,
        q: Annotated[str, Query(max_length=200)] = "",
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
    ) -> Record:
        return search_instance(projects, request.state.user, q, limit)

    @api.get("/api/workspace", response_model=None, dependencies=[Depends(signed_in)])
    def workspace(request: Request) -> Record:
        user = request.state.user
        visible = store.visible_projects(user)
        ids = {p["id"] for p in visible}
        return {
            "user": user,
            "assistant": assistant.configuration.options(),
            "projects": visible,
            "worktrees": [w for w in store.all("worktree") if w["project"] in ids],
            "catalog": catalog.public()
            if user["role"] == "admin"
            else {
                "connectors": [],
                "connections": [],
                "environments": catalog.environment_names(),
                "environment_details": catalog.environments(),
            },
        }

    @api.get("/api/projects", response_model=None, dependencies=[Depends(signed_in)])
    def project_activity(request: Request) -> list[Record]:
        return projects.activity(request.state.user)

    @api.post("/api/projects", response_model=None, dependencies=[Depends(signed_in)])
    def create_project(data: schemas.NewProject, request: Request) -> Record:
        return access.create(request.state.user, lambda grant: projects.create(data.name, record=grant))

    @api.post(
        "/api/projects/import",
        response_model=None,
        dependencies=[Depends(signed_in), Depends(limited_body(MAX_ARCHIVE_BYTES))],
    )
    async def import_project(request: Request) -> Record:
        async with request.form(max_files=1, max_fields=1) as form:
            file, name = form.get("file"), form.get("name", "")
            if not isinstance(file, FormFile):
                raise Problem("Choose a file to upload", 422)
            if not isinstance(name, str):
                raise Problem("Choose a project name", 422)
            return await run_in_threadpool(import_project_file, request, file, name)

    @api.post("/api/example", response_model=None, dependencies=[Depends(signed_in)])
    def example(request: Request, data: schemas.NewExample | None = None) -> Record:
        return access.create(
            request.state.user,
            lambda grant: create_example(projects, catalog, data.name if data else None, grant),
            sample=True,
        )

    @api.get(
        "/api/projects/{project}/settings",
        response_model=None,
        dependencies=[Depends(project_role("reader"))],
    )
    def project_settings(project: str, request: Request) -> Record:
        return access.settings(project, request.state.user)

    @api.get(
        "/api/projects/{project}/python/environment",
        response_model=None,
        dependencies=[Depends(project_role("reader"))],
    )
    def python_environment_status(project: str) -> Record:
        return environment_status(store.home, project)

    @api.put(
        "/api/projects/{project}/python",
        response_model=None,
        dependencies=[Depends(project_role("admin")), Depends(instance_admin)],
    )
    def python_policy(project: str, data: schemas.PythonPolicy) -> Record:
        return save_policy(engine, project, data.model_dump())

    @api.put(
        "/api/projects/{project}/members/{identity}",
        response_model=None,
        dependencies=[Depends(project_role("admin"))],
    )
    def set_member(project: str, identity: str, data: schemas.ProjectRole) -> Record:
        access.member(project, identity, data.role)
        return {"ok": True}

    @api.delete(
        "/api/projects/{project}/members/{identity}",
        response_model=None,
        dependencies=[Depends(project_role("admin"))],
    )
    def remove_member(project: str, identity: str) -> Record:
        access.member(project, identity, None)
        return {"ok": True}

    @api.put(
        "/api/projects/{project}/connections",
        response_model=None,
        dependencies=[Depends(project_role("admin")), Depends(instance_admin)],
    )
    def project_connections(project: str, data: schemas.ConnectionGrants) -> Record:
        with engine.exclusive(project):
            # A revoked connection is detached at once; new grants are attached at the next run.
            revoked = set(access.record(project)["connections"]) - set(data.connections)
            access.grant_connections(
                project,
                data.connections,
                before_change=(lambda: engine.reset_project(project)) if revoked else None,
            )
        return {"ok": True}

    @api.delete("/api/projects/{project}", response_model=None, dependencies=[Depends(project_role("admin"))])
    def delete_project(project: str) -> Record:
        with engine.exclusive(project):
            engine.reset_project(project)
            projects.delete(project)
        return {"ok": True}

    @api.get("/api/library", response_model=None, dependencies=[Depends(signed_in)])
    def library(request: Request) -> list[Record]:
        return projects.library({p["id"] for p in store.visible_projects(request.state.user)})

    def import_project_file(request: Request, file: FormFile, name: str) -> Record:
        bundle = archive_bundle(read_archive(file.file))
        flow_name = bundle["flow"].get("name")
        name = name.strip() or (flow_name.strip() if isinstance(flow_name, str) else "") or "Imported project"
        worktree = access.create(
            request.state.user, lambda grant: projects.create(name, bundle, "import", record=grant)
        )
        return {
            **worktree,
            "warnings": import_warnings(bundle, access.record(worktree["project"])["connections"]),
        }

    return api
