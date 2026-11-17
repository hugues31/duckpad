"""OAuth discovery, app registration, consent and token routes for agent API apps."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .. import oauth, schemas
from ..oauth import OAuthError
from ..types import Record
from ..uploads import limited_body
from .context import Context
from .security import instance_admin, no_api_token, signed_in

NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}
NO_TOKEN = no_api_token("API tokens and apps cannot authorize or manage apps; sign in interactively")
FORM = "application/x-www-form-urlencoded"


def oauth_response(body: Record, status: int = 200, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={**NO_STORE, **(headers or {})})


def oauth_failure(error: OAuthError, request: Request) -> JSONResponse:
    headers = {}
    if error.status == 401 and request.headers.get("authorization", "").lower().startswith("basic "):
        headers["WWW-Authenticate"] = 'Basic realm="Duckpad"'
    return oauth_response(error.body(), error.status, headers)


async def form_values(request: Request) -> dict[str, str]:
    await limited_body(16 * 1024, "token request")(request)
    if request.headers.get("content-type", "").partition(";")[0].strip().lower() != FORM:
        raise OAuthError("invalid_request", f"Send the parameters as {FORM}")
    async with request.form() as form:
        return oauth.single((key, value) for key, value in form.multi_items() if isinstance(value, str))


def router(ctx: Context) -> APIRouter:
    api = APIRouter()
    service = ctx.oauth

    def metadata(request: Request, document) -> JSONResponse:
        base = oauth.origin(request)
        if base is None:
            return oauth_response({"error": "not_found", "error_description": oauth.HTTPS_REQUIRED}, 404)
        return oauth_response(document(base))

    # Discovery: RFC 9728 at the root and inserted before the MCP endpoint's path, then RFC 8414.
    for path in (oauth.RESOURCE_METADATA, oauth.RESOURCE_METADATA + oauth.MCP_PATH):

        @api.get(path, response_model=None, include_in_schema=False)
        def protected_resource(request: Request) -> JSONResponse:
            return metadata(request, oauth.resource_metadata)

    @api.get(oauth.SERVER_METADATA, response_model=None, include_in_schema=False)
    def authorization_server(request: Request) -> JSONResponse:
        return metadata(request, oauth.server_metadata)

    @api.post(oauth.REGISTER_PATH, response_model=None)
    async def register(request: Request) -> JSONResponse:
        await limited_body(64 * 1024, "registration")(request)
        try:
            if oauth.origin(request) is None:
                raise OAuthError("invalid_request", oauth.HTTPS_REQUIRED)
            try:
                data = json.loads(await request.body())
            except ValueError:
                raise OAuthError("invalid_client_metadata", "Send the client metadata as JSON") from None
            peer = request.client.host if request.client else "local"
            return oauth_response(await run_in_threadpool(service.register, data, peer), 201)
        except OAuthError as error:
            return oauth_failure(error, request)

    @api.post(oauth.TOKEN_PATH, response_model=None)
    async def token(request: Request) -> JSONResponse:
        try:
            values = await form_values(request)
            authorization = request.headers.get("authorization", "")
            base = oauth.origin(request)
            return oauth_response(await run_in_threadpool(service.token, values, authorization, base))
        except OAuthError as error:
            return oauth_failure(error, request)

    @api.post(oauth.REVOKE_PATH, response_model=None)
    async def revoke(request: Request) -> JSONResponse:
        try:
            values = await form_values(request)
            await run_in_threadpool(service.revoke, values, request.headers.get("authorization", ""))
            return oauth_response({})
        except OAuthError as error:
            return oauth_failure(error, request)

    # Consent, from the signed-in authorization page of the interface.

    @api.get("/api/oauth/authorization", response_model=None, dependencies=[Depends(NO_TOKEN)])
    def authorization(request: Request) -> Record:
        checked = service.request(request.url.query, oauth.origin(request), signed_in(request))
        return service.consent(checked)

    @api.post("/api/oauth/authorization", response_model=None, dependencies=[Depends(NO_TOKEN)])
    def decide(data: schemas.OAuthDecision, request: Request) -> Record:
        return service.decide(data.query, oauth.origin(request), signed_in(request), data.approve)

    # Authorized apps of an account, like its API tokens.

    @api.get("/api/oauth/apps", response_model=None, dependencies=[Depends(NO_TOKEN)])
    def apps(request: Request) -> list[Record]:
        return service.grants(signed_in(request), signed_in(request)["id"])

    @api.delete("/api/oauth/apps/{grant}", response_model=None, dependencies=[Depends(NO_TOKEN)])
    def revoke_app(grant: str, request: Request) -> Record:
        service.revoke_grant(signed_in(request), signed_in(request)["id"], grant)
        return {"ok": True}

    @api.get(
        "/api/users/{identity}/oauth/apps",
        response_model=None,
        dependencies=[Depends(NO_TOKEN), Depends(instance_admin)],
    )
    def user_apps(identity: str, request: Request) -> list[Record]:
        return service.grants(signed_in(request), identity)

    @api.delete(
        "/api/users/{identity}/oauth/apps/{grant}",
        response_model=None,
        dependencies=[Depends(NO_TOKEN), Depends(instance_admin)],
    )
    def revoke_user_app(identity: str, grant: str, request: Request) -> Record:
        service.revoke_grant(signed_in(request), identity, grant)
        return {"ok": True}

    return api
