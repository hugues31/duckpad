"""Live DuckDB contexts per worktree and environment, and the SQL workers behind them."""

from __future__ import annotations

import re
import threading
import time
from collections.abc import Collection
from contextlib import suppress

import duckdb

from ..access import Access
from ..catalog import Catalog, redact
from ..datasets import Context
from ..extensions import database_config
from ..materialize import drop_dataset
from ..projects import Projects
from ..store import Store
from ..types import Connections, Record, SQLCursor, SQLDatabase
from ..util import Problem

# How often a writer waits for lineage readers to release results it drops.
READER_POLL_INTERVAL = 0.005
# URL prefixes that DuckDB scopes to each object storage secret type by default.
REMOTE_PREFIXES = {"s3": ("s3://", "s3a://", "s3n://"), "r2": ("r2://",), "gcs": ("gcs://", "gs://")}
SECRET_OPTIONS = re.compile(r"\bSECRET\s+\{\{\s*secret_name\s*\}\}\s*\(([^)]*)", re.IGNORECASE)
SECRET_TYPE = re.compile(r"\bTYPE\s+[\"']?(\w+)", re.IGNORECASE)


def remote_prefixes(captured: Connections) -> list[str]:
    """Remote URL prefixes covered by the connections' storage secret types, whatever their IDs."""
    prefixes: list[str] = []
    for connection in captured.values():
        sql = re.sub(r"--[^\n]*|/\*.*?\*/", "", connection["definition"].get("init_sql", ""), flags=re.DOTALL)
        for options in SECRET_OPTIONS.findall(sql):
            for kind in SECRET_TYPE.findall(options):
                prefixes += [p for p in REMOTE_PREFIXES.get(kind.lower(), ()) if p not in prefixes]
    return prefixes


def interrupt(cursor: SQLCursor) -> None:
    """Interrupt a cursor without waiting for its statement to stop.

    Cancellation persists in the cursor, and a cursor closed meanwhile has nothing left to stop.
    """

    def stop() -> None:
        with suppress(duckdb.Error, Problem):
            cursor.interrupt()

    threading.Thread(target=stop, name="interrupt", daemon=True).start()


def cancel_lineage(context: Context, affected: set[str] | None = None) -> None:
    """Interrupt the lineage requests reading results of the affected nodes, or all of them."""
    for request in list(context.lineage.values()):
        if affected is None or request["nodes"] & affected:
            request["canceled"].set()
            interrupt(request["cursor"])


def wait_for_readers(context: Context, nodes: set[str]) -> None:
    """Wait until no lineage request reads results of these nodes.

    Readers acknowledge cancellation in their finally block.
    """
    while any(request["nodes"] & nodes for request in list(context.lineage.values())):
        time.sleep(READER_POLL_INTERVAL)


