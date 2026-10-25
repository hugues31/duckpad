"""Persistent salted credentials and expiring, server-side sessions."""

import hashlib
import hmac
import secrets
import time

from .util import Problem


class Auth:
    def __init__(self, store):
        self.store = store
        self.initial_password = None
        if not store.get("auth", "admin"):
            self.initial_password = secrets.token_urlsafe(18)
            salt = secrets.token_hex(32)
            store.put("auth", "admin", {"salt": salt, "hash": self.hash(self.initial_password, salt)})
        self.attempts = {}

    @staticmethod
    def hash(password, salt):
        return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()

    def login(self, username, password, peer="local"):
        recent = [t for t in self.attempts.get(peer, []) if t > time.time() - 60]
        self.attempts[peer] = recent
        if len(recent) >= 12:
            raise Problem("Too many login attempts. Try again in a minute.", 429)
        record = self.store.get("auth", "admin")
        valid = hmac.compare_digest(self.hash(password, record["salt"]), record["hash"])
        if username != "admin" or not valid:
            recent.append(time.time())
            raise Problem("Invalid username or password", 401)
        token = secrets.token_urlsafe(32)
        self.store.put(
            "session", hashlib.sha256(token.encode()).hexdigest(), {"expires": time.time() + 86400 * 7}
        )
        return token

    def check(self, token):
        session = self.store.get("session", hashlib.sha256((token or "").encode()).hexdigest())
        if not session or session["expires"] < time.time():
            raise Problem("Authentication required", 401)

    def logout(self, token):
        self.store.delete("session", hashlib.sha256((token or "").encode()).hexdigest())
