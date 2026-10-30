"""Computation fingerprints, which change only when a node's result could change."""

from __future__ import annotations

import logging

from ..bundle import topological
from ..catalog import Catalog
from ..components import expand_for
from ..graph import connection_references
from ..projects import Projects
from ..templates import executable_sql
from ..types import Connections, Record
from ..util import Problem, digest

logger = logging.getLogger(__name__)


class Fingerprints:
    def __init__(self, projects: Projects, catalog: Catalog) -> None:
        self.projects, self.catalog = projects, catalog

    def of(self, bundle: Record, environment: str, captured: Connections | None = None) -> dict[str, str]:
        """Fingerprint every node of a bundle from its SQL, parameters, connections and inputs."""
        # Resolved values make renames, descriptions and promoted literals transparent.
        nodes, edges, _ = expand_for(bundle, environment)
        fingerprints: dict[str, str] = {}
        for key in topological(nodes, edges, tolerant=True):
            node = nodes[key]
            # An omitted parameter and an explicit value equal to its default compute
            # the same result, including when that value comes from a variable.
            params = {
                parameter["name"]: parameter["default"]
                for parameter in node["parsed"]["parameters"]
                if "default" in parameter
            }
            params.update(node.get("params", {}))
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
                    "inputs": [
                        (
                            e["targetHandle"],
                            e["source"],
                            e["sourceHandle"],
                            fingerprints.get(e["source"], "invalid"),
                        )
                        for e in edges
                        if e["target"] == key
                    ],
                }
            )
        return fingerprints

    def current(self, worktree: str, environment: str) -> dict[str, str]:
        """Fingerprints of the committed files, or none when they cannot be expanded."""
        snapshot = self.projects.snapshot(worktree, committed=True)
        if snapshot["bundle"] is None:
            return {}
        try:
            return self.of(snapshot["bundle"], environment)
        except Exception:
            # Unreadable definitions invalidate every result rather than blocking the caller.
            logger.warning("Cannot fingerprint worktree %s", worktree, exc_info=True)
            return {}
