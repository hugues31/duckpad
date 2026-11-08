"""Session HTTP routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, RedirectResponse

from .. import __version__, schemas
from ..oidc import CALLBACK_PATH, TRANSACTION_LIFETIME, OIDCSettings
from ..types import Record
from ..util import Problem
from .context import Context
from .http import (
    OIDC_COOKIE,
    SESSION_COOKIE,
    secure_cookies,
    session_token,
    set_session_cookie,
)
from .security import (
    instance_admin,
    signed_in,
)


def router(ctx: Context) -> APIRouter:
    api = APIRouter()
    auth = ctx.auth
    oidc = ctx.oidc

    @api.post("/api/login", response_model=None)
    def login(data: schemas.Login, request: Request) -> JSONResponse:
        token = auth.login(data.username, data.password, request.client.host if request.client else "local")
        response = JSONResponse(auth.check(token))
        auth.logout(session_token(request))
        set_session_cookie(response, request, token)
        return response

    @api.get("/api/sso", response_model=None, dependencies=[Depends(instance_admin)])
    def sso_settings() -> Record:
        return oidc.public_settings()

    @api.put("/api/sso", response_model=None, dependencies=[Depends(instance_admin)])
    def save_sso_settings(data: OIDCSettings) -> Record:
        return oidc.save(data)

    @api.get("/api/oidc/provider", response_model=None)
    def sso_provider() -> dict[str, str] | None:
        config = oidc.settings()
        return {"label": config["label"]} if config["enabled"] else None

    @api.get("/api/oidc/login", response_model=None)
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

    @api.get(CALLBACK_PATH, response_model=None)
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

    @api.post("/api/logout", response_model=None, dependencies=[Depends(signed_in)])
    def logout(request: Request) -> JSONResponse:
        auth.logout(session_token(request))
        response = JSONResponse({"ok": True})
        response.delete_cookie(SESSION_COOKIE)
        return response

    @api.get("/api/session", response_model=None, dependencies=[Depends(signed_in)])
    def session(request: Request) -> Record:
        return {**request.state.user, "version": __version__}

    return api
