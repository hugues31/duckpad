"""Export results per node and environment, and the private copies offered for download."""

from __future__ import annotations

import threading
from collections.abc import Iterable
from contextlib import AbstractContextManager, suppress
from pathlib import Path
from typing import BinaryIO

from ..access import Access
from ..artifacts import Artifacts
from ..catalog import Catalog
from ..components import expand_for
from ..graph import connection_references, reachable
from ..projects import Projects
from ..store import Store
from ..templates import URI
from ..types import Connections, Record, RunToken
from ..util import Problem, digest
from .fingerprints import Fingerprints


class Exports:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        catalog: Catalog,
        access: Access | None,
        fingerprints: Fingerprints,
        lock: threading.RLock,
        active: dict[str, RunToken],
    ) -> None:
        self.store, self.projects, self.catalog, self.access = store, projects, catalog, access
        self.fingerprints = fingerprints
        # The engine lock and the active runs it guards.
        self.lock, self.active = lock, active
        # Serializes file writes and their capture across worktrees sharing a destination.
        self.write_lock = threading.Lock()
        self.artifacts = Artifacts(store)

    def capture(self, export_file: Record, run: Record, node: str, captured: Connections) -> str | None:
        """Copy a completed file export for download; None when the copy is unavailable."""
        roots = [self.store.paths.exports(run["worktree"], run["environment"])]
        if self.access:
            _, writable = self.access.local_roots(run["project"], captured)
            roots.extend(writable)
        else:
            roots.extend(
                Path(c["values"]["root"]).resolve()
                for c in captured.values()
                if c["values"].get("root") and not URI.match(c["values"]["root"])
            )
        try:
            return self.artifacts.capture(export_file, run, node, roots)
        except OSError:
            # The external export succeeded even if its download copy is unavailable.
            return None

    def record(self, run: Record) -> list[str]:
        """Make a run's export nodes the current results of their environment.

        Runs inside the caller's store transaction, deleting the records of the download
        copies it replaces; pass the returned identities to discard() once committed.
        """
        replaced: list[str] = []
        for key, state in run["nodes"].items():
            if state.get("kind") != "export":
                continue
            identity = digest([run["worktree"], run["environment"], key])
            previous = self.store.get("export_result", identity)
            if previous and previous.get("artifact") not in (None, state.get("artifact")):
                replaced.append(previous["artifact"])
            self.store.put(
                "export_result",
                identity,
                {
                    **{k: state.get(k) for k in ("status", "fingerprint", "artifact")},
                    **{k: run[k] for k in ("worktree", "environment", "commit", "started")},
                    "node": key,
                    "run": run["id"],
                    "run_status": run["status"],
                },
            )
        for artifact in replaced:
            self.store.delete("artifact", artifact)
        return replaced

    def discard(self, artifacts: Iterable[str]) -> None:
        """Remove the files of replaced download copies."""
        for identity in artifacts:
            # Windows keeps a file that a download is still reading.
            with suppress(OSError):
                (self.store.paths.artifacts / identity).unlink(missing_ok=True)

    def mark_stale(self, worktree: str, environment: str, nodes: Iterable[str]) -> None:
        """Mark export results stale, keeping their download copies."""
        for key in nodes:
            identity = digest([worktree, environment, key])
            previous = self.store.get("export_result", identity)
            if previous:
                self.store.put("export_result", identity, {**previous, "status": "stale"})

    def result(self, worktree: str, environment: str, node: str) -> Record:
        """Describe only the current export attempt in this exact execution context."""
        self.catalog.environment(environment)
        with self.projects.locked(worktree), self.lock:
            snapshot = self.projects.snapshot(worktree)
            if not snapshot["bundle"]:
                return {"status": "stale"}
            nodes, edges, _ = expand_for(
                snapshot["bundle"],
                environment,
                computed=self.fingerprints.pool.computed(worktree, environment, snapshot["bundle"]),
            )
            definition = nodes.get(node)
            if not definition:
                raise Problem("Node not found", 404)
            download = definition["parsed"].get("download")
            if not download:
                return {"status": "unsupported"}
            values = {p["name"]: p.get("default") for p in definition["parsed"]["parameters"]}
            destination = (values | definition.get("params", {}))[download["parameter"]]
            if URI.match(str(destination)):
                return {"status": "unsupported"}
            result = self.store.get("export_result", digest([worktree, environment, node]))
            if not result:
                return {"status": "not_run"}
            public = {k: result[k] for k in ("run", "commit", "started", "status")}
            active = self.active.get(worktree)
            if active and active["id"] == result["run"]:
                return {**public, "status": "running"}
            if result["status"] != "success":
                return {**public, "status": "stale" if result["status"] == "stale" else "failed"}
            if self.access:
                references = [
                    ref
                    for key in reachable({node}, edges, upstream=True)
                    for ref in connection_references(nodes[key])
                ]
                try:
                    self.access.connections(snapshot["worktree"]["project"], references)
                except Problem:
                    return {**public, "status": "stale"}
            current = self.fingerprints.of(
                snapshot["bundle"],
                environment,
                computed=self.fingerprints.pool.computed(worktree, environment, snapshot["bundle"]),
            )
            if current.get(node) != result["fingerprint"]:
                return {**public, "status": "stale"}
            if result["run_status"] in ("canceled", "interrupted"):
                return {**public, "status": "failed"}
            try:
                with self.artifacts.open(
                    result.get("artifact") or "", worktree, environment, node, result["run"]
                ) as (_, record):
                    return {
                        **public,
                        **{k: record[k] for k in ("filename", "size", "media_type")},
                        "status": "available",
                    }
            except Problem:
                return {**public, "status": "missing"}

    def open(
        self, worktree: str, environment: str, node: str, run: str
    ) -> AbstractContextManager[tuple[BinaryIO, Record]]:
        """Validate the selected run and pin its private artifact before streaming."""
        with self.projects.locked(worktree), self.lock:
            result = self.result(worktree, environment, node)
            if result.get("run") != run or result["status"] != "available":
                raise Problem(
                    "Export is unavailable. Refresh the result or run the export again.",
                    404 if result["status"] == "missing" else 409,
                )
            record = self.store.get("export_result", digest([worktree, environment, node]))
            return self.artifacts.open(record["artifact"], worktree, environment, node, run)
