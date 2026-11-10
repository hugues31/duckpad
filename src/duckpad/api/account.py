"""Account HTTP routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from .. import schemas
from ..types import Record
from .context import Context
from .security import (
    no_api_token,
    signed_in,
)


def router(ctx: Context) -> APIRouter:
    api = APIRouter()
    auth = ctx.auth
    access = ctx.access
    credentials = ctx.services.projects.remotes.credentials

    @api.get(
        "/api/api-tokens",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot create or manage API tokens; sign in interactively")),
            Depends(signed_in),
        ],
    )
    def api_tokens(request: Request) -> list[Record]:
        return auth.list_api_tokens(request.state.user, request.state.user["id"])

    @api.post(
        "/api/api-tokens",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot create or manage API tokens; sign in interactively")),
            Depends(signed_in),
        ],
    )
    def create_api_token(data: schemas.NewAPIToken, request: Request) -> Record:
        return auth.create_api_token(
            request.state.user,
            request.state.user["id"],
            data.name,
            data.expires.timestamp() if data.expires else None,
        )

    @api.delete(
        "/api/api-tokens/{token}",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot create or manage API tokens; sign in interactively")),
            Depends(signed_in),
        ],
    )
    def revoke_api_token(token: str, request: Request) -> Record:
        auth.revoke_api_token(request.state.user, request.state.user["id"], token)
        return {"ok": True}

    @api.post("/api/password", response_model=None, dependencies=[Depends(signed_in)])
    def change_password(data: schemas.PasswordChange, request: Request) -> Record:
        auth.confirm_password(request.state.user["id"], data.current)
        access.update_user(request.state.user["id"], {"password": data.password})
        return {"ok": True}

    @api.get(
        "/api/ssh-key",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot authorize Git credentials or network Git")),
            Depends(signed_in),
        ],
    )
    def ssh_key(request: Request) -> Record | None:
        return credentials.public_key(request.state.user["id"])

    @api.post(
        "/api/ssh-key",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot authorize Git credentials or network Git")),
            Depends(signed_in),
        ],
    )
    def generate_ssh_key(request: Request) -> Record:
        return credentials.generate_key(request.state.user)

    @api.delete(
        "/api/ssh-key",
        response_model=None,
        dependencies=[
            Depends(no_api_token("API tokens cannot authorize Git credentials or network Git")),
            Depends(signed_in),
        ],
    )
    def delete_ssh_key(request: Request) -> Record:
        credentials.delete_key(request.state.user["id"])
        return {"ok": True}

    return api
