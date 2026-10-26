"""Persistent salted credentials and expiring, server-side sessions."""

import hashlib
import hmac
import secrets
import threading
import time

from .util import Problem

USERNAME = "admin"
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
        if not store.get("auth", USERNAME):
            self.initial_password = secrets.token_urlsafe(18)
            self.set_password(self.initial_password)
        self.attempts = {}
        self.lock = threading.Lock()

    @staticmethod
    def hash_password(password, salt):
        return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()

    def set_password(self, password):
        salt = secrets.token_hex(32)
        self.store.put("auth", USERNAME, {"salt": salt, "hash": self.hash_password(password, salt)})

    def login(self, username, password, peer="local"):
        now = time.time()
        with self.lock:
            # Forget peers whose failures have all left the rate-limit window.
            self.attempts = {
                address: recent
                for address, times in self.attempts.items()
                if (recent := [t for t in times if t > now - LOGIN_WINDOW])
            }
            if len(self.attempts.get(peer, [])) >= LOGIN_ATTEMPTS:
                raise Problem("Too many login attempts. Try again in a minute.", 429)
        record = self.store.get("auth", USERNAME)
        valid = hmac.compare_digest(self.hash_password(password, record["salt"]), record["hash"])
        if username != USERNAME or not valid:
            with self.lock:
                self.attempts.setdefault(peer, []).append(now)
            raise Problem("Invalid username or password", 401)
        self._purge_expired(now)
        token = secrets.token_urlsafe(32)
        self.store.put("session", session_key(token), {"expires": now + SESSION_LIFETIME})
        return token

    def _purge_expired(self, now):
        for session in self.store.items("session"):
            if session[1]["expires"] < now:
                self.store.delete("session", session[0])

    def check(self, token):
        session = self.store.get("session", session_key(token))
        if not session or session["expires"] < time.time():
            raise Problem("Authentication required", 401)

    def logout(self, token):
        self.store.delete("session", session_key(token))
