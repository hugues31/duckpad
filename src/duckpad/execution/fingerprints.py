"""Computation fingerprints, which change only when a node's result could change."""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict

from .. import partitions, processing
from ..catalog import Catalog
from ..components import expand_for
from ..datasets import Context
from ..graph import connection_references, reachable, topological
from ..partition_storage import PartitionStorage
from ..projects import Projects
from ..python_environment import runtime_signature
from ..types import Connections, Record
from ..util import Problem, digest
from .contexts import ContextPool

logger = logging.getLogger(__name__)


class Fingerprints:
    def __init__(self, projects: Projects, catalog: Catalog, pool: ContextPool) -> None:
        self.projects, self.catalog, self.pool = projects, catalog, pool
        self.cache: OrderedDict[str, tuple[dict[str, str], dict[str, dict[str, str]]]] = OrderedDict()
        self.cache_lock = threading.Lock()

    def cached_batch(
        self, snapshot: Record, environment: str, node: str | None = None
    ) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
        bundle = snapshot["bundle"]
        if not bundle:
            return {}, {}
        computed = self.pool.computed(snapshot["worktree"]["id"], environment, bundle)
        manifest = self.manifest(snapshot["worktree"]["id"], environment, bundle)
        key = digest(
            [
                snapshot["worktree"]["id"],
                snapshot["revision"],
                environment,
                manifest,
                computed,
                self.projects.store.configuration_revision,
                node,
            ]
        )
        with self.cache_lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
        result = self.batch(
            bundle, environment, computed=computed, manifest=manifest, targets={node} if node else None
        )
        with self.cache_lock:
            self.cache[key] = result
            while len(self.cache) > 8:
                self.cache.popitem(last=False)
        return result

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
        *,
        variants: dict[str, dict[str, Record]] | None = None,
        targets: set[str] | None = None,
    ) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
        """One expansion per key, one topological pass, including successive collection barriers.

        Callers reuse this batch for the entire run or read. Collector fingerprints
        consume already computed per-key inputs instead of recursively expanding the graph.
        """
        nodes, edges, _ = expand_for(bundle, environment, computed=computed)
        if targets is not None:
            wanted = reachable(targets, edges, upstream=True)
            nodes = {key: value for key, value in nodes.items() if key in wanted}
            edges = [edge for edge in edges if edge["source"] in nodes and edge["target"] in nodes]
        entries = {partitions.identity(e["key"]): e for e in manifest or []}
        if partition:
            entries.setdefault(partitions.identity(partition["key"]), partition)
        variants = variants if variants is not None else {}
        for key, entry in entries.items():
            if key not in variants:
                variants[key] = expand_for(bundle, environment, computed=computed, partition=entry)[0]
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
                    # Server secrets authenticate: a missing one must not make results stale.
                    captured_values = (
                        captured or self.catalog.capture([reference], environment, resolve=False)[0]
                    )
                    connections[reference] = captured_values[reference]["fingerprint"]
                except (Problem, KeyError) as error:
                    connections[reference] = "invalid:" + str(error)
        python_runtime = (
            runtime_signature() if any(n.get("language") == "python" for n in nodes.values()) else None
        )

        def fingerprint(key: str, node: Record, inputs: dict[str, str], entry: Record | None = None) -> str:
            collected = node.get("partition_collect_inputs", [])
            return digest(
                {
                    **processing.inputs(bundle, node, python_runtime=python_runtime, entry=entry),
                    "connections": {r: connections[r] for r in connection_references(node)},
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
            return self.cached_batch(snapshot, environment)[0]
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
        current, per_key = self.cached_batch(snapshot, context.environment)
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
