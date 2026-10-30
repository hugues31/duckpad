"""Authenticated FastAPI endpoints for the local workspace."""

from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import AsyncIterator, Iterator, Mapping
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path, PureWindowsPath
from typing import Annotated, Any, Literal
from urllib.parse import quote, urlparse

from fastapi import FastAPI, File, Form, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile as FormFile
from starlette.exceptions import HTTPException
from starlette.middleware.base import RequestResponseEndpoint

from . import __version__, schemas
from .archive import archive_bundle, import_warnings, read_archive, write_archive
from .artifacts import CHUNK_SIZE
from .auth import SESSION_LIFETIME, Auth
from .bundle import bundle_to_files
from .components import group, import_definition
from .example import create_example
from .git.identity import commit_author
from .oidc import CALLBACK_PATH, OIDC, TRANSACTION_LIFETIME, OIDCSettings
from .resources import resource_usage
from .search import search_instance
from .services import Services
from .templates import parse_templates
from .types import Record
from .util import Problem, clean, uid

SESSION_COOKIE = "duckpad_session"
OIDC_COOKIE = "duckpad_oidc"
PUBLIC_API_PATHS = {"/api/login", "/api/oidc/provider", "/api/oidc/login", CALLBACK_PATH}
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
UPLOAD_CHUNK = 1024 * 1024
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
# File systems commonly limit names to 255 bytes, including the unique prefix.
MAX_UPLOAD_NAME_BYTES = 200
STATIC = Path(__file__).parent / "static"

logger = logging.getLogger(__name__)


def problem_response(error: Problem, headers: Mapping[str, str] | None = None) -> JSONResponse:
    return JSONResponse(
        {"error": str(error), "detail": clean(error.detail)}, status_code=error.status, headers=headers
    )


def upload_name(filename: str | None) -> str:
    """The client's base file name, whatever its path separators, without control characters."""
    name = re.sub(r"[\x00-\x1f\x7f]", "", PureWindowsPath(filename or "").name).strip()
    return name.encode()[-MAX_UPLOAD_NAME_BYTES:].decode(errors="ignore") or "data.csv"


def session_token(request: Request) -> str:
    """The session cookie set by the UI, or a bearer token for API clients."""
    return request.cookies.get(SESSION_COOKIE) or request.headers.get("authorization", "").removeprefix(
        "Bearer "
    )


def secure_cookies(request: Request) -> bool:
    return os.environ.get("DUCKPAD_SECURE_COOKIES") == "1" or request.url.scheme == "https"


def set_session_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        max_age=SESSION_LIFETIME,
        secure=secure_cookies(request),
    )


