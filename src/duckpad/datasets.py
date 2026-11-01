"""Materialized results and the per-worktree, per-environment DuckDB contexts that own them."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from .types import LineageRequest, Record, SQLDatabase
from .util import now


@dataclass
class Dataset:
    id: str
    node: str
    port: str
    columns: list[dict[str, str]]
    count: int
    run: str
    query: str
    bindings: Record
    dependencies: dict[str, str]
    fingerprint: str
    storage: str
    source: bool = False
    status: str = "valid"
    created: str = field(default_factory=now)
    column_map: dict[str, str] = field(default_factory=dict)
    witnesses: Record = field(default_factory=dict)
    groups: Record = field(default_factory=dict)
    # Placeholder -> project variable, for the bindings that hold a variable's value.
    labels: dict[str, str] = field(default_factory=dict)
    # Seconds the run spent computing this output.
    duration: float | None = None
    # Column statistics computed on request; released with the result generation.
    statistics: Record | None = None

    @property
    def table(self) -> str:
        """The public view of the rows, named after the result generation."""
        return self.id

    @property
    def relation(self) -> str:
        """The physical table holding the rows, including hidden lineage columns."""
        return self.storage

    def stored(self, column: str) -> str:
        """The physical name of a public column; user columns named rowid are renamed."""
        return self.column_map.get(column, column)

    def public(self) -> Record:
        return {
            key: getattr(self, key)
            for key in ("id", "node", "port", "columns", "count", "run", "status", "created")
        }


@dataclass
class Context:
    worktree: str
    environment: str
    db: SQLDatabase | None
    extensions: list[Record] = field(default_factory=list)
    outputs: dict[str, dict[str, Dataset]] = field(default_factory=dict)
    datasets: dict[str, Dataset] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    node_status: dict[str, str] = field(default_factory=dict)
    result_runs: dict[str, str] = field(default_factory=dict)
    lineage: dict[str, LineageRequest] = field(default_factory=dict)
    lock: threading.RLock = field(default_factory=threading.RLock)
    trace_lock: threading.RLock = field(default_factory=threading.RLock)
