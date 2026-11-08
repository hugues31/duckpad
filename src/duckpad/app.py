"""Application wiring, lifecycle and static interface."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, automation
from .api import account, admin, git, http, jobs, projects, results, session, worktrees
from .api.context import Context
from .api.security import authorize_unknown_route
from .assistant.api import router as assistant_router
from .assistant.service import Assistant
from .auth import Auth
from .jobs import Jobs
from .monitoring import Monitoring
from .oidc import OIDC
from .services import Services
from .util import Problem

STATIC = Path(__file__).parent / "static"


def create_app(home: Path, watch: bool = True, *, trusted_local: bool = False) -> FastAPI:
    services = Services.open(home, isolated=not trusted_local)
    auth = Auth(services.store)
    ctx = Context(
        services=services,
        auth=auth,
        oidc=OIDC(services.store, auth),
        jobs=Jobs(services),
        monitoring=Monitoring(services.store.paths.home),
        assistant=Assistant(services, auth),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        with ctx.monitoring.logs.capture():
            try:
                if watch:
                    services.projects.start_watcher()
                yield
            finally:
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
    app.state.oidc = ctx.oidc
    app.state.access = ctx.access
    app.state.assistant = ctx.assistant
    app.state.jobs = ctx.jobs
    http.install(app, auth)
    app.include_router(assistant_router(ctx.assistant))
    app.include_router(automation.router(ctx.jobs, ctx.access))
    for module in (session, account, admin, projects, worktrees, git, jobs, results):
        # Keep the internal route inventory flat for access audits and application tooling.
        app.router.routes.extend(module.router(ctx).routes)

    # Interface

    if (STATIC / "site" / "index.html").exists():
        app.mount("/site", StaticFiles(directory=STATIC / "site", html=True), name="website")

    if (STATIC / "assets").exists():
        app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")

    @app.get("/{path:path}", response_model=None)
    def frontend(path: str, request: Request) -> Response:
        if path == "api" or path.startswith("api/"):
            authorize_unknown_route(request)
            raise Problem("Not found", 404)
        if (STATIC / "index.html").exists():
            return FileResponse(STATIC / "index.html")
        return JSONResponse(
            {"message": "Build the frontend: cd frontend && npm install && npm run build"}, status_code=503
        )

    return app
