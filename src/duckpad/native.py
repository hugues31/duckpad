"""Persistent cancellation shared by native execution and the SQL worker."""

from __future__ import annotations

import threading
from typing import Any

import duckdb

from .types import SQLCursor


class Cursor:
    """A DuckDB cursor that, once interrupted, refuses every later statement."""

    def __init__(self, cursor: SQLCursor) -> None:
        self.cursor = cursor
        self.lock = threading.Lock()
        self.canceled = False
        self.finished: threading.Event | None = None

    def __getattr__(self, name: str) -> Any:
        return getattr(self.cursor, name)

    def fetchone(self) -> tuple[Any, ...] | None:
        return self.cursor.fetchone()

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self.cursor.fetchall()

    def close(self) -> None:
        self.cursor.close()

    def execute(self, query: str, parameters: Any = None) -> Cursor:
        finished = threading.Event()
        with self.lock:
            if self.canceled:
                raise duckdb.InterruptException("Execution canceled")
            self.finished = finished
        try:
            self.cursor.execute(query, parameters or [])
            return self
        finally:
            finished.set()

    def interrupt(self) -> None:
        with self.lock:
            self.canceled = True
            finished = self.finished
        # DuckDB can reset an early interrupt while starting a statement. Keep
        # interrupting that operation until it exits; later statements are denied.
        if finished:
            while not finished.is_set():
                self.cursor.interrupt()
                finished.wait(0.01)
