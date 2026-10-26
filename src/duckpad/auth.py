"""Individual accounts and expiring sessions, outside project repositories."""

import hashlib
import hmac
import re
import secrets
import time

from .util import Problem, uid


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
    def hash(password, salt):
        return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()

    @classmethod
    def credentials(cls, password):
        if not isinstance(password, str) or not 12 <= len(password) <= 1024:
            raise Problem("Use a password between 12 and 1024 characters")
        salt = secrets.token_hex(32)
        return {"salt": salt, "hash": cls.hash(password, salt)}

    @staticmethod
    def public(user):
        return {key: user[key] for key in ("id", "username", "role", "active")}

    def create_user(self, username, password, role="member"):
        if not isinstance(username, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", username):
            raise Problem("Use a username of 1–64 letters, numbers, dots, hyphens or underscores")
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
        with self.store.lock:
            recent = [t for t in self.attempts.get(peer, []) if t > time.time() - 60]
            self.attempts[peer] = recent
            if len(recent) >= 12:
                raise Problem("Too many login attempts. Try again in a minute.", 429)
            attempt = time.time()
            recent.append(attempt)
        user = next(
            (u for u in self.store.all("user") if u["username"].casefold() == username.casefold()), None
        )
        # Run the same password derivation for unknown and disabled accounts.
        record = user or {"salt": "00" * 32, "hash": "00" * 64}
        valid = hmac.compare_digest(self.hash(password[:1024], record["salt"]), record["hash"])
        if not user or not user["active"] or not valid or len(password) > 1024:
            raise Problem("Invalid username or password", 401)
        token = secrets.token_urlsafe(32)
        with self.store.lock:
            current = self.store.get("user", user["id"])
            if not current["active"] or current["hash"] != user["hash"]:
                raise Problem("Invalid username or password", 401)
            self.attempts[peer] = [t for t in self.attempts.get(peer, []) if t != attempt]
            self.store.put(
                "session",
                self.token_key(token),
                {
                    "user": user["id"],
                    "credential": user["hash"],
                    "version": user.get("session_version", 0),
                    "expires": time.time() + 86400 * 7,
                },
            )
        return token

    @staticmethod
    def token_key(token):
        return hashlib.sha256((token or "").encode()).hexdigest()

    def check(self, token):
        session = self.store.get("session", self.token_key(token))
        user = self.store.get("user", session.get("user", "")) if session else None
        if (
            not session
            or session["expires"] < time.time()
            or not user
            or not user["active"]
            or session.get("credential") != user["hash"]
            or session.get("version", 0) != user.get("session_version", 0)
        ):
            raise Problem("Authentication required", 401)
        return self.public(user)

    def logout(self, token):
        self.store.delete("session", self.token_key(token))
