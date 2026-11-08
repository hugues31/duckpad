"""HTTP errors, cookies, upload names and security response headers."""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Mapping
from pathlib import PureWindowsPath

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException
from starlette.middleware.base import RequestResponseEndpoint

from .. import automation
from ..auth import SESSION_LIFETIME, Auth
from ..git.identity import commit_author
from ..uploads import limited_body as limited_body
from ..util import Problem, clean

SESSION_COOKIE = "duckpad_session"
OIDC_COOKIE = "duckpad_oidc"
UPLOAD_CHUNK = 1024 * 1024
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
# File systems commonly limit names to 255 bytes, including the unique prefix.
MAX_UPLOAD_NAME_BYTES = 200
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


def request_problem(
    request: Request, error: Problem, headers: Mapping[str, str] | None = None
) -> JSONResponse:
    if request.url.path.startswith("/api/v1/"):
        error = automation.problem(error)
    return problem_response(error, headers)


def same_origin_download(request: Request) -> None:
    """Allow the inspector's download frame to display attachments and JSON errors."""
    request.state.frame_options = "SAMEORIGIN"


def install(app: FastAPI, auth: Auth) -> None:
    from .security import admit, authorize_unknown_route, protected

    @app.exception_handler(Problem)
    async def problem_handler(request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, Problem)
        return request_problem(request, error)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, RequestValidationError)
        errors = [{"location": ".".join(map(str, e["loc"])), "message": e["msg"]} for e in error.errors()]
        summary = "; ".join(f"{e['location']}: {e['message']}" for e in errors)
        return request_problem(request, Problem(f"Invalid request: {summary}", 422, errors))

    @app.exception_handler(HTTPException)
    async def http_problem(request: Request, error: Exception) -> JSONResponse:
        # Framework errors, such as unsupported methods or malformed forms, use the same format.
        assert isinstance(error, HTTPException)
        if error.status_code == 405:
            try:
                await run_in_threadpool(authorize_unknown_route, request)
            except Problem as denied:
                return request_problem(request, denied)
        return request_problem(request, Problem(str(error.detail), error.status_code), error.headers)

    @app.middleware("http")
    async def authentication(request: Request, call_next: RequestResponseEndpoint) -> Response:
        try:
            identity = (
                await run_in_threadpool(admit, request, auth) if protected(request) else admit(request, auth)
            )
            with commit_author(identity):
                response = await call_next(request)
        except Problem as error:
            response = request_problem(request, error)
        except Exception:
            # The traceback stays in the server log; clients never see internal details.
            logger.exception("Unexpected error in %s %s", request.method, request.url.path)
            response = problem_response(Problem("Internal server error", 500))
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = (
            "no-referrer" if request.url.path.startswith("/api/oidc/") else "same-origin"
        )
        response.headers.setdefault("X-Frame-Options", getattr(request.state, "frame_options", "DENY"))
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response
