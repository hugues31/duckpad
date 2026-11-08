"""Request admission and explicit resource authorization dependencies."""

import re
from collections.abc import Callable
from urllib.parse import urlparse

from fastapi import Request

from ..auth import Auth
from ..oidc import CALLBACK_PATH
from ..types import Record
from ..util import Problem
from .http import session_token

PUBLIC_API_PATHS = {"/api/login", "/api/oidc/provider", "/api/oidc/login", CALLBACK_PATH}
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
WORKTREE_RESOURCE = re.compile(r"/api/worktrees/(?P<worktree>[^/]+)(?:/.*)?")


def protected(request: Request) -> bool:
    return request.url.path.startswith("/api/") and request.url.path not in PUBLIC_API_PATHS


def admit(request: Request, auth: Auth) -> dict[str, str] | None:
    """Authenticate in the threadpool; leave resource checks to route dependencies."""
    user = None
    if protected(request):
        scheme, _, bearer = request.headers.get("authorization", "").partition(" ")
        request.state.token_name = None
        if scheme.lower() == "bearer" and bearer.startswith("dpk_"):
            user, request.state.token_name = auth.check_api_token(bearer)
        else:
            user = auth.check(session_token(request))
        request.state.user = user
    if request.method not in SAFE_METHODS:
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.headers.get("host"):
            raise Problem("Cross-origin writes are not allowed", 403)
    return auth.commit_identity(user) if user else None


def signed_in(request: Request) -> Record:
    return request.state.user


def instance_admin(request: Request) -> None:
    request.app.state.access.instance_admin(signed_in(request))


def project_role(role: str) -> Callable:
    def authorize(project: str, request: Request) -> None:
        request.app.state.access.require(signed_in(request), project, role)

    return authorize


def worktree_role(role: str) -> Callable:
    def authorize(worktree: str, request: Request) -> None:
        request.app.state.access.worktree(signed_in(request), worktree, role)

    return authorize


def job_role(role: str) -> Callable:
    def authorize(slug: str, request: Request) -> None:
        job = request.app.state.jobs.get(slug)
        request.app.state.access.require(signed_in(request), job["project"], role)

    return authorize


def run_role(role: str) -> Callable:
    def authorize(run: str, request: Request) -> None:
        record = request.app.state.services.store.get("run", run)
        if not record:
            raise Problem("Resource not found", 404)
        access = request.app.state.access
        if record.get("trigger") == "job":
            access.require(signed_in(request), record["project"], role)
        else:
            access.worktree(
                signed_in(request), record["worktree"], "reader" if role == "reader" else "editor"
            )

    return authorize


def conflict_role(conflict: str, request: Request) -> None:
    record = request.app.state.services.store.get("conflict", conflict)
    if not record:
        raise Problem("Resource not found", 404)
    request.app.state.access.worktree(signed_in(request), record["worktree"], "editor")


def no_api_token(message: str) -> Callable:
    def authorize(request: Request) -> None:
        if request.state.token_name is not None:
            raise Problem(message, 403)

    return authorize


def authorize_unknown_route(request: Request) -> None:
    """Preserve worktree visibility and write restrictions for missing routes or methods.

    Registered endpoints declare their own permissions. The SPA fallback and framework
    405 handler still hide unavailable worktrees before reporting an unsupported URL.
    """
    if match := WORKTREE_RESOURCE.fullmatch(request.url.path):
        request.app.state.access.worktree(
            signed_in(request), match["worktree"], "reader" if request.method == "GET" else "editor"
        )
