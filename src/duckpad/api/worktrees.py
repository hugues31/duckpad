"""Worktrees HTTP routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from starlette.datastructures import UploadFile as FormFile

from .. import schemas, source_files, variables
from ..archive import write_archive
from ..builtin_templates import BUILTINS
from ..bundle import bundle_to_files
from ..comparison import CommitContext
from ..components import group, import_definition
from ..project_extensions import enabled as enabled_extensions
from ..project_view import project_view
from ..types import Record
from ..uploads import limited_body
from ..util import Problem, uid
from .context import Context
from .http import MAX_UPLOAD_BYTES, UPLOAD_CHUNK, upload_name
from .security import (
    conflict_role,
    worktree_role,
)


def router(ctx: Context) -> APIRouter:
    api = APIRouter()
    store = ctx.services.store
    projects = ctx.services.projects
    engine = ctx.services.engine
    access = ctx.access
    assistant = ctx.assistant

    @api.post(
        "/api/worktrees/{worktree}/uploads",
        response_model=None,
        dependencies=[Depends(worktree_role("editor")), Depends(limited_body(MAX_UPLOAD_BYTES))],
    )
    async def upload(worktree: str, request: Request) -> Record:
        async with request.form(max_files=1) as form:
            file = form.get("file")
            if not isinstance(file, FormFile):
                raise Problem("Choose a file to upload", 422)
            return await run_in_threadpool(save_upload, worktree, file)

    @api.get(
        "/api/worktrees/{worktree}/source-files",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def source_file_list(worktree: str) -> list[Record]:
        return source_files.list_files(store.paths.resources(projects.get(worktree)["project"]))

    @api.post(
        "/api/worktrees/{worktree}/source-preview",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def source_preview(worktree: str, data: schemas.SourcePreview) -> Record:
        snapshot = projects.snapshot(worktree)
        return source_files.preview(
            store.paths.resources(snapshot["worktree"]["project"]),
            data.file,
            data.model_dump(exclude_none=True, exclude={"file"}),
            engine.pool.probe_config(),
            enabled_extensions((snapshot.get("bundle") or {}).get("extensions")),
            store.get("settings", "offline_extensions", {}),
        )

    @api.get(
        "/api/worktrees/{worktree}", response_model=None, dependencies=[Depends(worktree_role("reader"))]
    )
    def get_project(worktree: str, request: Request) -> Record:
        return project_view(ctx.services, request.state.user, worktree)

    @api.get(
        "/api/worktrees/{worktree}/connections/{connection}/preview",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def table_source_preview(
        worktree: str, connection: str, environment: str, schema: str, table: str
    ) -> Record:
        return engine.connection_objects(worktree, connection, environment, (schema, table))

    @api.get(
        "/api/worktrees/{worktree}/connections/{connection}/objects",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def connection_objects(worktree: str, connection: str, environment: str) -> Record:
        return engine.connection_objects(worktree, connection, environment)

    @api.get(
        "/api/worktrees/{worktree}/extensions",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def project_extensions(worktree: str) -> Record:
        return engine.project_extensions(worktree)

    @api.post(
        "/api/worktrees/{worktree}/extensions/check",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def check_project_extension(worktree: str, data: schemas.ProjectExtension) -> Record:
        return engine.check_project_extension(worktree, data.name, data.source)

    @api.put(
        "/api/worktrees/{worktree}", response_model=None, dependencies=[Depends(worktree_role("editor"))]
    )
    def save_project(worktree: str, data: schemas.Save) -> Record:
        proposal = data.files if data.files is not None else bundle_to_files(data.bundle)
        return projects.write(worktree, data.revision, proposal)

    @api.post(
        "/api/worktrees/{worktree}/revert",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def revert_change(worktree: str, data: schemas.Revert) -> Record:
        return projects.revert(worktree, data.commit)

    @api.get(
        "/api/worktrees/{worktree}/archive.zip",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def download_project(worktree: str) -> Response:
        snapshot = projects.snapshot(worktree, committed=True)
        return Response(
            write_archive(snapshot["files"]),
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="duckpad-project.zip"'},
        )

    @api.post("/api/conflicts/{conflict}/resolve", response_model=None, dependencies=[Depends(conflict_role)])
    def resolve_conflict(conflict: str, data: schemas.Resolution, request: Request) -> Record:
        return assistant.actions.resolve(request.state.user, conflict, data.choice, data.files)

    @api.post(
        "/api/worktrees/{worktree}/branches",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def branch(worktree: str, data: schemas.NewBranch) -> Record:
        return projects.branch(worktree, data.name, data.revision)

    @api.post(
        "/api/worktrees/{worktree}/group",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def group_nodes(worktree: str, data: schemas.Group) -> Record:
        def transform(bundle: Record) -> tuple[Record, Record]:
            updated, selected = group(bundle, data.nodes, data.name, data.parameters, data.parent)
            return updated, {"selected": selected}

        return projects.transform(worktree, data.revision, transform, "Reload the graph before grouping")

    @api.post(
        "/api/worktrees/{worktree}/variables/{name}/rename",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def rename_variable(worktree: str, name: str, data: schemas.VariableRename) -> Record:
        # The declaration and every reference change in one commit, from one locked read.
        return projects.transform(
            worktree,
            data.revision,
            lambda bundle: (variables.rename(bundle, name, data.name), {}),
            "Reload the project before renaming a variable",
        )

    @api.get(
        "/api/worktrees/{worktree}/variables/scope",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def scope_variables(
        worktree: str, environment: str, node: str | None = None, ancestors: bool = False
    ) -> Record:
        return engine.scope_variables(worktree, environment, node, ancestors)

    @api.post(
        "/api/worktrees/{worktree}/import",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def import_item(worktree: str, data: schemas.Import, request: Request) -> Record:
        access.worktree(request.state.user, data.source_worktree)
        # Read the source first: never hold locks for two repositories at the same time.
        source = projects.snapshot(data.source_worktree)
        if source["bundle"] is None:
            raise Problem("Project files are invalid", 422)

        def transform(bundle: Record) -> tuple[Record, Record]:
            updated, key = import_definition(
                bundle,
                source["bundle"],
                data.kind,
                data.id,
                {"project": source["worktree"]["project"], "commit": source["commit"]},
            )
            return updated, {"imported": key}

        return projects.transform(
            worktree,
            data.revision,
            transform,
            "Reload the project before importing",
            context=CommitContext.IMPORT,
        )

    def save_upload(worktree: str, file: FormFile) -> dict[str, str]:
        folder = store.paths.resources(projects.get(worktree)["project"])
        folder.mkdir(parents=True, exist_ok=True)
        name = upload_name(file.filename)
        # A failed or interrupted upload never leaves a partial file under its final name.
        temporary = folder / f".{uid()}.upload"
        try:
            with temporary.open("xb") as stream:
                while chunk := file.file.read(UPLOAD_CHUNK):
                    stream.write(chunk)
            path = folder / f"{uid()}_{name}"
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        kind = source_files.FORMATS.get(path.suffix.lower())
        template = f"load_{kind}" if kind else ""
        return {"path": path.name, "name": name, "template": template, "code": BUILTINS.get(template, "")}

    return api
