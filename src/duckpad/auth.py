"""Accounts, expiring sessions and hashed API tokens, outside project repositories."""

import hashlib
import hmac
import math
import re
import secrets
import time

from .git.identity import account_identity
from .util import Problem, uid

SESSION_LIFETIME = 7 * 24 * 3600
LOGIN_ATTEMPTS = 12
LOGIN_WINDOW = 60


def session_key(token):
    """Sessions are stored by token hash, so the database never holds a usable token."""
    return hashlib.sha256((token or "").encode()).hexdigest()


class Auth:
    def __init__(self, store):
        self.store = store
        self.initial_password = None
        if not store.all("user"):
            self.initial_password = secrets.token_urlsafe(18)
            store.put(
                "user",
                "admin",
                {
                    "id": "admin",
                    "username": "admin",
                    "role": "admin",
                    "active": True,
                    **self.credentials(self.initial_password),
                },
            )
        self.attempts = {}

    @staticmethod
    def hash_password(password, salt):
        return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()

    @classmethod
    def credentials(cls, password):
        if not isinstance(password, str) or not 12 <= len(password) <= 1024:
            raise Problem("Use a password between 12 and 1024 characters")
        salt = secrets.token_hex(32)
        return {"salt": salt, "hash": cls.hash_password(password, salt)}

    @staticmethod
    def public(user):
        result = {key: user[key] for key in ("id", "username", "role", "active")}
        if user.get("service"):
            result.update(auth_method="service", description=user["description"])
        elif user.get("oidc"):
            result["auth_method"] = "oidc"
        return result

    def create_user(self, username, password=None, role="member", *, service=False, description=""):
        if not isinstance(username, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", username):
            raise Problem("Use a username of 1-64 letters, numbers, dots, hyphens or underscores")
        if role not in ("admin", "member"):
            raise Problem("Unknown instance role")
        if service and (role != "member" or password is not None):
            raise Problem("Service accounts must be Members without a password")
        if not isinstance(description, str) or len(description) > 1000:
            raise Problem("Use a description of at most 1000 characters")
        credentials = {} if service else self.credentials(password)
        with self.store.transaction():
            if self.store.find_user(username):
                raise Problem("Username already exists", 409)
            user = {
                "id": uid("user_"),
                "username": username,
                "role": role,
                "active": True,
                "service": service,
                "description": description.strip(),
                **credentials,
            }
            self.store.put("user", user["id"], user)
        return self.public(user)

    def login(self, username, password, peer="local"):
        # Peers are client addresses; behind a reverse proxy, Uvicorn only reports them
        # when FORWARDED_ALLOW_IPS trusts that proxy (see docs/INSTALLATION.md).
        now = time.time()
        with self.store.lock:
            self.attempts = {
                address: recent
                for address, times in self.attempts.items()
                if (recent := [t for t in times if t > now - LOGIN_WINDOW])
            }
            recent = self.attempts.setdefault(peer, [])
            if len(recent) >= LOGIN_ATTEMPTS:
                raise Problem("Too many login attempts. Try again in a minute.", 429)
            attempt = time.time()
            recent.append(attempt)
        user = self.store.find_user(username)
        valid = self.password_matches(user, password)
        if not user or user.get("oidc") or user.get("service") or not user["active"] or not valid:
            raise Problem("Invalid username or password", 401)
        with self.store.transaction():
            current = self.store.get("user", user["id"])
            if not current["active"] or current["hash"] != user["hash"]:
                raise Problem("Invalid username or password", 401)
            self.attempts[peer] = [t for t in self.attempts.get(peer, []) if t != attempt]
            return self.start_session(user, credential=user["hash"])

    def password_matches(self, user, password):
        """Check a local password; accounts without passwords run the same derivation."""
        record = (
            user
            if user and not user.get("oidc") and not user.get("service")
            else {"salt": "00" * 32, "hash": "00" * 64}
        )
        valid = hmac.compare_digest(self.hash_password(password[:1024], record["salt"]), record["hash"])
        return valid and len(password) <= 1024

    def confirm_password(self, identity, password):
        """Require an account's current password before it changes its own credentials."""
        user = self.store.get("user", identity)
        if user.get("service"):
            raise Problem("Service accounts cannot use passwords")
        if user.get("oidc"):
            raise Problem("SSO accounts authenticate with their identity provider")
        if not self.password_matches(user, password):
            raise Problem("Current password is incorrect", 403)

    def start_session(self, user, **binding):
        """Store a session for a verified account and return its token.

        The binding records what the session depends on: the password hash for local
        accounts, or the SSO configuration revision for identity provider accounts.
        """
        if user.get("service") or user.get("auth_method") == "service":
            raise Problem("Service accounts cannot sign in interactively", 403)
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self.store.transaction():
            self.store.purge_expired("session", now)
            self.store.put(
                "session",
                session_key(token),
                {
                    "user": user["id"],
                    "version": user.get("session_version", 0),
                    "expires": now + SESSION_LIFETIME,
                    **binding,
                },
            )
        return token

    def check(self, token):
        session = self.store.get("session", session_key(token))
        user = self.store.get("user", session["user"]) if session else None
        if (
            not session
            or session["expires"] < time.time()
            or not user
            or not user["active"]
            or user.get("service")
            or session["version"] != user.get("session_version", 0)
        ):
            raise Problem("Authentication required", 401)
        if user.get("oidc"):
            config = self.store.get("settings", "oidc", {})
            if not config.get("enabled") or session.get("oidc_revision") != config.get("revision"):
                raise Problem("Authentication required", 401)
        elif session.get("credential") != user["hash"]:
            raise Problem("Authentication required", 401)
        return self.public(user)

    def logout(self, token):
        self.store.delete("session", session_key(token))

    @staticmethod
    def public_token(token):
        return {key: token[key] for key in ("id", "name", "created", "expires", "last_used")}

    def token_account(self, actor, identity, *, create=False):
        user = self.store.get("user", identity)
        if not user:
            raise Problem("User not found", 404)
        if user.get("service"):
            allowed = actor["role"] == "admin"
        else:
            allowed = actor["id"] == identity or (not create and actor["role"] == "admin")
        if not allowed:
            raise Problem("You cannot manage this account's API tokens", 403)
        return user

    def list_api_tokens(self, actor, identity):
        self.token_account(actor, identity)
        return [self.public_token(token) for token in self.store.api_tokens(identity)]

    def create_api_token(self, actor, identity, name, expires=None):
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 128:
            raise Problem("Use a token name of 1-128 characters")
        now = time.time()
        if expires is not None and (not math.isfinite(expires) or expires <= now):
            raise Problem("Token expiration must be in the future")
        with self.store.transaction():
            user = self.token_account(actor, identity, create=True)
            if not user["active"]:
                raise Problem("Activate the account before creating API tokens", 409)
            secret = "dpk_" + secrets.token_urlsafe(32)
            token = {
                "id": uid("token_"),
                "user": identity,
                "hash": session_key(secret),
                "name": name.strip(),
                "created": now,
                "expires": expires,
                "last_used": None,
            }
            self.store.put("api_token", token["id"], token)
        return {**self.public_token(token), "token": secret}

    def revoke_api_token(self, actor, identity, token_id):
        with self.store.transaction():
            self.token_account(actor, identity)
            token = self.store.get("api_token", token_id)
            if not token or token["user"] != identity:
                raise Problem("API token not found", 404)
            self.store.delete("api_token", token_id)

    def check_api_token(self, secret):
        with self.store.transaction():
            token = self.store.find_api_token(session_key(secret)) if secret.startswith("dpk_") else None
            user = self.store.get("user", token["user"]) if token else None
            now = time.time()
            if (
                not token
                or not user
                or not user["active"]
                or (token["expires"] is not None and token["expires"] <= now)
                or (user.get("oidc") and not self.store.get("settings", "oidc", {}).get("enabled"))
            ):
                raise Problem("Authentication required", 401)
            if token["last_used"] is None or token["last_used"] <= now - 60:
                token["last_used"] = now
                self.store.put("api_token", token["id"], token)
            return self.public(user), token["name"]

    def commit_identity(self, user):
        record = self.store.get("user", user["id"])
        return record.get("commit_identity") or account_identity(record)
