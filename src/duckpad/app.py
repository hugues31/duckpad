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

from .access import Access
from .auth import Auth
from .catalog import Catalog
from .components import group, import_definition
from .engine import Engine
from .example import create_example
from .lineage import Lineage
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
    access = Access(store)
    engine = Engine(store, projects, catalog, access=access)
    lineage = Lineage(engine)
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
    app.state.access = access

    def authorize(request, user):
        parts = request.url.path.strip("/").split("/")
        route = parts[1] if len(parts) > 1 else ""
        if route in ("users", "identity", "environments", "catalog"):
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
            raise Problem("Endpoint not found", 404)

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
                request.state.user = auth.check(token)
                authorize(request, request.state.user)
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
        response = JSONResponse(auth.check(token))
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
        auth.logout(
            request.cookies.get("duckpad_session")
            or request.headers.get("authorization", "").removeprefix("Bearer ")
        )
        response = JSONResponse({"ok": True})
        response.delete_cookie("duckpad_session")
        return response

    @app.get("/api/session")
    def session(request: Request):
        return {**request.state.user, "version": "0.1.0"}

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
    def identity(data: dict):
        if not data.get("name") or not data.get("email"):
            raise Problem("Name and email are required")
        return store.put("settings", "identity", {"name": data["name"], "email": data["email"]})

    @app.post("/api/projects")
    def create_project(data: dict, request: Request):
        return access.own(projects.create(str(data.get("name", "Untitled project"))), request.state.user)

    @app.post("/api/example")
    def example(request: Request):
        worktree = create_example(projects, catalog, private=True)
        return access.own(worktree, request.state.user, ["local", "sample_" + worktree["project"]])

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
            auth.hash(str(data.get("current", ""))[:1024], user["salt"]), user["hash"]
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
    def library(request: Request):
        result = []
        for project in store.all("project"):
            if not access.role(request.state.user, project["id"]):
                continue
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
    def import_item(worktree: str, data: dict, request: Request):
        access.worktree(request.state.user, data["source_worktree"])
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
        with projects.lock, engine.lock:
            engine.reset_catalog()
            catalog.save(kind, copy.deepcopy(data))
        return catalog.public()

    @app.delete("/api/catalog/{kind}/{identity}")
    def delete_catalog(kind: str, identity: str):
        if kind not in ("connector", "connection"):
            raise Problem("Unknown catalog entity")
        with projects.lock, engine.lock:
            engine.reset_catalog()
            store.delete(kind, identity)
            engine.invalidate()
        return catalog.public()

    @app.put("/api/environments")
    def environments(data: list[str]):
        if not data or any(not value.strip() for value in data):
            raise Problem("Provide at least one named environment")
        with projects.lock, engine.lock:
            engine.reset_catalog()
            store.put("settings", "environments", list(dict.fromkeys(data)))
        return catalog.public()

    @app.post("/api/worktrees/{worktree}/uploads")
    async def upload(worktree: str, file: Annotated[UploadFile, File()]):
        folder = store.home / "resources" / projects.get(worktree)["project"]
        folder.mkdir(parents=True, exist_ok=True)
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
