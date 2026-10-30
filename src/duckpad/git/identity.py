"""Server-owned Git attribution scoped to one authenticated request."""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from ..types import Record

SYSTEM_IDENTITY = {"name": "Duckpad external changes", "email": "external@duckpad.invalid"}
current_identity: ContextVar[dict[str, str] | None] = ContextVar("git_identity", default=None)


def account_identity(user: Record) -> dict[str, str]:
    return {"name": user["username"], "email": f"{user['id']}@users.duckpad.invalid"}


def oidc_identity(user: Record, claims: Record) -> dict[str, str]:
    """Use validated ID-token claims without allowing Git identity delimiters."""
    identity = account_identity(user)
    for key in ("name", "preferred_username"):
        value = claims.get(key)
        if isinstance(value, str):
            name = " ".join(re.sub(r"[<>\x00-\x1f\x7f]", " ", value).split())[:200]
            if name:
                identity["name"] = name
                break
    email = claims.get("email")
    if (
        claims.get("email_verified") is True
        and isinstance(email, str)
        and len(email) <= 254
        and re.fullmatch(r"[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+", email)
    ):
        identity["email"] = email
    return identity


@contextmanager
def commit_author(identity: dict[str, str] | None) -> Iterator[None]:
    """Context variables propagate to endpoint workers and isolate concurrent requests."""
    token = current_identity.set(identity)
    try:
        yield
    finally:
        current_identity.reset(token)