def create_app(home: Path, watch: bool = True, *, trusted_local: bool = False) -> FastAPI:
    services = Services.open(home, enforce_access=True, trusted_local=trusted_local)
    store, projects, catalog, engine = services.store, services.projects, services.catalog, services.engine
    auth = Auth(store)
    oidc = OIDC(store, auth)
    access = engine.access
    assert access is not None
    credentials = projects.remotes.credentials

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if watch:
            projects.start_watcher()
        yield
        services.close()

    app = FastAPI(
        title="Duckpad",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.services = services
    app.state.auth = auth
    app.state.oidc = oidc
    app.state.access = access

    def authorize(request: Request, user: Record) -> None:
        parts = request.url.path.strip("/").split("/")
        route = parts[1] if len(parts) > 1 else ""
        if route in ("users", "environments", "catalog", "resources", "sso", "extensions", "git-hosts"):
            access.instance_admin(user)
        elif route == "projects" and len(parts) >= 3 and parts[2:] != ["import"]:
            access.require(user, parts[2], "reader" if request.method == "GET" else "admin")
            if len(parts) >= 4 and parts[3] == "connections" and request.method != "GET":
                access.instance_admin(user)
        elif route == "worktrees" and len(parts) >= 3:
            read = request.method == "GET" or (request.method == "POST" and parts[3:] == ["lineage"])
            access.worktree(user, parts[2], "reader" if read else "editor")
            if parts[3:] == ["git", "remote"] and request.method == "PUT":
                access.worktree(user, parts[2], "admin")
        elif route in ("runs", "conflicts") and len(parts) >= 3:
            record = store.get("run" if route == "runs" else "conflict", parts[2])
            if not record:
                raise Problem("Resource not found", 404)
            access.worktree(user, record["worktree"], "reader" if request.method == "GET" else "editor")
        elif route not in (
            "session",
            "logout",
            "workspace",
            "search",
            "projects",
            "example",
            "library",
            "runs",
            "password",
            "ssh-key",
        ):
            raise Problem("Not found", 404)

    @app.exception_handler(Problem)
    async def problem_handler(request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, Problem)
        return problem_response(error)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, RequestValidationError)
        errors = [{"location": ".".join(map(str, e["loc"])), "message": e["msg"]} for e in error.errors()]
        summary = "; ".join(f"{e['location']}: {e['message']}" for e in errors)
        return problem_response(Problem(f"Invalid request: {summary}", 422, errors))

    @app.exception_handler(HTTPException)
    async def http_problem(request: Request, error: Exception) -> JSONResponse:
        # Framework errors, such as unsupported methods or malformed forms, use the same format.
        assert isinstance(error, HTTPException)
        return problem_response(Problem(str(error.detail), error.status_code), error.headers)

    @app.middleware("http")
    async def authentication(request: Request, call_next: RequestResponseEndpoint) -> Response:
        try:
            if request.url.path.startswith("/api/") and request.url.path not in PUBLIC_API_PATHS:
                request.state.user = auth.check(session_token(request))
                authorize(request, request.state.user)
            if request.method not in SAFE_METHODS:
                origin = request.headers.get("origin")
                if origin and urlparse(origin).netloc != request.headers.get("host"):
                    raise Problem("Cross-origin writes are not allowed", 403)
            user = getattr(request.state, "user", None)
            with commit_author(auth.commit_identity(user) if user else None):
                response = await call_next(request)
        except Problem as error:
            response = problem_response(error)
        except Exception:
            # The traceback stays in the server log; clients never see internal details.
            logger.exception("Unexpected error in %s %s", request.method, request.url.path)
            response = problem_response(Problem("Internal server error", 500))
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = (
            "no-referrer" if request.url.path.startswith("/api/oidc/") else "same-origin"
        )
        # The inspector uses a same-origin frame for native attachment downloads and JSON errors.
        response.headers["X-Frame-Options"] = (
            "SAMEORIGIN" if getattr(request.scope.get("route"), "name", "") == "download_export" else "DENY"
        )
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    # Keep the existing JSON serialization; return annotations are static contracts only.
    # Session

    @app.post("/api/login", response_model=None)
    def login(data: schemas.Login, request: Request) -> JSONResponse:
        token = auth.login(data.username, data.password, request.client.host if request.client else "local")
        response = JSONResponse(auth.check(token))
        auth.logout(session_token(request))
        set_session_cookie(response, request, token)
        return response

    @app.get("/api/sso", response_model=None)
    def sso_settings() -> Record:
        return oidc.public_settings()

    @app.put("/api/sso", response_model=None)
    def save_sso_settings(data: OIDCSettings) -> Record:
        return oidc.save(data)

    @app.get("/api/oidc/provider", response_model=None)
    def sso_provider() -> dict[str, str] | None:
        config = oidc.settings()
        return {"label": config["label"]} if config["enabled"] else None

    @app.get("/api/oidc/login", response_model=None)
    def sso_login(request: Request) -> RedirectResponse:
        try:
            url, browser = oidc.start()
        except Problem:
            return RedirectResponse("/?sso_error=failed", status_code=303)
        response = RedirectResponse(url, status_code=303)
        response.set_cookie(
            OIDC_COOKIE,
            browser,
            httponly=True,
            samesite="lax",
            max_age=TRANSACTION_LIFETIME,
            path="/api/oidc",
            secure=secure_cookies(request),
        )
        return response

    @app.get(CALLBACK_PATH, response_model=None)
    def sso_callback(request: Request) -> RedirectResponse:
        try:
            token = oidc.finish(request.query_params, request.cookies.get(OIDC_COOKIE))
            auth.logout(session_token(request))
            response = RedirectResponse("/", status_code=303)
            set_session_cookie(response, request, token)
        except Problem:
            # Provider error details and tokens must not reach the browser or logs.
            response = RedirectResponse("/?sso_error=failed", status_code=303)
        response.delete_cookie(
            OIDC_COOKIE, path="/api/oidc", secure=secure_cookies(request), httponly=True, samesite="lax"
        )
        return response

    @app.post("/api/logout", response_model=None)
    def logout(request: Request) -> JSONResponse:
        auth.logout(session_token(request))
        response = JSONResponse({"ok": True})
        response.delete_cookie(SESSION_COOKIE)
        return response

    @app.get("/api/session", response_model=None)
    def session(request: Request) -> Record:
        return {**request.state.user, "version": __version__}

    @app.get("/api/resources", response_model=None)
    def resources() -> Record:
        return resource_usage()

    # Instance

    @app.get("/api/search", response_model=None)
    def search(
        request: Request,
        q: Annotated[str, Query(max_length=200)] = "",
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
    ) -> Record:
        return search_instance(projects, request.state.user, q, limit)

    @app.get("/api/workspace", response_model=None)
    def workspace(request: Request) -> Record:
        user = request.state.user
        visible = store.visible_projects(user)
        ids = {p["id"] for p in visible}
        return {
            "user": user,
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

    @app.get("/api/extensions/settings", response_model=None)
    def extension_settings() -> Record:
        return engine.extension_settings()

    @app.put("/api/extensions/settings", response_model=None)
    def save_extension_settings(data: schemas.ExtensionSettings) -> Record:
        return engine.configure_extensions(data.allow_unsigned_extensions)

    @app.get("/api/extensions/runtime", response_model=None)
    def extension_runtime() -> Record:
        return engine.extension_runtime()

    @app.post("/api/extensions/import", response_model=None)
    def import_extension(
        file: Annotated[UploadFile, File()],
        source: Annotated[Literal["core", "community", "unsigned"], Form()],
    ) -> Record:
        return engine.import_extension(file.filename, source, file.file)

    @app.get("/api/catalog", response_model=None)
    def get_catalog() -> Record:
        return catalog.public()

    @app.put("/api/catalog/{kind}", response_model=None)
    def save_catalog(kind: str, data: dict[str, Any], create: bool = False) -> Record:
        with engine.exclusive():
            catalog.save(kind, data, create=create, before_change=engine.reset_catalog)
        return catalog.public()

    @app.delete("/api/catalog/{kind}/{identity}", response_model=None)
    def delete_catalog(kind: str, identity: str) -> Record:
        with engine.exclusive():
            catalog.delete(kind, identity, before_change=engine.reset_catalog)
        return catalog.public()

    @app.post("/api/environments", response_model=None)
    def create_environment(data: schemas.NewEnvironment) -> Record:
        with engine.exclusive():
            catalog.save_environment(data.model_dump(), create=True)
        return catalog.public()

    @app.put("/api/environments/{identity}", response_model=None)
    def update_environment(identity: str, data: schemas.EnvironmentSettings) -> Record:
        with engine.exclusive():
            catalog.save_environment({**data.model_dump(), "id": identity})
        return catalog.public()

    @app.delete("/api/environments/{identity}", response_model=None)
    def delete_environment(identity: str) -> Record:
        with engine.exclusive():
            catalog.validate_environment_deletion(identity)
            engine.reset_catalog()
            catalog.delete_environment(identity)
        return catalog.public()

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
        # File parameters still need the server path; the project files already store it.
        return {"path": str(path), "name": name}

    @app.post("/api/worktrees/{worktree}/uploads", response_model=None)
    async def upload(worktree: str, request: Request) -> Record:
        # Without chunked transfer encoding, the server never reads past Content-Length,
        # so oversized uploads are refused before any of their content is received.
        length = request.headers.get("content-length", "")
        if not length.isdigit() or "transfer-encoding" in request.headers:
            raise Problem("Send the upload with a Content-Length header", 411)
        if int(length) > MAX_UPLOAD_BYTES:
            raise Problem("Uploads are limited to 1 GiB", 413)
        async with request.form(max_files=1) as form:
            file = form.get("file")
            if not isinstance(file, FormFile):
                raise Problem("Choose a file to upload", 422)
            return await run_in_threadpool(save_upload, worktree, file)

    # Projects and worktrees

    @app.post("/api/projects", response_model=None)
    def create_project(data: schemas.NewProject, request: Request) -> Record:
        return access.create(request.state.user, lambda grant: projects.create(data.name, record=grant))

    @app.post("/api/projects/import", response_model=None)
    def import_project(
        request: Request, file: Annotated[UploadFile, File()], name: Annotated[str, Form()] = ""
    ) -> Record:
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

    @app.post("/api/example", response_model=None)
    def example(request: Request, data: schemas.NewExample | None = None) -> Record:
        return access.create(
            request.state.user,
            lambda grant: create_example(projects, catalog, data.name if data else None, grant),
            sample=True,
        )

    @app.get("/api/users", response_model=None)
    def users() -> list[Record]:
        return [auth.public(u) for u in store.all("user")]

    @app.post("/api/users", response_model=None)
    def create_user(data: schemas.NewUser) -> Record:
        return auth.create_user(data.username, data.password, data.role)

    @app.patch("/api/users/{identity}", response_model=None)
    def update_user(identity: str, data: schemas.UserChanges) -> Record:
        return access.update_user(identity, data.model_dump(exclude_none=True))

    @app.post("/api/password", response_model=None)
    def change_password(data: schemas.PasswordChange, request: Request) -> Record:
        auth.confirm_password(request.state.user["id"], data.current)
        access.update_user(request.state.user["id"], {"password": data.password})
        return {"ok": True}

    @app.get("/api/ssh-key", response_model=None)
    def ssh_key(request: Request) -> Record | None:
        return credentials.public_key(request.state.user["id"])

    @app.post("/api/ssh-key", response_model=None)
    def generate_ssh_key(request: Request) -> Record:
        return credentials.generate_key(request.state.user)

    @app.delete("/api/ssh-key", response_model=None)
    def delete_ssh_key(request: Request) -> Record:
        credentials.delete_key(request.state.user["id"])
        return {"ok": True}

    @app.get("/api/git-hosts", response_model=None)
    def git_hosts() -> Record:
        return credentials.public_hosts()

    @app.put("/api/git-hosts", response_model=None)
    def save_git_hosts(data: schemas.GitHosts) -> Record:
        return credentials.save_hosts(data.known_hosts, data.prefixes)

    @app.get("/api/projects/{project}/settings", response_model=None)
    def project_settings(project: str, request: Request) -> Record:
        role = access.role(request.state.user, project)
        record = access.record(project)
        directory = [auth.public(u) for u in store.all("user")]
        return {
            "project": store.get("project", project),
            "role": role,
            "members": [
                {
                    "id": u["id"],
                    "username": u["username"],
                    "active": u["active"],
                    "role": record["members"][u["id"]],
                }
                for u in directory
                if u["id"] in record["members"]
            ],
            "users": [{"id": u["id"], "username": u["username"]} for u in directory if u["active"]]
            if role == "admin"
            else [],
            "connections": record["connections"],
        }

    @app.put("/api/projects/{project}/members/{identity}", response_model=None)
    def set_member(project: str, identity: str, data: schemas.ProjectRole) -> Record:
        access.member(project, identity, data.role)
        return {"ok": True}

    @app.delete("/api/projects/{project}/members/{identity}", response_model=None)
    def remove_member(project: str, identity: str) -> Record:
        access.member(project, identity, None)
        return {"ok": True}

    @app.put("/api/projects/{project}/connections", response_model=None)
    def project_connections(project: str, data: schemas.ConnectionGrants) -> Record:
        with engine.exclusive(project):
            access.grant_connections(
                project, data.connections, before_change=lambda: engine.reset_project(project)
            )
        return {"ok": True}

    @app.delete("/api/projects/{project}", response_model=None)
    def delete_project(project: str) -> Record:
        with engine.exclusive(project):
            engine.reset_project(project)
            projects.delete(project)
        return {"ok": True}

    @app.get("/api/library", response_model=None)
    def library(request: Request) -> list[Record]:
        return projects.library({p["id"] for p in store.visible_projects(request.state.user)})

    @app.get("/api/worktrees/{worktree}", response_model=None)
    def get_project(worktree: str, request: Request) -> Record:
        result = projects.snapshot(worktree, committed=True)
        project = result["worktree"]["project"]
        result["role"] = access.role(request.state.user, project)
        result["connections"] = [
            {
                "id": c["id"],
                "name": c["name"],
                "capabilities": store.get("connector", c["connector"], {}).get("capabilities", []),
            }
            for c in store.all("connection")
            if c["id"] in access.record(project)["connections"]
        ]
        result["parsed_templates"] = parse_templates((result["bundle"] or {}).get("templates", {}))
        return result

    @app.put("/api/worktrees/{worktree}", response_model=None)
    def save_project(worktree: str, data: schemas.Save) -> Record:
        proposal = data.files if data.files is not None else bundle_to_files(data.bundle)
        return projects.write(worktree, data.revision, proposal)

    @app.get("/api/worktrees/{worktree}/archive.zip", response_model=None)
    def download_project(worktree: str) -> Response:
        snapshot = projects.snapshot(worktree, committed=True)
        return Response(
            write_archive(snapshot["files"]),
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="duckpad-project.zip"'},
        )

    @app.post("/api/conflicts/{conflict}/resolve", response_model=None)
    def resolve_conflict(conflict: str, data: schemas.Resolution) -> Record:
        return projects.resolve(conflict, data.choice, data.files)

    @app.get("/api/worktrees/{worktree}/git/history", response_model=None)
    def git_history(
        worktree: str,
        ref: str = "HEAD",
        offset: int = Query(default=0, ge=0),
        limit: int = Query(default=50, ge=1, le=100),
        entity: str | None = None,
    ) -> Record:
        return projects.versioning.history(worktree, ref, offset, limit, entity)

    @app.get("/api/worktrees/{worktree}/git/compare", response_model=None)
    def git_compare(worktree: str, a: str = "HEAD", b: str = "working") -> Record:
        return projects.versioning.compare(worktree, a, b)

    @app.get("/api/worktrees/{worktree}/git/branches", response_model=None)
    def git_branches(worktree: str) -> list[Record]:
        return projects.versioning.branches(worktree)

    @app.post("/api/worktrees/{worktree}/git/open", response_model=None)
    def git_open(worktree: str, data: schemas.NewBranch) -> Record:
        return projects.versioning.open_branch(worktree, data.name)

    @app.post("/api/worktrees/{worktree}/git/cleanup", response_model=None)
    def git_cleanup(worktree: str, data: schemas.BranchCleanup) -> Record:
        with engine.exclusive(projects.get(worktree)["project"]):
            engine.require_idle(data.remove_worktree)
            result = projects.versioning.cleanup(
                worktree, data.remove_worktree, data.integrated_worktree, data.expected_head
            )
            engine.discard_worktree(data.remove_worktree)
            return result

    @app.post("/api/worktrees/{worktree}/git/reviews", response_model=None)
    def git_review(worktree: str, data: schemas.GitReview) -> Record:
        return projects.versioning.prepare(worktree, data.source)

    @app.post("/api/worktrees/{worktree}/git/reviews/{review}", response_model=None)
    def git_choices(worktree: str, review: str, data: schemas.GitChoices) -> Record:
        return projects.versioning.proposal(worktree, review, data.choices)

    @app.post("/api/worktrees/{worktree}/git/reviews/{review}/apply", response_model=None)
    def git_apply(worktree: str, review: str, data: schemas.GitApply) -> Record:
        return projects.versioning.apply(worktree, review, data.choices, data.proposal_revision)

    @app.get("/api/worktrees/{worktree}/git/remote", response_model=None)
    def git_remote(worktree: str) -> Record:
        return projects.remotes.status(worktree)

    @app.put("/api/worktrees/{worktree}/git/remote", response_model=None)
    def git_configure(worktree: str, data: schemas.RemoteConfiguration) -> Record:
        return projects.remotes.configure(worktree, data.url, data.remote_branch, data.config_revision)

    @app.post("/api/worktrees/{worktree}/git/consent", response_model=None)
    def git_consent(worktree: str, data: schemas.GitConsent, request: Request) -> Record:
        return projects.remotes.consent(worktree, request.state.user, data.url)

    @app.post("/api/worktrees/{worktree}/git/fetch", response_model=None)
    def git_fetch(worktree: str, data: schemas.RemoteState, request: Request) -> Record:
        return projects.remotes.fetch(worktree, data.config_revision, request.state.user)

    @app.post("/api/worktrees/{worktree}/git/pull", response_model=None)
    def git_pull(worktree: str, data: schemas.RemoteHeads) -> Record:
        return projects.remotes.pull(worktree, data.config_revision, data.local_head, data.remote_head)

    @app.post("/api/worktrees/{worktree}/git/push", response_model=None)
    def git_push(worktree: str, data: schemas.RemoteHeads, request: Request) -> Record:
        return projects.remotes.push(
            worktree,
            data.config_revision,
            data.local_head,
            data.remote_head,
            data.recreate,
            request.state.user,
        )

    @app.post("/api/worktrees/{worktree}/branches", response_model=None)
    def branch(worktree: str, data: schemas.NewBranch) -> Record:
        return projects.branch(worktree, data.name, data.revision)

    @app.post("/api/worktrees/{worktree}/group", response_model=None)
    def group_nodes(worktree: str, data: schemas.Group) -> Record:
        snapshot = projects.snapshot(worktree)
        if data.revision != snapshot["revision"]:
            raise Problem("Reload the graph before grouping", 409)
        if snapshot["bundle"] is None:
            raise Problem("Project files are invalid", 422, snapshot["diagnostics"])
        bundle, selected = group(snapshot["bundle"], data.nodes, data.name, data.parameters, data.parent)
        result = projects.write(worktree, data.revision, bundle_to_files(bundle))
        result["selected"] = selected
        return result

    @app.post("/api/worktrees/{worktree}/import", response_model=None)
    def import_item(worktree: str, data: schemas.Import, request: Request) -> Record:
        access.worktree(request.state.user, data.source_worktree)
        snapshot = projects.snapshot(worktree)
        source = projects.snapshot(data.source_worktree)
        if snapshot["bundle"] is None or source["bundle"] is None:
            raise Problem("Project files are invalid", 422)
        bundle, key = import_definition(
            snapshot["bundle"],
            source["bundle"],
            data.kind,
            data.id,
            {"project": source["worktree"]["project"], "commit": source["commit"]},
        )
        result = projects.write(
            worktree, data.revision, bundle_to_files(bundle), "feat(project): import definition"
        )
        result["imported"] = key
        return result

    # Execution and results

    @app.get("/api/worktrees/{worktree}/status", response_model=None)
    def status(worktree: str, environment: str) -> Record:
        return engine.statuses(worktree, environment)

    @app.post("/api/worktrees/{worktree}/runs", response_model=None)
    def launch(worktree: str, data: schemas.Launch) -> Record:
        entry_point = "ui" if data.entry_point == "ui" else "api"
        settings = catalog.environment(data.environment)
        # The interface asks before running in a protected environment; API clients run directly.
        if entry_point == "ui" and settings["confirm_before_run"] and not data.confirmed:
            raise Problem("Confirm this environment before running", 409, {"confirmation_required": settings})
        return engine.launch(worktree, data.environment, data.node, entry_point)

    @app.get("/api/runs", response_model=None)
    def runs(request: Request, worktree: str | None = None) -> list[Record]:
        if worktree:
            access.worktree(request.state.user, worktree)
        return store.runs(request.state.user, worktree)

    @app.get("/api/runs/{run}", response_model=None)
    def get_run(run: str) -> Record:
        record = store.get("run", run)
        if not record:
            raise Problem("Execution not found", 404)
        return record

    @app.post("/api/runs/{run}/cancel", response_model=None)
    def cancel(run: str) -> Record:
        return engine.cancel(run)

    @app.get("/api/worktrees/{worktree}/compile/{node}", response_model=None)
    def compile_sql(worktree: str, node: str, environment: str) -> list[Record]:
        return engine.compile(worktree, environment, node)

    @app.get("/api/worktrees/{worktree}/exports/{node}", response_model=None)
    def export_result(worktree: str, node: str, environment: str) -> Record:
        return engine.export_result(worktree, environment, node)

    @app.get("/api/worktrees/{worktree}/exports/{node}/download", response_model=None)
    def download_export(worktree: str, node: str, run: str, environment: str) -> StreamingResponse:
        opened = ExitStack()
        stream, record = opened.enter_context(engine.open_export(worktree, environment, node, run))

        def chunks() -> Iterator[bytes]:
            try:
                while chunk := stream.read(CHUNK_SIZE):
                    yield chunk
            finally:
                opened.close()

        return StreamingResponse(
            chunks(),
            media_type=record["media_type"],
            headers={
                "Content-Disposition": "attachment; filename*=UTF-8''" + quote(record["filename"], safe=""),
                "Content-Length": str(record["size"]),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
            background=BackgroundTask(opened.close),
        )

    @app.get("/api/worktrees/{worktree}/preview/{node}", response_model=None)
    def preview(
        worktree: str,
        node: str,
        environment: str,
        port: str = "result",
        limit: int = 100,
        offset: int = 0,
        sort: str | None = None,
        descending: bool = False,
        filters: str = "{}",
    ) -> Record:
        try:
            filter_values = json.loads(filters)
        except ValueError as error:
            raise Problem("Invalid preview filters") from error
        if not isinstance(filter_values, dict):
            raise Problem("Invalid preview filters")
        return engine.preview(
            worktree, environment, node, port, limit, offset, sort, descending, filter_values
        )

    @app.get("/api/worktrees/{worktree}/generations/{identity}", response_model=None)
    def generation(worktree: str, identity: str, environment: str) -> Record:
        return {"valid": engine.generation_valid(worktree, environment, identity)}

    @app.post("/api/worktrees/{worktree}/lineage", response_model=None)
    def explain(worktree: str, data: schemas.Explain) -> Record:
        return services.lineage.explain(
            worktree,
            data.environment,
            data.dataset,
            data.row,
            data.column,
            data.offset,
            data.group,
            data.context,
        )

    # Interface

    if (STATIC / "site" / "index.html").exists():
        app.mount("/site", StaticFiles(directory=STATIC / "site", html=True), name="website")

    if (STATIC / "assets").exists():
        app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")

    @app.get("/{path:path}", response_model=None)
    def frontend(path: str) -> Response:
        if path == "api" or path.startswith("api/"):
            raise Problem("Not found", 404)
        if (STATIC / "index.html").exists():
            return FileResponse(STATIC / "index.html")
        return JSONResponse(
            {"message": "Build the frontend: cd frontend && npm install && npm run build"}, status_code=503
        )

    return app
