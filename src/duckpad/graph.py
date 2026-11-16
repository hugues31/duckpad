"""Dependency queries over the expanded nodes and edges of a flow, without executing anything."""

from __future__ import annotations

from collections.abc import Iterable

from .types import Record
from .util import Problem


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


def output_ports(
    nodes: dict[str, Record], boundaries: dict[str, Record], node: str
) -> dict[str, tuple[str, str]]:
    """A node's output ports as {port: (producer, producer_port)}, through component instance boundaries."""
    if node in boundaries:
        return boundaries[node]["outputs"]
    return {port: (node, port) for port in nodes.get(node, {}).get("parsed", {}).get("outputs", [])}


def reachable(seeds: Iterable[str], edges: list[Record], upstream: bool) -> set[str]:
    """Return the seeds and every node reachable against (upstream) or along the edges."""
    origin, destination = ("target", "source") if upstream else ("source", "target")
    result = set(seeds)
    while True:
        extended = result | {edge[destination] for edge in edges if edge[origin] in result}
        if extended == result:
            return result
        result = extended


def topological(nodes, edges, tolerant=False):
    """Order nodes in waves, each in node order, in time linear in the nodes and edges.

    An edge from a missing source never resolves, like a cycle.
    """
    position = {key: index for index, key in enumerate(nodes)}
    waiting: dict[str, set[str]] = {key: set() for key in position}
    dependents: dict[str, set[str]] = {}
    for edge in edges:
        if edge["target"] in waiting:
            waiting[edge["target"]].add(edge["source"])
            dependents.setdefault(edge["source"], set()).add(edge["target"])
    ordered: list[str] = []
    ready = [key for key, sources in waiting.items() if not sources]
    while ready:
        ordered.extend(ready)
        released = set()
        for key in ready:
            for target in dependents.get(key, ()):
                waiting[target].discard(key)
                if not waiting[target]:
                    released.add(target)
        ready = sorted(released, key=position.__getitem__)
    if len(ordered) < len(position):
        if not tolerant:
            raise Problem("The graph contains a cycle")
        done = set(ordered)
        remaining = [key for key in position if key not in done]
        for key in remaining:
            nodes[key]["error"] = "This node is part of, or depends on, a graph cycle"
        ordered.extend(remaining)
    return ordered
