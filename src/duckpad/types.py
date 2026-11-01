"""Shared boundaries for dynamic project documents and live execution resources.

Documents retain their existing JSON-shaped dictionaries during gradual typing.
Resource handles and run coordination are typed independently of their payloads.
"""

from __future__ import annotations

import threading
from typing import Any, NotRequired, Protocol, TypedDict

Record = dict[str, Any]
Files = dict[str, str]
Connections = dict[str, Record]


class SQLCursor(Protocol):
    def execute(self, query: str, parameters: Any = None) -> SQLCursor: ...
    def fetchone(self) -> tuple[Any, ...] | None: ...
    def fetchall(self) -> list[tuple[Any, ...]]: ...
    def interrupt(self) -> None: ...
    def close(self) -> None: ...


class SQLDatabase(Protocol):
    def cursor(self) -> SQLCursor: ...
    def close(self) -> None: ...


class RunToken(TypedDict):
    id: str
    cancel: threading.Event
    cursor: SQLCursor | None


class LineageRequest(TypedDict):
    nodes: set[str]
    canceled: threading.Event
    cursor: SQLCursor
    # Display readers accept stale results; they stop only before those results are dropped.
    display: NotRequired[bool]