class ContextPool:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        catalog: Catalog,
        access: Access | None,
        isolated: bool,
        lock: threading.RLock,
    ) -> None:
        self.store, self.projects, self.catalog, self.access = store, projects, catalog, access
        self.isolated = isolated
        # The engine lock, which guards the pool's mapping.
        self.lock = lock
        self.contexts: dict[tuple[str, str], Context] = {}

    def get(self, worktree: str, environment: str, create: bool = False) -> Context:
        """The live DuckDB context of an existing worktree in a configured environment.

        Its database starts outside the engine lock, so status and cancellation requests
        never wait for a worker, extension installation or connection setup.
        """
        key = (worktree, environment)
        while True:
            self.projects.get(worktree)
            if environment not in self.catalog.environment_names():
                raise Problem("Unknown environment", 404)
            with self.lock:
                context, stopped = self.contexts.get(key), None
                if context is None or getattr(context.db, "closed", False):
                    stopped = context.db if context is not None else None
                    context = self.contexts[key] = Context(*key, db=None)
            if stopped:
                # Reap the replaced worker's process and release its descriptors.
                stopped.close()
            if context.db is not None or (self.access and not create):
                return context
            database = self._open(worktree, environment)
            with self.lock:
                if self.contexts.get(key) is context and context.db is None:
                    context.db = database
                    return context
            # Another request published its database first, or the context was discarded meanwhile.
            database.close()
            if self.contexts.get(key) is context:
                return context

    def find(self, worktree: str, environment: str) -> Context | None:
        """The context of a worktree in an environment if one was started, without starting it."""
        return self.contexts.get((worktree, environment))

    def all(self, worktree: str | None = None) -> list[Context]:
        """Started contexts, of one worktree when given."""
        with self.lock:
            return [c for c in self.contexts.values() if worktree is None or c.worktree == worktree]

    def capture(
        self, worktree: str, references: list[str], environment: str
    ) -> tuple[Connections, list[str]]:
        """Settings of connections the worktree's project may use, with the secrets to redact."""
        if self.access:
            self.access.connections(self.projects.get(worktree)["project"], references)
        return self.catalog.capture(references, environment)

    def extension_settings(self) -> dict[str, bool]:
        return {"allow_unsigned_extensions": self.store.get("settings", "allow_unsigned_extensions", False)}

    def _open(self, worktree: str, environment: str) -> SQLDatabase:
        extensions = self.store.paths.extensions
        extensions.mkdir(exist_ok=True)
        config = {**database_config(extensions), **self.extension_settings()}
        if not self.isolated:
            return duckdb.connect(":memory:", config=config)
        from ..sandbox import Database

        project = self.projects.get(worktree)["project"]
        captured, secrets = self._configured_connections(project, environment)
        assert self.access is not None
        roots, writable = self.access.local_roots(project, captured)
        directory = self.store.paths.exports(worktree, environment)
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / ".temporary"
        temporary.mkdir(exist_ok=True)
        self._install_extensions(captured, config, secrets)
        try:
            return Database(
                {
                    "captured": captured,
                    "extensions": str(extensions),
                    "allow_unsigned_extensions": config["allow_unsigned_extensions"],
                    "offline_extensions": self.store.get("settings", "offline_extensions", {}),
                    "read_paths": [str(p) for p in roots],
                    "write_paths": [str(p) for p in [*writable, directory]],
                    "temporary": str(temporary),
                    "remote_paths": remote_prefixes(captured),
                }
            )
        except Problem as error:
            raise Problem(redact(str(error), secrets), error.status, error.detail) from None

    def _configured_connections(self, project: str, environment: str) -> tuple[Connections, list[str]]:
        """Capture the project's authorized connections that are fully configured for the environment.

        Creating an environment adds an empty configuration to every connection. A connection
        still missing required settings stays unavailable instead of failing every run; nodes
        that use it are blocked by their own capture error.
        """
        captured: Connections = {}
        secrets: list[str] = []
        assert self.access is not None
        for reference in self.access.record(project)["connections"]:
            try:
                values, hidden = self.catalog.capture([reference], environment)
            except Problem:
                continue
            captured.update(values)
            secrets.extend(hidden)
        return captured, secrets

    def _install_extensions(self, captured: Connections, config: Record, secrets: list[str]) -> None:
        """Provision trusted administrator-declared extensions before the worker gets read-only
        access to their cache. Connection setup, such as ATTACH, runs only in the worker."""
        declared = [c for c in captured.values() if c["definition"].get("extensions")]
        if not declared:
            return
        with duckdb.connect(config=config) as setup:
            for connection in declared:
                definition = {**connection["definition"], "init_sql": ""}
                try:
                    self.catalog.prepare(setup, {"extensions": {**connection, "definition": definition}})
                except duckdb.Error as error:
                    raise Problem(
                        f"Cannot install the extensions of connection {connection['name']}: "
                        + redact(str(error), secrets),
                        503,
                    ) from None

    def mark_stale(self, context: Context, fingerprints: dict[str, str]) -> None:
        """Mark results whose fingerprint changed stale, and interrupt lineage requests reading them."""
        with context.lock:
            changed = set()
            for dataset in context.datasets.values():
                if fingerprints.get(dataset.node) != dataset.fingerprint:
                    dataset.status = "stale"
                    changed.add(dataset.node)
            cancel_lineage(context, changed)

    def forget_removed(self, context: Context, nodes: Collection[str]) -> None:
        """Drop the results and states of nodes absent from the definitions, once no lineage
        request reads them. Only the run that owns the worktree may call this."""
        with context.lock:
            removed = {d.node for d in context.datasets.values()}
            removed |= {*context.outputs, *context.errors, *context.node_status}
            removed -= set(nodes)
            if not removed:
                return
            for dataset in context.datasets.values():
                if dataset.node in removed:
                    dataset.status = "stale"
            cancel_lineage(context, removed)
        wait_for_readers(context, removed)
        with context.lock:
            assert context.db is not None
            cleanup = context.db.cursor()
            try:
                for dataset in [d for d in context.datasets.values() if d.node in removed]:
                    drop_dataset(cleanup, dataset)
                    del context.datasets[dataset.id]
            finally:
                cleanup.close()
            for node in removed:
                for states in (context.outputs, context.errors, context.node_status):
                    states.pop(node, None)

    def discard(self, worktree: str) -> None:
        """Close every environment context of a worktree, even after the worktree was removed."""
        with self.lock:
            for key, context in list(self.contexts.items()):
                if context.worktree == worktree:
                    with context.lock:
                        cancel_lineage(context)
                        if context.db:
                            context.db.close()
                        del self.contexts[key]

    def close(self) -> None:
        with self.lock:
            contexts = list(self.contexts.values())
            self.contexts.clear()
        for context in contexts:
            if context.db:
                context.db.close()
