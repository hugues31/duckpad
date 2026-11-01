"""Dependency queries over the expanded nodes and edges of a flow, without executing anything."""

from __future__ import annotations

from collections.abc import Iterable

from .types import Record


def connection_references(node: Record) -> list[str]:
    """Return the connection IDs selected by a node's connection parameters.

    An empty connection parameter selects project files, which need no connection.
    """
    params = node.get("params", {})
    selected = [
        params.get(parameter["name"], parameter.get("default"))
        for parameter in node["parsed"]["parameters"]
        if parameter["type"] == "connection"
    ]
    return [reference for reference in selected if reference not in (None, "")]


def reachable(seeds: Iterable[str], edges: list[Record], upstream: bool) -> set[str]:
    """Return the seeds and every node reachable against (upstream) or along the edges."""
    origin, destination = ("target", "source") if upstream else ("source", "target")
    result = set(seeds)
    while True:
        extended = result | {edge[destination] for edge in edges if edge[origin] in result}
        if extended == result:
            return result
        result = extended
