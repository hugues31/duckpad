"""Run lifecycle and orchestration of execution services."""

from __future__ import annotations

import threading
import time
from contextlib import suppress
from contextvars import copy_context
from dataclasses import dataclass, field
from typing import cast

import duckdb

from ..catalog import Catalog, redact
from ..datasets import Context, Dataset
from ..partition_runs import PartitionRun
from ..projects import Projects
from ..store import Store
from ..types import Connections, Record, RunToken, SQLCursor
from ..util import Problem, now, uid
from .contexts import ContextPool, interrupt
from .exports import Exports
from .fingerprints import Fingerprints
from .journal import RunJournal, execution_outcome
from .launches import LaunchPlanner
from .nodes import NodeExecutor
from .values import RunValues


@dataclass
class Execution:
    """State of one accepted run, owned by its worker thread."""

    token: RunToken
    context: Context
    run: Record
    nodes: dict[str, Record]
    edges: list[Record]
    order: list[str]
    captured: Connections
    secrets: list[str]
    fingerprints: dict[str, str]
    bundle: Record = field(default_factory=dict)
    sources: Record = field(default_factory=dict)
    values: Record = field(default_factory=dict)
    value_phase: set[str] = field(default_factory=set)
    validation_errors: Record = field(default_factory=dict)
    cursor: SQLCursor | None = None
    prepared: dict[str, Exception | None] = field(default_factory=dict)
    # Parallel partition keys share one database: each connection is attached once.
    preparing: threading.Lock = field(default_factory=threading.Lock)
    published: dict[str, dict[str, Dataset]] = field(default_factory=dict)
    partition_plan: Record = field(default_factory=dict)
    partition: Record | None = None
    schema_only: bool = False

    @property
    def canceled(self) -> bool:
        return self.token["cancel"].is_set()


