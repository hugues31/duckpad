"""Admin HTTP routes."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile as FormFile

from .. import schemas
from ..extensions import MAX_UPLOAD_BYTES as MAX_EXTENSION_BYTES
from ..resources import resource_usage
from ..types import Record
from ..util import Problem
from .context import Context
from .http import limited_body
from .security import (
    instance_admin,
    no_api_token,
)


def router(ctx: Context) -> APIRouter:
    api = APIRouter()
    store = ctx.services.store
    catalog = ctx.services.catalog
    engine = ctx.services.engine
    auth = ctx.auth
    access = ctx.access
    credentials = ctx.services.projects.remotes.credentials
    monitoring = ctx.monitoring

    @api.get("/api/resources", response_model=None, dependencies=[Depends(instance_admin)])
    def resources() -> Record:
        return resource_usage()

    @api.get("/api/monitoring", response_model=None, dependencies=[Depends(instance_admin)])
    def instance_monitoring() -> Record:
        return monitoring.snapshot()

    @api.get("/api/monitoring/logs", response_model=None, dependencies=[Depends(instance_admin)])
    def instance_logs(
        level: Literal["debug", "info", "warning", "error", "critical"] = "debug",
        q: Annotated[str, Query(max_length=200)] = "",
        limit: Annotated[int, Query(ge=1, le=200)] = 200,
    ) -> Record:
        return monitoring.logs.snapshot(level, q, limit)

    @api.get("/api/extensions/settings", response_model=None, dependencies=[Depends(instance_admin)])
    def extension_settings() -> Record:
        return engine.extension_settings()

    @api.put("/api/extensions/settings", response_model=None, dependencies=[Depends(instance_admin)])
    def save_extension_settings(data: schemas.ExtensionSettings) -> Record:
        return engine.configure_extensions(data.allow_unsigned_extensions)

    @api.get("/api/sql-resources", response_model=None, dependencies=[Depends(instance_admin)])
    def sql_resources() -> Record:
        return engine.sql_resources()

    @api.put("/api/sql-resources", response_model=None, dependencies=[Depends(instance_admin)])
    def save_sql_resources(data: schemas.SQLResources) -> Record:
        return engine.configure_sql_resources(data.model_dump())

    @api.get("/api/extensions/runtime", response_model=None, dependencies=[Depends(instance_admin)])
    def extension_runtime() -> Record:
        return engine.extension_runtime()

    @api.post(
        "/api/extensions/import",
        response_model=None,
        dependencies=[Depends(instance_admin), Depends(limited_body(MAX_EXTENSION_BYTES))],
    )
    async def import_extension(request: Request) -> Record:
        async with request.form(max_files=1, max_fields=1) as form:
            file, source = form.get("file"), form.get("source")
            if not isinstance(file, FormFile):
                raise Problem("Choose a file to upload", 422)
            if source not in ("core", "community", "unsigned"):
                raise Problem("Choose a core, community, or unsigned extension source", 422)
            return await run_in_threadpool(engine.import_extension, file.filename, source, file.file)

    @api.get("/api/catalog", response_model=None, dependencies=[Depends(instance_admin)])
    def get_catalog() -> Record:
        return catalog.public()

    @api.put("/api/catalog/{kind}", response_model=None, dependencies=[Depends(instance_admin)])
    def save_catalog(kind: str, data: dict[str, Any], create: bool = False) -> Record:
        # Results stay: each SQL session takes new settings and credentials at its next run.
        with engine.exclusive():
            catalog.save(kind, data, create=create)
        return catalog.public()

    @api.delete("/api/catalog/{kind}/{identity}", response_model=None, dependencies=[Depends(instance_admin)])
    def delete_catalog(kind: str, identity: str) -> Record:
        with engine.exclusive():
            catalog.delete(
                kind,
                identity,
                # Connectors in use cannot be deleted; a deleted connection is detached at once.
                before_change=(lambda: engine.reset_connection(identity)) if kind == "connection" else None,
            )
        return catalog.public()

    @api.post("/api/catalog/connection/test", response_model=None, dependencies=[Depends(instance_admin)])
    def test_connection(data: schemas.ConnectionTest) -> Record:
        return engine.test_connection(data.connection, data.environment)

    @api.post(
        "/api/catalog/connector/{identity}/reset", response_model=None, dependencies=[Depends(instance_admin)]
    )
    def reset_connector(identity: str) -> Record:
        with engine.exclusive():
            catalog.reset(identity)
        return catalog.public()

    @api.post("/api/environments", response_model=None, dependencies=[Depends(instance_admin)])
    def create_environment(data: schemas.NewEnvironment) -> Record:
        with engine.exclusive():
            catalog.save_environment(data.model_dump(), create=True)
        return catalog.public()

    @api.put("/api/environments/{identity}", response_model=None, dependencies=[Depends(instance_admin)])
    def update_environment(identity: str, data: schemas.EnvironmentSettings) -> Record:
        with engine.exclusive():
            catalog.save_environment({**data.model_dump(), "id": identity})
        return catalog.public()

    @api.delete("/api/environments/{identity}", response_model=None, dependencies=[Depends(instance_admin)])
    def delete_environment(identity: str) -> Record:
        with engine.exclusive():
            catalog.validate_environment_deletion(identity)
            engine.reset_catalog()
            catalog.delete_environment(identity)
        return catalog.public()

    @api.get("/api/users", response_model=None, dependencies=[Depends(instance_admin)])
    def users() -> list[Record]:
        return [auth.public(u) for u in store.all("user")]

    @api.post("/api/users", response_model=None, dependencies=[Depends(instance_admin)])
    def create_user(data: schemas.NewUser) -> Record:
        return auth.create_user(
            data.username, data.password, data.role, service=data.service, description=data.description
        )

    @api.patch("/api/users/{identity}", response_model=None, dependencies=[Depends(instance_admin)])
    def update_user(identity: str, data: schemas.UserChanges) -> Record:
        return access.update_user(identity, data.model_dump(exclude_none=True))

    @api.get(
        "/api/users/{identity}/api-tokens",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot create or manage API tokens; sign in interactively")),
            Depends(instance_admin),
        ],
    )
    def user_api_tokens(identity: str, request: Request) -> list[Record]:
        return auth.list_api_tokens(request.state.user, identity)

    @api.post(
        "/api/users/{identity}/api-tokens",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot create or manage API tokens; sign in interactively")),
            Depends(instance_admin),
        ],
    )
    def create_user_api_token(identity: str, data: schemas.NewAPIToken, request: Request) -> Record:
        return auth.create_api_token(
            request.state.user, identity, data.name, data.expires.timestamp() if data.expires else None
        )

    @api.delete(
        "/api/users/{identity}/api-tokens/{token}",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot create or manage API tokens; sign in interactively")),
            Depends(instance_admin),
        ],
    )
    def revoke_user_api_token(identity: str, token: str, request: Request) -> Record:
        auth.revoke_api_token(request.state.user, identity, token)
        return {"ok": True}

    @api.get("/api/git-hosts", response_model=None, dependencies=[Depends(instance_admin)])
    def git_hosts() -> Record:
        return credentials.public_hosts()

    @api.put("/api/git-hosts", response_model=None, dependencies=[Depends(instance_admin)])
    def save_git_hosts(data: schemas.GitHosts) -> Record:
        return credentials.save_hosts(data.known_hosts, data.prefixes)

    return api
