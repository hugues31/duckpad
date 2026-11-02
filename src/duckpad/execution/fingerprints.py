"""Computation fingerprints, which change only when a node's result could change."""

from __future__ import annotations

import logging

from .. import partitions, project_extensions, variables
from ..bundle import topological
from ..catalog import Catalog
from ..components import expand_for
from ..datasets import Context
from ..graph import connection_references
from ..partition_storage import PartitionStorage
from ..projects import Projects
from ..templates import executable_sql
from ..types import Connections, Record
from ..util import Problem, digest
from .contexts import ContextPool

logger = logging.getLogger(__name__)


class Fingerprints:
    def __init__(self, projects: Projects, catalog: Catalog, pool: ContextPool) -> None:
        self.projects, self.catalog, self.pool = projects, catalog, pool

    def of(
        self,
        bundle: Record,
        environment: str,
        captured: Connections | None = None,
        computed: Record | None = None,
        partition: Record | None = None,
        manifest: list[Record] | None = None,
    ) -> dict[str, str]:
        shared, keys = self.batch(bundle, environment, captured, computed, manifest, partition)
        return keys[partitions.identity(partition["key"])] if partition else shared

    def batch(
        self,
        bundle: Record,
        environment: str,
        captured: Connections | None = None,
        computed: Record | None = None,
        manifest: list[Record] | None = None,
        partition: Record | None = None,
    ) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
        """One expansion per key, one topological pass, including successive collection barriers.

        Callers reuse this batch for the entire run or read. Collector fingerprints
        consume already computed per-key inputs instead of recursively expanding the graph.
        """
        nodes, edges, _ = expand_for(bundle, environment, computed=computed)
        entries = {partitions.identity(e["key"]): e for e in manifest or []}
        if partition:
            entries.setdefault(partitions.identity(partition["key"]), partition)
        variants = {
            key: expand_for(bundle, environment, computed=computed, partition=entry)[0]
            for key, entry in entries.items()
        }
        shared: dict[str, str] = {}
        values: dict[str, dict[str, str]] = {key: {} for key in entries}
        incoming = {key: [] for key in nodes}
        for edge in edges:
            incoming[edge["target"]].append(edge)
        connections = {}
        for node in nodes.values():
            for reference in connection_references(node):
                if reference in connections:
                    continue
                try:
                    captured_values = captured or self.catalog.capture([reference], environment)[0]
                    connections[reference] = captured_values[reference]["fingerprint"]
                except (Problem, KeyError) as error:
                    connections[reference] = "invalid:" + str(error)
        extensions = project_extensions.enabled(bundle.get("extensions"))

        def fingerprint(key: str, node: Record, inputs: dict[str, str], entry: Record | None = None) -> str:
            params = {
                parameter["name"]: parameter["default"]
                for parameter in node["parsed"]["parameters"]
                if "default" in parameter
            }
            params.update(node.get("params", {}))
            collected = node.get("partition_collect_inputs", [])
            return digest(
                {
                    "sql": executable_sql(node["template_sql"]),
                    "error": node.get("error"),
                    "params": variables.fingerprinted(node, params),
                    "connections": {r: connections[r] for r in connection_references(node)},
                    "extensions": extensions,
                    **(
                        {
                            "partition": {
                                "key": {k: entry["key"][k] for k in ("type", "value")}
                                if entry and node.get("partitioned")
                                else None,
                                "filters": {
                                    p: d.get("column") if isinstance(d, dict) else d
                                    for p, d in node.get("partition_filters", {}).items()
                                },
                                "collect": collected,
                            }
                        }
                        if node.get("partitioned") or collected
                        else {}
                    ),
                    **(
                        {
                            "manifest": [
                                (
                                    e["key_hash"],
                                    [
                                        (
                                            edge["targetHandle"],
                                            values[partitions.identity(e["key"])].get(edge["source"]),
                                        )
                                        for edge in incoming[key]
                                        if edge["targetHandle"] in collected
                                    ],
                                )
                                for e in manifest
                            ]
                        }
                        if collected and manifest is not None
                        else {}
                    ),
                    "inputs": [
                        (
                            e["targetHandle"],
                            e["source"],
                            e["sourceHandle"],
                            "collected"
                            if manifest is not None and e["targetHandle"] in collected
                            else inputs.get(e["source"], "invalid"),
                        )
                        for e in incoming[key]
                    ],
                }
            )

        for key in topological(nodes, edges, tolerant=True):
            node = nodes[key]
            shared[key] = fingerprint(key, node, shared)
            for identity, entry in entries.items():
                values[identity][key] = (
                    fingerprint(key, variants[identity][key], values[identity], entry)
                    if node.get("partitioned")
                    else shared[key]
                )
        return shared, values

    def manifest(self, worktree: str, environment: str, bundle: Record) -> list[Record] | None:
        try:
            dimension = partitions.definition(bundle["flow"])
        except Problem:
            return None
        if not dimension:
            return None
        storage = PartitionStorage(self.projects.store, worktree, environment)
        metadata = storage.manifest(signature=partitions.signature(dimension))
        return storage.entries(metadata["id"]) if metadata else None

    def current(self, worktree: str, environment: str) -> dict[str, str]:
        """Fingerprints of the committed files, or none when they cannot be expanded."""
        snapshot = self.projects.snapshot(worktree, committed=True)
        if snapshot["bundle"] is None:
            return {}
        try:
            return self.of(
                snapshot["bundle"],
                environment,
                computed=self.pool.computed(worktree, environment, snapshot["bundle"]),
                manifest=self.manifest(worktree, environment, snapshot["bundle"]),
            )
        except Exception:
            # Unreadable definitions invalidate every result rather than blocking the caller.
            logger.warning("Cannot fingerprint worktree %s", worktree, exc_info=True)
            return {}

    def invalidate(self, context: Context) -> None:
        """Recover scalar-only staleness when a refreshed typed value matches again.

        Explicit data launches clear this flag at admission, so a scalar refresh
        cannot make a replaced real input or an explicitly stale result valid.
        """
        snapshot = self.projects.snapshot(context.worktree, committed=True)
        bundle = snapshot["bundle"]
        if bundle is None:
            self.pool.mark_stale(context, {})
            return
        computed = self.pool.computed(context.worktree, context.environment, bundle)
        manifest = self.manifest(context.worktree, context.environment, bundle)
        current, per_key = self.batch(bundle, context.environment, computed=computed, manifest=manifest)
        previous: dict[str, dict[str, str]] = {}
        with context.lock:
            generations = {}
            for dataset in context.datasets.values():
                if dataset.partition:
                    identity = partitions.identity(dataset.partition["key"])
                    generations[dataset.id] = per_key.get(identity, {}).get(dataset.node, "invalid")
            published = {data.id for outputs in context.outputs.values() for data in outputs.values()}
            for dataset in context.datasets.values():
                if dataset.origins and dataset.id not in published:
                    generations[dataset.id] = (
                        dataset.fingerprint
                        if all(
                            (target := context.datasets.get(origin["dataset"]))
                            and generations.get(target.id, current.get(target.node)) == target.fingerprint
                            for origin in dataset.origins
                        )
                        else "invalid"
                    )
            recover = []
            for dataset in context.datasets.values():
                if current.get(dataset.node) == dataset.fingerprint:
                    if dataset.value_stale:
                        recover.append(dataset)
                    continue
                if dataset.bound_values and (dataset.status == "valid" or dataset.value_stale):
                    signature = digest(dataset.bound_values)
                    if signature not in previous:
                        previous[signature] = self.of(
                            bundle, context.environment, computed=dataset.bound_values
                        )
                    dataset.value_stale = previous[signature].get(dataset.node) == dataset.fingerprint
            self.pool.mark_stale(context, current, generations)
            for dataset in recover:
                dataset.status = "valid"
                dataset.value_stale = False
