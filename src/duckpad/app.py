"""Authenticated FastAPI endpoints for the local workspace."""

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlparse

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, schemas
from .auth import SESSION_LIFETIME, Auth
from .bundle import bundle_to_files
from .components import group, import_definition
from .example import create_example
from .resources import resource_usage
from .services import Services
from .templates import parse_templates
from .util import Problem, clean, uid

SESSION_COOKIE = "duckpad_session"
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
UPLOAD_CHUNK = 1024 * 1024
STATIC = Path(__file__).parent / "static"


def problem_response(error: Problem):
    return JSONResponse({"error": str(error), "detail": clean(error.detail)}, status_code=error.status)


def session_token(request: Request):
    """The session cookie set by the UI, or a bearer token for API clients."""
    return request.cookies.get(SESSION_COOKIE) or request.headers.get("authorization", "").removeprefix(
        "Bearer "
    )


def create_app(home: Path, watch=True):
    services = Services.open(home, enforce_access=True)
    store, projects, catalog, engine = services.store, services.projects, services.catalog, services.engine
    auth = Auth(store)
    access = engine.access

    @asynccontextmanager
    async def lifespan(app):
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
    app.state.access = access

    def authorize(request, user):
        parts = request.url.path.strip("/").split("/")
        route = parts[1] if len(parts) > 1 else ""
        if route in ("users", "identity", "environments", "catalog", "resources"):
            access.instance_admin(user)
        elif route == "projects" and len(parts) >= 3:
            access.require(user, parts[2], "reader" if request.method == "GET" else "admin")
            if len(parts) >= 4 and parts[3] == "connections" and request.method != "GET":
                access.instance_admin(user)
        elif route == "worktrees" and len(parts) >= 3:
            read = request.method == "GET" or (request.method == "POST" and parts[3:] == ["lineage"])
            access.worktree(user, parts[2], "reader" if read else "editor")
        elif route in ("runs", "conflicts") and len(parts) >= 3:
            record = store.get("run" if route == "runs" else "conflict", parts[2])
            if not record:
                raise Problem("Resource not found", 404)
            access.worktree(user, record["worktree"], "reader" if request.method == "GET" else "editor")
        elif route not in (
            "session",
            "logout",
            "workspace",
            "projects",
            "example",
            "library",
            "runs",
            "password",
        ):
            raise Problem("Not found", 404)

    @app.exception_handler(Problem)
    async def problem_handler(request, error):
        return problem_response(error)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        errors = [{"location": ".".join(map(str, e["loc"])), "message": e["msg"]} for e in error.errors()]
        summary = "; ".join(f"{e['location']}: {e['message']}" for e in errors)
        return problem_response(Problem(f"Invalid request: {summary}", 422, errors))

    @app.middleware("http")
    async def authentication(request: Request, call_next):
        try:
            if request.url.path.startswith("/api/") and request.url.path != "/api/login":
                request.state.user = auth.check(session_token(request))
                authorize(request, request.state.user)
            if request.method not in SAFE_METHODS:
                origin = request.headers.get("origin")
                if origin and urlparse(origin).netloc != request.headers.get("host"):
                    raise Problem("Cross-origin writes are not allowed", 403)
        except Problem as error:
            return problem_response(error)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    # Session

    @app.post("/api/login")
    def login(data: schemas.Login, request: Request):
        token = auth.login(data.username, data.password, request.client.host if request.client else "local")
        response = JSONResponse(auth.check(token))
        response.set_cookie(
            SESSION_COOKIE,
            token,
            httponly=True,
            samesite="strict",
            max_age=SESSION_LIFETIME,
            secure=os.environ.get("DUCKPAD_SECURE_COOKIES") == "1" or request.url.scheme == "https",
        )
        return response

    @app.post("/api/logout")
    def logout(request: Request):
        auth.logout(session_token(request))
        response = JSONResponse({"ok": True})
        response.delete_cookie(SESSION_COOKIE)
        return response

    @app.get("/api/session")
    def session(request: Request):
        return {**request.state.user, "version": __version__}

    @app.get("/api/resources")
    def resources():
        with engine.lock:
            workers = [
                context.db.process.pid
                for context in engine.contexts.values()
                if context.db and hasattr(context.db, "process") and context.db.process.poll() is None
            ]
        return resource_usage(workers)

    # Instance

    @app.get("/api/workspace")
    def workspace(request: Request):
        user = request.state.user
        visible = [
            {**p, "role": access.role(user, p["id"])}
            for p in store.all("project")
            if access.role(user, p["id"])
        ]
        ids = {p["id"] for p in visible}
        return {
            "user": user,
            "projects": visible,
            "worktrees": [w for w in store.all("worktree") if w["project"] in ids],
            "catalog": catalog.public()
            if user["role"] == "admin"
            else {"connectors": [], "connections": [], "environments": store.get("settings", "environments")},
            "identity": store.get(
                "settings", "identity", {"name": "Duckpad user", "email": "admin@duckpad.local"}
            ),
        }

    @app.put("/api/identity")
    def identity(data: schemas.Identity):
        return store.put("settings", "identity", data.model_dump())

    @app.get("/api/catalog")
    def get_catalog():
        return catalog.public()

    @app.put("/api/catalog/{kind}")
    def save_catalog(kind: str, data: dict[str, Any]):
        with projects.lock, engine.lock:
            engine.reset_catalog()
            catalog.save(kind, data)
        return catalog.public()

    @app.delete("/api/catalog/{kind}/{identity}")
    def delete_catalog(kind: str, identity: str):
        with projects.lock, engine.lock:
            engine.reset_catalog()
            catalog.delete(kind, identity)
        return catalog.public()

    @app.put("/api/environments")
    def environments(data: list[str]):
        with projects.lock, engine.lock:
            engine.reset_catalog()
            catalog.set_environments(data)
        return catalog.public()

    @app.post("/api/worktrees/{worktree}/uploads")
    async def upload(worktree: str, file: Annotated[UploadFile, File()]):
        folder = store.home / "resources" / projects.get(worktree)["project"]
        folder.mkdir(parents=True, exist_ok=True)
        name = Path(file.filename or "data.csv").name
        path = folder / (uid() + "_" + name)
        with path.open("wb") as stream:
            while chunk := await file.read(UPLOAD_CHUNK):
                stream.write(chunk)
        return {"path": str(path), "name": name}

    # Projects and worktrees

    @app.post("/api/projects")
    def create_project(data: schemas.NewProject, request: Request):
        return access.create(request.state.user, lambda: projects.create(data.name))

    @app.post("/api/example")
    def example(request: Request):
        return access.create(
            request.state.user, lambda: create_example(projects, catalog, private=True), sample=True
        )

    @app.get("/api/users")
    def users():
        return [auth.public(u) for u in store.all("user")]

    @app.post("/api/users")
    def create_user(data: dict):
        return auth.create_user(data.get("username"), data.get("password"), data.get("role", "member"))

    @app.patch("/api/users/{identity}")
    def update_user(identity: str, data: dict):
        return access.update_user(identity, data)

    @app.post("/api/password")
    def change_password(data: dict, request: Request):
        user = store.get("user", request.state.user["id"])
        import hmac

        if not hmac.compare_digest(
            auth.hash_password(str(data.get("current", ""))[:1024], user["salt"]), user["hash"]
        ):
            raise Problem("Current password is incorrect", 403)
        access.update_user(user["id"], {"password": data.get("password")})
        return {"ok": True}

    @app.get("/api/projects/{project}/settings")
    def project_settings(project: str, request: Request):
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

    @app.put("/api/projects/{project}/members/{identity}")
    def set_member(project: str, identity: str, data: dict):
        if "role" not in data or data["role"] is None:
            raise Problem("Choose a project role")
        access.member(project, identity, data["role"])
        return {"ok": True}

    @app.delete("/api/projects/{project}/members/{identity}")
    def remove_member(project: str, identity: str):
        access.member(project, identity, None)
        return {"ok": True}

    @app.put("/api/projects/{project}/connections")
    def project_connections(project: str, data: dict):
        with projects.lock, engine.lock:
            engine.reset_project(project)
            access.grant_connections(project, data.get("connections"))
        return {"ok": True}

    @app.delete("/api/projects/{project}")
    def delete_project(project: str):
        with projects.lock, engine.lock:
            engine.reset_project(project)
            projects.delete(project)
            store.delete("access", project)
        return {"ok": True}

    @app.get("/api/library")
    def library(request: Request):
        visible = {p["id"] for p in store.all("project") if access.role(request.state.user, p["id"])}
        return projects.library(visible)

    @app.get("/api/worktrees/{worktree}")
    def get_project(worktree: str, request: Request):
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

    @app.put("/api/worktrees/{worktree}")
    def save_project(worktree: str, data: schemas.Save):
        proposal = data.files if data.files is not None else bundle_to_files(data.bundle)
        return projects.write(worktree, data.revision, proposal)

    @app.post("/api/conflicts/{conflict}/resolve")
    def resolve_conflict(conflict: str, data: schemas.Resolution):
        return projects.resolve(conflict, data.choice, data.files)

    @app.get("/api/worktrees/{worktree}/history")
    def history(worktree: str):
        return projects.history(worktree)

    @app.get("/api/worktrees/{worktree}/diff/{commit}")
    def diff(worktree: str, commit: str):
        return {"diff": projects.diff(worktree, commit)}

    @app.post("/api/worktrees/{worktree}/branches")
    def branch(worktree: str, data: schemas.NewBranch):
        return projects.branch(worktree, data.name, data.revision)

    @app.get("/api/worktrees/{worktree}/merge")
    def compare(worktree: str):
        return projects.merge_preview(worktree)

    @app.post("/api/worktrees/{worktree}/merge")
    def merge(worktree: str, data: schemas.Merge):
        return projects.merge(worktree, data.source_revision, data.target_revision, data.files)

    @app.post("/api/worktrees/{worktree}/group")
    def group_nodes(worktree: str, data: schemas.Group):
        snapshot = projects.snapshot(worktree)
        if data.revision != snapshot["revision"]:
            raise Problem("Reload the graph before grouping", 409)
        if snapshot["bundle"] is None:
            raise Problem("Project files are invalid", 422, snapshot["diagnostics"])
        bundle, selected = group(snapshot["bundle"], data.nodes, data.name, data.parameters, data.parent)
        result = projects.write(worktree, data.revision, bundle_to_files(bundle))
        result["selected"] = selected
        return result

    @app.post("/api/worktrees/{worktree}/import")
    def import_item(worktree: str, data: schemas.Import, request: Request):
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
        result = projects.write(worktree, data.revision, bundle_to_files(bundle))
        result["imported"] = key
        return result

    # Execution and results

    @app.get("/api/worktrees/{worktree}/status")
    def status(worktree: str, environment: str = "dev"):
        return engine.statuses(worktree, environment)

    @app.post("/api/worktrees/{worktree}/runs")
    def launch(worktree: str, data: schemas.Launch):
        entry_point = "ui" if data.entry_point == "ui" else "api"
        return engine.launch(worktree, data.environment, data.node, entry_point)

    @app.get("/api/runs")
    def runs(request: Request, worktree: str | None = None):
        if worktree:
            access.worktree(request.state.user, worktree)
        return list(
            reversed(
                [
                    r
                    for r in store.all("run")
                    if (not worktree or r["worktree"] == worktree)
                    and access.role(request.state.user, r["project"])
                ]
            )
        )

    @app.get("/api/runs/{run}")
    def get_run(run: str):
        record = store.get("run", run)
        if not record:
            raise Problem("Execution not found", 404)
        return record

    @app.post("/api/runs/{run}/cancel")
    def cancel(run: str):
        return engine.cancel(run)

    @app.get("/api/worktrees/{worktree}/compile/{node}")
    def compile_sql(worktree: str, node: str, environment: str = "dev"):
        return engine.compile(worktree, environment, node)

    @app.get("/api/worktrees/{worktree}/preview/{node}")
    def preview(
        worktree: str,
        node: str,
        environment: str = "dev",
        port: str = "result",
        limit: int = 100,
        offset: int = 0,
        sort: str | None = None,
        descending: bool = False,
        filters: str = "{}",
    ):
        try:
            filter_values = json.loads(filters)
        except ValueError as error:
            raise Problem("Invalid preview filters") from error
        if not isinstance(filter_values, dict):
            raise Problem("Invalid preview filters")
        return engine.preview(
            worktree, environment, node, port, limit, offset, sort, descending, filter_values
        )

    @app.get("/api/worktrees/{worktree}/generations/{identity}")
    def generation(worktree: str, identity: str, environment: str = "dev"):
        return {"valid": engine.generation_valid(worktree, environment, identity)}

    @app.post("/api/worktrees/{worktree}/lineage")
    def explain(worktree: str, data: schemas.Explain):
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

    if (STATIC / "assets").exists():
        app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")

    @app.get("/{path:path}")
    def frontend(path: str):
        if path == "api" or path.startswith("api/"):
            raise Problem("Not found", 404)
        if (STATIC / "index.html").exists():
            return FileResponse(STATIC / "index.html")
        return JSONResponse(
            {"message": "Build the frontend: cd frontend && npm install && npm run build"}, status_code=503
        )

    return app
