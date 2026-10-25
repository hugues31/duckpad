"""Durable instance metadata, deliberately separate from project repositories."""

import json
import sqlite3
import threading
from pathlib import Path

from .util import dumps


class Store:
    def __init__(self, home: Path):
        self.home = home.resolve()
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.home / "instance.sqlite", check_same_thread=False)
        (self.home / "instance.sqlite").chmod(0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, value TEXT, PRIMARY KEY(kind,id))"
        )
        self.db.commit()

    def get(self, kind, key, default=None):
        with self.lock:
            row = self.db.execute("SELECT value FROM records WHERE kind=? AND id=?", (kind, key)).fetchone()
            return json.loads(row[0]) if row else default

    def all(self, kind):
        with self.lock:
            return [
                json.loads(r[0])
                for r in self.db.execute(
                    "SELECT value FROM records WHERE kind=? ORDER BY rowid", (kind,)
                ).fetchall()
            ]

    def put(self, kind, key, value):
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?)", (kind, key, dumps(value)))
        return value

    def delete(self, kind, key):
        with self.lock, self.db:
            self.db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, key))

    def close(self):
        self.db.close()
