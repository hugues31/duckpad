"""Authenticated FastAPI endpoints for the local workspace."""

import copy
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .auth import Auth
from .catalog import Catalog
from .components import group, import_definition
from .engine import Engine
from .example import create_example
from .lineage import Lineage
from .lineage_explorer import LineageExplorer
from .lineage_models import CancelRequest, Records, RecordsRequest, Stage, StageRequest
from .projects import Projects, bundle_to_files
from .store import Store
from .templates import parse_template
from .util import Problem, clean, uid


class Login(BaseModel):
    username: str = "admin"
    password: str


def create_app(home: Path, watch=True):
    store = Store(home)
    auth, projects, catalog = Auth(store), Projects(store), Catalog(store)
    engine = Engine(store, projects, catalog)
    lineage = Lineage(engine)
    explorer = LineageExplorer(engine)
    projects.on_change = engine.invalidate
    catalog.on_change = engine.invalidate

    @asynccontextmanager
    async def lifespan(app):
        if watch:
            projects.start_watcher()
        yield
        projects.stop()
        engine.close()
        store.close()

    app = FastAPI(
        title="Duckpad", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )
    app.state.services = (store, projects, catalog, engine)
    app.state.auth = auth

    @app.exception_handler(Problem)
    async def problem_handler(request, error):
        return JSONResponse({"error": str(error), "detail": clean(error.detail)}, status_code=error.status)

    @app.middleware("http")
    async def authentication(request: Request, call_next):
        try:
            if request.url.path.startswith("/api/") and request.url.path != "/api/login":
                token = request.cookies.get("duckpad_session") or request.headers.get(
                    "authorization", ""
                ).removeprefix("Bearer ")
                auth.check(token)
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                origin = request.headers.get("origin")
                if origin and urlparse(origin).netloc != request.headers.get("host"):
                    raise Problem("Cross-origin writes are not allowed", 403)
            response = await call_next(request)
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "same-origin"
            response.headers["X-Frame-Options"] = "DENY"
            if request.url.path.startswith("/api/"):
                response.headers["Cache-Control"] = "no-store"
            return response
        except Problem as error:
            return JSONResponse(
                {"error": str(error), "detail": clean(error.detail)}, status_code=error.status
            )

    @app.post("/api/login")
    def login(data: Login, request: Request):
        token = auth.login(data.username, data.password, request.client.host if request.client else "local")
        response = JSONResponse({"username": "admin"})
        response.set_cookie(
            "duckpad_session",
            token,
            httponly=True,
            samesite="strict",
            max_age=604800,
            secure=os.environ.get("DUCKPAD_SECURE_COOKIES") == "1" or request.url.scheme == "https",
        )
        return response

    @app.post("/api/logout")
    def logout(request: Request):
        auth.logout(request.cookies.get("duckpad_session"))
        response = JSONResponse({"ok": True})
        response.delete_cookie("duckpad_session")
        return response

    @app.get("/api/session")
    def session():
        return {"username": "admin", "version": "0.1.0"}

    @app.get("/api/workspace")
    def workspace():
        return {
            "projects": store.all("project"),
            "worktrees": store.all("worktree"),
            "catalog": catalog.public(),
            "identity": store.get(
                "settings", "identity", {"name": "Duckpad user", "email": "admin@duckpad.local"}
            ),
        }

    @app.put("/api/identity")
    def identity(data: dict):
        if not data.get("name") or not data.get("email"):
            raise Problem("Name and email are required")
        return store.put("settings", "identity", {"name": data["name"], "email": data["email"]})

    @app.post("/api/projects")
    def create_project(data: dict):
        return projects.create(str(data.get("name", "Untitled project")))

    @app.post("/api/example")
    def example():
        return create_example(projects, catalog)

    @app.get("/api/worktrees/{worktree}")
    def get_project(worktree: str):
        result = projects.snapshot(worktree, committed=True)
        parsed = {}
        for name, value in (result["bundle"] or {}).get("templates", {}).items():
            try:
                parsed[name] = parse_template(value)
            except Problem as error:
                parsed[name] = {"error": str(error)}
        result["parsed_templates"] = parsed
        return result

    @app.put("/api/worktrees/{worktree}")
    def save_project(worktree: str, data: dict):
        proposal = data["files"] if "files" in data else bundle_to_files(data["bundle"])
        return projects.write(worktree, data["revision"], proposal)

    @app.post("/api/conflicts/{conflict}/resolve")
    def resolve_conflict(conflict: str, data: dict):
        return projects.resolve(conflict, data["choice"], data.get("files"))

    @app.get("/api/worktrees/{worktree}/history")
    def history(worktree: str):
        return projects.history(worktree)

    @app.get("/api/worktrees/{worktree}/diff/{commit}")
    def diff(worktree: str, commit: str):
        return {"diff": projects.diff(worktree, commit)}

    @app.post("/api/worktrees/{worktree}/branches")
    def branch(worktree: str, data: dict):
        return projects.branch(worktree, data["name"], data.get("revision"))

    @app.get("/api/worktrees/{worktree}/merge")
    def compare(worktree: str):
        return projects.merge_preview(worktree)

    @app.post("/api/worktrees/{worktree}/merge")
    def merge(worktree: str, data: dict):
        return projects.merge(worktree, data["source_revision"], data["target_revision"], data["files"])

    @app.post("/api/worktrees/{worktree}/group")
    def group_nodes(worktree: str, data: dict):
        snapshot = projects.snapshot(worktree)
        if data["revision"] != snapshot["revision"]:
            raise Problem("Reload the graph before grouping", 409)
        bundle, selected = group(
            snapshot["bundle"], data["nodes"], data["name"], data.get("parameters"), data.get("parent")
        )
        result = projects.write(worktree, data["revision"], bundle_to_files(bundle))
        result["selected"] = selected
        return result

    @app.get("/api/library")
    def library():
        result = []
        for project in store.all("project"):
            snapshot = projects.snapshot(project["main"])
            if snapshot["bundle"]:
                for kind in ("templates", "components"):
                    for identity, value in snapshot["bundle"][kind].items():
                        try:
                            label = parse_template(value)["label"] if kind == "templates" else value["name"]
                            result.append(
                                {
                                    "project": project["id"],
                                    "project_name": project["name"],
                                    "kind": kind,
                                    "id": identity,
                                    "name": label,
                                    "worktree": project["main"],
                                    "commit": snapshot["commit"],
                                }
                            )
                        except Problem:
                            pass
        return result

    @app.post("/api/worktrees/{worktree}/import")
    def import_item(worktree: str, data: dict):
        snapshot = projects.snapshot(worktree)
        source = projects.snapshot(data["source_worktree"])
        bundle, key = import_definition(
            snapshot["bundle"],
            source["bundle"],
            data["kind"],
            data["id"],
            {"project": source["worktree"]["project"], "commit": source["commit"]},
        )
        result = projects.write(worktree, data["revision"], bundle_to_files(bundle))
        result["imported"] = key
        return result

    @app.get("/api/catalog")
    def get_catalog():
        return catalog.public()

    @app.get("/api/worktrees/{worktree}/generations/{identity}")
    def generation(worktree: str, identity: str, environment: str = "dev"):
        context = engine.context(worktree, environment)
        with context.lock:
            dataset = context.datasets.get(identity)
            return {"valid": bool(dataset and dataset.status == "valid")}

    @app.put("/api/catalog/{kind}")
    def save_catalog(kind: str, data: dict):
        if kind not in ("connector", "connection"):
            raise Problem("Unknown catalog entity")
        catalog.save(kind, copy.deepcopy(data))
        return catalog.public()

    @app.delete("/api/catalog/{kind}/{identity}")
    def delete_catalog(kind: str, identity: str):
        if kind not in ("connector", "connection"):
            raise Problem("Unknown catalog entity")
        store.delete(kind, identity)
        engine.invalidate()
        return catalog.public()

    @app.put("/api/environments")
    def environments(data: list[str]):
        if not data or any(not value.strip() for value in data):
            raise Problem("Provide at least one named environment")
        store.put("settings", "environments", list(dict.fromkeys(data)))
        return catalog.public()

    @app.post("/api/uploads")
    async def upload(file: Annotated[UploadFile, File()]):
        folder = store.home / "resources"
        folder.mkdir(exist_ok=True)
        name = Path(file.filename or "data.csv").name
        path = folder / (uid() + "_" + name)
        with path.open("wb") as stream:
            while chunk := await file.read(1024 * 1024):
                stream.write(chunk)
        return {"path": str(path), "name": name}

    @app.get("/api/worktrees/{worktree}/status")
    def status(worktree: str, environment: str = "dev"):
        return engine.statuses(worktree, environment)

    @app.post("/api/worktrees/{worktree}/runs")
    def launch(worktree: str, data: dict):
        return engine.launch(
            worktree,
            data.get("environment", "dev"),
            data.get("node"),
            "ui" if data.get("entry_point") == "ui" else "api",
        )

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
        return engine.preview(
            worktree, environment, node, port, limit, offset, sort, descending, filter_values
        )

    @app.post("/api/worktrees/{worktree}/lineage")
    def explain(worktree: str, data: dict):
        return lineage.explain(
            worktree,
            data.get("environment", "dev"),
            data["dataset"],
            data["row"],
            data["column"],
            data.get("offset", 0),
            data.get("group"),
            data.get("context", False),
        )

    @app.post("/api/worktrees/{worktree}/lineage/stage", response_model=Stage)
    def lineage_stage(worktree: str, data: StageRequest):
        return explorer.stage(worktree, data)

    @app.post("/api/worktrees/{worktree}/lineage/records", response_model=Records)
    def lineage_records(worktree: str, data: RecordsRequest):
        return explorer.records(worktree, data)

    @app.post("/api/worktrees/{worktree}/lineage/cancel")
    def cancel_lineage(worktree: str, data: CancelRequest):
        return explorer.cancel(worktree, data)

    static = Path(__file__).parent / "static"
    if (static / "assets").exists():
        app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

    @app.get("/{path:path}")
    def frontend(path: str):
        if (static / "index.html").exists():
            return FileResponse(static / "index.html")
        return JSONResponse(
            {"message": "Build the frontend: cd frontend && npm install && npm run build"}, status_code=503
        )

    return app
