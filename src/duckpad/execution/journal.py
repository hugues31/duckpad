"""Run persistence, cancellation ordering and recovery after a stopped backend."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from ..catalog import redact
from ..partition_runs import PartitionRun
from ..partition_storage import PartitionStorage
from ..store import Store
from ..types import Record, RunToken
from .contexts import ContextPool
from .exports import Exports
from .messages import result_counts

if TYPE_CHECKING:
    from .runs import Execution

UNFINISHED_RUN_STATUSES = ("preparing", "running", "canceling")


def run_outcome(statuses: set[str], canceled: bool) -> str:
    if canceled:
        return "canceled"
    failed = bool(statuses & {"failed", "blocked"})
    if failed and "success" in statuses:
        return "partial_failure"
    return "failed" if failed else "success"


class RunJournal:
    def __init__(
        self, store: Store, pool: ContextPool, exports: Exports, active: dict[str, RunToken]
    ) -> None:
        self.store, self.pool, self.exports, self.active = store, pool, exports, active
        self.partitions: dict[str, PartitionRun] = {}

    def recover(self) -> None:
        """Close runs left unfinished by a stopped backend; nothing is replayed."""
        for run in self.store.runs_with_statuses(UNFINISHED_RUN_STATUSES):
            run["status"] = "interrupted"
            run["error"] = (
                "The backend stopped before completion was confirmed. Manual recomputation is required."
            )
            for node in run["nodes"].values():
                if node["status"] in ("pending", "running"):
                    if node["status"] == "running" and node.get("writes_external"):
                        node["external_outcome"] = "unknown"
                    node["status"] = "interrupted"
            if manifest := run.get("partitions", {}).get("manifest"):
                storage = PartitionStorage(self.store, run["worktree"], run["environment"])
                for entry in storage.entries(manifest):
                    for key, state in storage.attempts(run["id"], entry["partition_id"]).items():
                        if state["status"] in ("pending", "running"):
                            state["status"] = "interrupted"
                            if state.get("writes_external"):
                                state["external_outcome"] = "unknown"
                            storage.attempt(run["id"], entry["partition_id"], key, state)
                            storage.record(key, entry, state)
                for partial in storage.temporary.glob("partition_*.partial"):
                    partial.unlink(missing_ok=True)
            self.persist(run, [])

    def persist(self, run: Record, secrets: list[str], *, idempotency: Record | None = None) -> None:
        if run.get("partition_attempt"):
            if run["partition_attempt"] != "empty":
                self.partitions[run["id"]].persist(run)
            return
        run["warning_count"] = sum(
            result_counts(state.get("results", []))["warning"] for state in run["nodes"].values()
        )

        def sanitize(value: Any) -> Any:
            if isinstance(value, str):
                return redact(value, secrets)
            if isinstance(value, dict):
                return {key: sanitize(item) for key, item in value.items()}
            if isinstance(value, list):
                return [sanitize(item) for item in value]
            return value

        with self.store.transaction():
            # Check inside the write, which serializes with a cancellation request's own update.
            token = self.active.get(run["worktree"])
            if (
                token
                and token["id"] == run["id"]
                and token["cancel"].is_set()
                and run["status"] in ("preparing", "running")
            ):
                run["status"] = "canceling"
            self.store.put("run", run["id"], sanitize(run))
            if idempotency is not None:
                self.store.remember_job_launch(idempotency, run["id"], time.time())
            replaced = self.exports.record(run)
        self.exports.discard(replaced)
        context = self.pool.find(run["worktree"], run["environment"])
        if context:
            with context.lock:
                context.node_status.update({key: state["status"] for key, state in run["nodes"].items()})


def execution_outcome(execution: Execution) -> str:
    run = execution.run
    statuses = {n["status"] for n in run["nodes"].values()}
    if any(v.get("resolution") == "calculated" and v.get("error") for v in run["variables"].values()):
        statuses.add("failed")
    status = run_outcome(statuses, execution.canceled)
    partition_summary = run.get("partitions", {})
    if (
        partition_summary.get("selected")
        and not execution.canceled
        and (partition_summary.get("failed") or partition_summary.get("not_started"))
    ):
        status = "partial_failure" if partition_summary.get("completed") else "failed"
    return status
