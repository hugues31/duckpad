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
from .auth import SESSION_LIFETIME, USERNAME, Auth
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
    services = Services.open(home)
    store, projects, catalog, engine = services.store, services.projects, services.catalog, services.engine
    auth = Auth(store)

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
    app.state.auth = auth

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
                auth.check(session_token(request))
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
        response = JSONResponse({"username": USERNAME})
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
    def session():
        return {"username": USERNAME, "version": __version__}

    @app.get("/api/resources")
    def resources():
        return resource_usage()

    # Instance

    @app.get("/api/workspace")
    def workspace():
        return {
            "projects": store.all("project"),
            "worktrees": store.all("worktree"),
            "catalog": catalog.public(),
            "identity": projects.identity(),
        }

    @app.put("/api/identity")
    def identity(data: schemas.Identity):
        return store.put("settings", "identity", data.model_dump())

    @app.get("/api/catalog")
    def get_catalog():
        return catalog.public()

    @app.put("/api/catalog/{kind}")
    def save_catalog(kind: str, data: dict[str, Any]):
        catalog.save(kind, data)
        return catalog.public()

    @app.delete("/api/catalog/{kind}/{identity}")
    def delete_catalog(kind: str, identity: str):
        catalog.delete(kind, identity)
        return catalog.public()

    @app.put("/api/environments")
    def environments(data: list[str]):
        catalog.set_environments(data)
        return catalog.public()

    @app.post("/api/uploads")
    async def upload(file: Annotated[UploadFile, File()]):
        folder = store.home / "resources"
        folder.mkdir(exist_ok=True)
        name = Path(file.filename or "data.csv").name
        path = folder / (uid() + "_" + name)
        with path.open("wb") as stream:
            while chunk := await file.read(UPLOAD_CHUNK):
                stream.write(chunk)
        return {"path": str(path), "name": name}

    # Projects and worktrees

    @app.post("/api/projects")
    def create_project(data: schemas.NewProject):
        return projects.create(data.name)

    @app.post("/api/example")
    def example():
        return create_example(projects, catalog)

    @app.get("/api/library")
    def library():
        return projects.library()

    @app.get("/api/worktrees/{worktree}")
    def get_project(worktree: str):
        result = projects.snapshot(worktree, committed=True)
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
    def import_item(worktree: str, data: schemas.Import):
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
    def runs(worktree: str | None = None):
        return list(reversed([r for r in store.all("run") if not worktree or r["worktree"] == worktree]))

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
