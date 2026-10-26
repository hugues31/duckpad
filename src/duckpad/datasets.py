"""Materialized results and the per-worktree, per-environment DuckDB contexts that own them."""

import threading
from dataclasses import dataclass, field

import duckdb

from .util import now


@dataclass
class Dataset:
    id: str
    node: str
    port: str
    table: str
    columns: list
    count: int
    run: str
    query: str
    bindings: dict
    dependencies: dict
    fingerprint: str
    source: bool = False
    status: str = "valid"
    created: str = field(default_factory=now)
    storage: str = ""
    column_map: dict = field(default_factory=dict)
    witnesses: dict = field(default_factory=dict)
    groups: dict = field(default_factory=dict)

    @property
    def relation(self):
        """The physical table holding the rows, including hidden lineage columns."""
        return self.storage or self.table

    def stored(self, column):
        """The physical name of a public column; user columns named rowid are renamed."""
        return self.column_map.get(column, column)

    def public(self):
        return {
            key: getattr(self, key)
            for key in ("id", "node", "port", "columns", "count", "run", "status", "created")
        }


@dataclass
class Context:
    worktree: str
    environment: str
    db: duckdb.DuckDBPyConnection
    outputs: dict = field(default_factory=dict)
    datasets: dict = field(default_factory=dict)
    errors: dict = field(default_factory=dict)
    node_status: dict = field(default_factory=dict)
    lineage: dict = field(default_factory=dict)
    lock: object = field(default_factory=threading.RLock)
    trace_lock: object = field(default_factory=threading.RLock)