class Runner:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        catalog: Catalog,
        pool: ContextPool,
        exports: Exports,
        fingerprints: Fingerprints,
        lock: threading.RLock,
        active: dict[str, RunToken],
    ) -> None:
        self.store, self.projects, self.catalog = store, projects, catalog
        self.pool, self.exports, self.fingerprints = pool, exports, fingerprints
        self.lock, self.active = lock, active
        self.journal = RunJournal(store, pool, exports, active)
        self.planner = LaunchPlanner(
            store, projects, catalog, pool, exports, fingerprints, lock, self.journal
        )
        self.nodes = NodeExecutor(store, projects, catalog, pool, exports, fingerprints, lock, self.journal)
        self.values = RunValues(pool, fingerprints, lock, self.journal)
        self.threads: list[threading.Thread] = []
        self.closing = False

    def launch(
        self,
        worktree: str,
        environment: str,
        target: str | None = None,
        entry_point: str = "api",
        *,
        requester: Record | None = None,
        job: Record | None = None,
        external_trigger: Record | None = None,
        idempotency: Record | None = None,
        partition_selection: Record | None = None,
        partition_execution: Record | None = None,
        ancestors: bool = False,
    ) -> Record:
        record = self.projects.get(worktree)
        if record.get("read_only") and job is None:
            raise Problem("Launch this worktree from its Job", 403)
        admission = self.planner.check_launch(
            worktree, environment, target, entry_point, partition_selection, partition_execution, ancestors
        )
        token: RunToken = {"id": uid("run_"), "cancel": threading.Event(), "cursor": None}
        run = self.planner.pending(
            record,
            admission,
            token,
            worktree,
            environment,
            target,
            entry_point,
            requester,
            job,
            external_trigger,
            ancestors,
        )
        # Reservation, visible record, and thread registration are atomic with cancellation/close.
        with self.lock:
            if self.closing:
                raise Problem("The execution service is shutting down", 503)
            self.planner.reserve(worktree, environment, token)

            try:
                self.journal.persist(run, [], idempotency=idempotency)
                thread = threading.Thread(
                    target=copy_context().run,
                    args=(
                        self._execute,
                        token,
                        run,
                        target,
                        partition_selection,
                        partition_execution,
                        ancestors,
                    ),
                    name=token["id"],
                    daemon=True,
                )
                self.threads = [t for t in self.threads if t.is_alive()] + [thread]
                thread.start()
            except Exception:
                self.active.pop(worktree, None)
                raise
        return cast(Record, self.store.get("run", token["id"]))

    def cancel(self, run_id: str) -> Record:
        run = self.store.get("run", run_id)
        if not run:
            raise Problem("Execution not found", 404)
        with self.lock:
            token = self.active.get(run["worktree"])
            if not token or token["id"] != run_id:
                return cast(Record, self.store.get("run", run_id))
            token["cancel"].set()
            cursors = [*token.get("cursors", []), *([token["cursor"]] if token["cursor"] else [])]
        for cursor in cursors:
            interrupt(cursor)
        # The run's later writes keep this status; its final write replaces it.
        with self.store.transaction():
            run = self.store.get("run", run_id)
            if run["status"] in ("preparing", "running"):
                run["status"] = "canceling"
                self.store.put("run", run_id, run)
        return cast(Record, run)

    def _execute(
        self,
        token: RunToken,
        pending: Record,
        target: str | None,
        partition_selection: Record | None,
        partition_execution: Record | None,
        ancestors: bool,
    ) -> None:
        execution = self.planner.start(
            token, pending, target, partition_selection, partition_execution, ancestors
        )
        if execution is None:
            return
        run, secrets, context = execution.run, execution.secrets, execution.context
        started = time.monotonic()
        try:
            assert context.db is not None
            execution.cursor = context.db.cursor()
            execution.token["cursor"] = execution.cursor
            run["status"] = "running"
            self.journal.persist(run, secrets)
            self.pool.forget_removed(context, execution.nodes)
            # Only runs that calculate values report phases, so ordinary runs show no progress label.
            if execution.value_phase:
                run["phase"] = "values"
            for key, error in execution.validation_errors.items():
                execution.nodes[key]["error"] = error["error"]
            self.nodes.execute_nodes(execution, [k for k in execution.order if k in execution.value_phase])
            self.values.freeze(execution)
            if execution.value_phase:
                run["phase"] = "consumers"
            self.journal.persist(run, secrets)
            if (
                any(execution.nodes[k].get("partitioned") for k in execution.order)
                or (execution.partition_plan.get("source") or {}).get("node") in execution.order
            ):
                controller = self.journal.partitions[run["id"]] = PartitionRun(self, execution)
                controller.execute()
            else:
                self.nodes.execute_nodes(
                    execution, [k for k in execution.order if k not in execution.value_phase]
                )
            run["status"] = execution_outcome(execution)
        except Exception as error:
            run.update(
                status="canceled" if execution.canceled else "failed",
                error=redact(str(error), secrets),
            )
            for state in run["nodes"].values():
                if state["status"] in ("pending", "running"):
                    state["status"] = "canceled" if execution.canceled else "blocked"
        finally:
            execution.token["cursor"] = None
            if execution.cursor:
                # A concurrent interrupt of this closed cursor is ignored.
                with suppress(duckdb.Error, Problem):
                    execution.cursor.close()
            with self.lock:
                try:
                    if execution.canceled:
                        run["status"] = "canceled"
                    run.update(finished=now(), duration=time.monotonic() - started)
                    self.journal.persist(run, secrets)
                finally:
                    self.active.pop(context.worktree, None)
                    self.journal.partitions.pop(run["id"], None)

    def close(self) -> None:
        """Cancel active runs and wait for their workers."""
        with self.lock:
            self.closing = True
            tokens, threads = list(self.active.values()), list(self.threads)
        for token in tokens:
            self.cancel(token["id"])
        for thread in threads:
            thread.join()
