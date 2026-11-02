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
        _shared: dict[str, str] | None = None,
    ) -> dict[str, str]:
        """Fingerprint every node of a bundle from its SQL, parameters, connections and inputs."""
        # Resolved values make renames, descriptions and promoted literals transparent.
        nodes, edges, _ = expand_for(bundle, environment, computed=computed, partition=partition)
        fingerprints: dict[str, str] = {}
        for key in topological(nodes, edges, tolerant=True):
            node = nodes[key]
            if _shared and not node.get("partitioned") and key in _shared:
                fingerprints[key] = _shared[key]
                continue
            # Earlier collector barriers are shared by every later key. Reuse their
            # ordered manifest fingerprints when computing the next zone's inputs.
            per_key = (
                [
                    (
                        entry,
                        self.of(
                            bundle, environment, captured, computed, partition=entry, _shared=fingerprints
                        ),
                    )
                    for entry in manifest or []
                ]
                if node.get("partition_collect_inputs") and manifest is not None
                else []
            )
            # An omitted parameter and an explicit value equal to its default compute
            # the same result, including when that value comes from a variable.
            params = {
                parameter["name"]: parameter["default"]
                for parameter in node["parsed"]["parameters"]
                if "default" in parameter
            }
            params.update(node.get("params", {}))
            # Expression references count by the type and value they bind, not by their name.
            params = variables.fingerprinted(node, params)
            connections = {}
            for reference in connection_references(node):
                try:
                    values = captured or self.catalog.capture([reference], environment)[0]
                    connections[reference] = values[reference]["fingerprint"]
                except (Problem, KeyError) as error:
                    connections[reference] = "invalid:" + str(error)
            fingerprints[key] = digest(
                {
                    "sql": executable_sql(node["template_sql"]),
                    "error": node.get("error"),
                    "params": params,
                    "connections": connections,
                    "extensions": project_extensions.enabled(bundle.get("extensions")),
                    **(
                        {
                            "partition": {
                                "key": {k: partition["key"][k] for k in ("type", "value")}
                                if partition and node.get("partitioned")
                                else None,
                                "filters": {
                                    p: declaration.get("column")
                                    if isinstance(declaration, dict)
                                    else declaration
                                    for p, declaration in node.get("partition_filters", {}).items()
                                },
                                "collect": node.get("partition_collect_inputs", []),
                            }
                        }
                        if node.get("partitioned") or node.get("partition_collect_inputs")
                        else {}
                    ),
                    **(
                        {
                            "manifest": [
                                (
                                    entry["key_hash"],
                                    [
                                        (e["targetHandle"], values.get(e["source"]))
                                        for e in edges
                                        if e["target"] == key
                                        and e["targetHandle"] in node.get("partition_collect_inputs", [])
                                    ],
                                )
                                for entry, values in per_key
                            ]
                        }
                        if node.get("partition_collect_inputs") and manifest is not None
                        else {}
                    ),
                    "inputs": [
                        (
                            e["targetHandle"],
                            e["source"],
                            e["sourceHandle"],
                            "collected"
                            if manifest is not None
                            and e["targetHandle"] in node.get("partition_collect_inputs", [])
                            else fingerprints.get(e["source"], "invalid"),
                        )
                        for e in edges
                        if e["target"] == key
                    ],
                }
            )
        return fingerprints

    def manifest(self, worktree: str, environment: str, bundle: Record) -> list[Record] | None:
        try:
            dimension = partitions.definition(bundle["flow"])
        except Problem:
            return None
        if not dimension:
            return None
        signature = digest({k: dimension.get(k) for k in ("type", "values", "attributes")})
        storage = PartitionStorage(self.projects.store.paths, worktree, environment)
        metadata = storage.manifest(signature=signature)
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
        current = self.of(
            bundle,
            context.environment,
            computed=computed,
            manifest=self.manifest(context.worktree, context.environment, bundle),
        )
        previous: dict[str, dict[str, str]] = {}
        with context.lock:
            manifest = self.manifest(context.worktree, context.environment, bundle)
            entries = {entry["key_hash"]: entry for entry in manifest or []}
            partition_values, generations = {}, {}
            for dataset in context.datasets.values():
                if dataset.partition:
                    key = dataset.partition["key_hash"]
                    if key not in partition_values:
                        partition_values[key] = (
                            self.of(
                                bundle,
                                context.environment,
                                computed=computed,
                                partition=entries[key],
                                manifest=manifest,
                            )
                            if key in entries
                            else {}
                        )
                    generations[dataset.id] = partition_values[key].get(dataset.node, "invalid")
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
