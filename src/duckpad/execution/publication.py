"""Atomic publication and retirement of node results."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

from ..datasets import Dataset
from ..materialize import (
    drop_dataset,
)
from ..projects import Projects
from ..types import Record
from ..util import Problem
from .contexts import ContextPool, cancel_lineage, wait_for_readers
from .fingerprints import Fingerprints
from .journal import RunJournal

if TYPE_CHECKING:
    from .runs import Execution


class Publication:
    def __init__(
        self,
        projects: Projects,
        pool: ContextPool,
        fingerprints: Fingerprints,
        lock: threading.RLock,
        journal: RunJournal,
    ) -> None:
        self.projects, self.pool, self.fingerprints = projects, pool, fingerprints
        self.lock, self.journal = lock, journal

    def publish(self, execution: Execution, key: str, staged: dict[str, Dataset]) -> dict[str, Dataset]:
        """Atomically replace a node's outputs; return the previous output set."""
        context = execution.context
        if execution.partition is not None:
            return self.journal.partitions[execution.run["id"]].publish(execution, key, staged)
        # A later edit must not turn a result for the old snapshot valid.
        with self.projects.locked(context.worktree):
            current = self.fingerprints.current(context.worktree, context.environment)
            with self.lock, context.lock:
                if execution.canceled:
                    raise Problem("Execution canceled before publication")
                previous = context.outputs.get(key, {})
                for dataset in staged.values():
                    if current.get(key) != dataset.fingerprint:
                        dataset.status = "stale"
                    context.datasets[dataset.id] = dataset
                context.outputs[key] = staged
                context.errors.pop(key, None)
                execution.published[key] = staged
        return previous

    def retire(self, execution: Execution, key: str, previous: dict[str, Dataset]) -> None:
        """Drop replaced outputs and their lineage tables once no lineage reader uses them."""
        context = execution.context
        with context.lock:
            protected = set()

            def retain(identity: str) -> None:
                if identity in protected or identity not in context.datasets:
                    return
                protected.add(identity)
                for parent in context.datasets[identity].dependencies.values():
                    retain(parent)

            for outputs in context.outputs.values():
                for current in outputs.values():
                    if current.opaque_python:
                        retain(current.id)
            for identity in protected:
                context.datasets[identity].historical = True
            current_ids = {data.id for outputs in context.outputs.values() for data in outputs.values()}
            retired = {data.id: data for data in previous.values()}
            retired.update(
                {
                    identity: data
                    for identity, data in context.datasets.items()
                    if data.historical and identity not in protected | current_ids
                }
            )
        for dataset in retired.values():
            if dataset.id in protected:
                continue
            with context.lock:
                cancel_lineage(context, {dataset.node}, dropping=True)
            wait_for_readers(context, {dataset.node})
            with context.lock:
                traces = [
                    d
                    for d in context.datasets.values()
                    if d.id.startswith("trace_") and d.node == dataset.node and d.run != execution.run["id"]
                ]
                assert context.db is not None
                cleanup = context.db.cursor()
                try:
                    for old in [dataset, *traces]:
                        drop_dataset(cleanup, old)
                        context.datasets.pop(old.id, None)
                finally:
                    cleanup.close()

    def prune_documentation(self, execution: Execution, key: str, staged: dict[str, Dataset]) -> None:
        """Remove documentation of columns that the node's current outputs no longer have."""
        context = execution.context
        columns = {
            port: [c["name"] for c in data.columns] for port, data in staged.items() if data.status == "valid"
        }
        if not columns:
            return

        def current(bundle: Record) -> bool:
            fingerprint = self.fingerprints.of(
                bundle,
                context.environment,
                computed=self.pool.computed(context.worktree, context.environment, bundle),
            ).get(key)
            return fingerprint == execution.fingerprints[key]

        self.projects.prune_column_documentation(context.worktree, key, columns, current)
