"""Individual accounts and expiring sessions, outside project repositories."""

import hashlib
import hmac
import re
import secrets
import time

from .identity import account_identity
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
            record = store.get("auth", "admin")
            if not record:
                self.initial_password = secrets.token_urlsafe(18)
                record = self.credentials(self.initial_password)
            store.put(
                "user",
                "admin",
                {"id": "admin", "username": "admin", "role": "admin", "active": True, **record},
            )
        # Pre-account sessions have no owner and must not survive the migration.
        store.delete("auth", "admin")
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
        if user.get("oidc"):
            result["auth_method"] = "oidc"
        return result

    def create_user(self, username, password, role="member"):
        if not isinstance(username, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", username):
            raise Problem("Use a username of 1-64 letters, numbers, dots, hyphens or underscores")
        if role not in ("admin", "member"):
            raise Problem("Unknown instance role")
        credentials = self.credentials(password)
        with self.store.lock:
            if any(u["username"].casefold() == username.casefold() for u in self.store.all("user")):
                raise Problem("Username already exists", 409)
            user = {"id": uid("user_"), "username": username, "role": role, "active": True, **credentials}
            self.store.put("user", user["id"], user)
        return self.public(user)

    def login(self, username, password, peer="local"):
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
        user = next(
            (u for u in self.store.all("user") if u["username"].casefold() == username.casefold()), None
        )
        # Run the same password derivation for unknown and disabled accounts.
        record = user if user and not user.get("oidc") else {"salt": "00" * 32, "hash": "00" * 64}
        valid = hmac.compare_digest(self.hash_password(password[:1024], record["salt"]), record["hash"])
        if not user or user.get("oidc") or not user["active"] or not valid or len(password) > 1024:
            raise Problem("Invalid username or password", 401)
        token = secrets.token_urlsafe(32)
        with self.store.lock:
            current = self.store.get("user", user["id"])
            if not current["active"] or current["hash"] != user["hash"]:
                raise Problem("Invalid username or password", 401)
            self.attempts[peer] = [t for t in self.attempts.get(peer, []) if t != attempt]
            self._purge_expired(now)
            self.store.put(
                "session",
                session_key(token),
                {
                    "user": user["id"],
                    "credential": user["hash"],
                    "version": user.get("session_version", 0),
                    "expires": now + SESSION_LIFETIME,
                },
            )
        return token

    def _purge_expired(self, now):
        for key, session in self.store.items("session"):
            if session["expires"] < now:
                self.store.delete("session", key)

    def check(self, token):
        session = self.store.get("session", session_key(token))
        user = self.store.get("user", session.get("user", "")) if session else None
        if (
            not session
            or session["expires"] < time.time()
            or not user
            or not user["active"]
            or session.get("version", 0) != user.get("session_version", 0)
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

    def commit_identity(self, user):
        record = self.store.get("user", user["id"])
        return record.get("commit_identity") or account_identity(record)
