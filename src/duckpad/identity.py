"""Server-owned Git attribution scoped to one authenticated request."""

import os
import re
from contextlib import contextmanager
from contextvars import ContextVar

SYSTEM_IDENTITY = {"name": "Duckpad external changes", "email": "external@duckpad.invalid"}
current_identity = ContextVar("git_identity", default=None)


def account_identity(user):
    return {"name": user["username"], "email": f"{user['id']}@users.duckpad.invalid"}


def oidc_identity(user, claims):
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
def commit_author(identity):
    """Context variables propagate to endpoint workers and isolate concurrent requests."""
    token = current_identity.set(identity)
    try:
        yield
    finally:
        current_identity.reset(token)


def git_environment(identity):
    # Explicit author AND committer override any identity inherited from the server.
    return {
        **os.environ,
        "GIT_AUTHOR_NAME": identity["name"],
        "GIT_AUTHOR_EMAIL": identity["email"],
        "GIT_COMMITTER_NAME": identity["name"],
        "GIT_COMMITTER_EMAIL": identity["email"],
    }
