"""Results a run keeps instead of computing them again, and those it makes stale."""

from __future__ import annotations

from ..datasets import Context, Dataset
from ..graph import reachable
from ..types import Record
from .contexts import cancel_lineage
from .exports import Exports


def kept_results(
    context: Context,
    nodes: dict[str, Record],
    edges: list[Record],
    order: list[str],
    fingerprints: dict[str, str],
    forced: set[str],
) -> dict[str, dict[str, Dataset]]:
    """The results a run keeps instead of computing them again, by node.

    A node keeps its result when it was computed from the same definitions and from the kept
    results of all its inputs. Requested nodes always run, as do nodes without a result: those
    that write outside Duckpad, whose destination cannot be compared.

    A partitioned node has one result per key, which its run compares once it knows the keys:
    here it only stands for results that may be kept, without any.
    """
    inputs: dict[str, list[Record]] = {key: [] for key in order}
    for edge in edges:
        if edge["target"] in inputs:
            inputs[edge["target"]].append(edge)
    kept: dict[str, dict[str, Dataset]] = {}
    with context.lock:
        for key in order:
            node, outputs = nodes[key], context.outputs.get(key, {})
            if key in forced or any(edge["source"] not in kept for edge in inputs[key]):
                continue
            if node.get("partitioned"):
                # Its definition, and any error in it, is resolved for each key.
                kept[key] = {}
                continue
            if node.get("error") or not outputs or set(outputs) != set(node["parsed"]["outputs"]):
                continue
            read = {parent for data in outputs.values() for parent in data.dependencies.values()}
            if all(
                data.status == "valid"
                and data.fingerprint == fingerprints[key]
                and not data.partition
                and not data.incomplete
                for data in outputs.values()
            ) and all(
                kept[edge["source"]][edge["sourceHandle"]].id in read
                for edge in inputs[key]
                # The keys a node collects are compared by its fingerprint and by their run.
                if not nodes[edge["source"]].get("partitioned")
            ):
                kept[key] = dict(outputs)
    return kept


def invalidate_results(
    exports: Exports, context: Context, edges: list[Record], computed: set[str], scope: set[str]
) -> None:
    """Mark stale the results of the nodes a run computes again and of everything downstream."""
    affected = reachable(computed, edges, upstream=False)
    exports.mark_stale(context.worktree, context.environment, affected - scope)
    with context.lock:
        cancel_lineage(context, affected)
        for dataset in context.datasets.values():
            if dataset.node in affected:
                dataset.status = "stale"
                dataset.value_stale = False


def kept_state(outputs: dict[str, Dataset]) -> Record:
    """What a run records for a node whose result it kept: the result and the run it comes from."""
    first = next(iter(outputs.values()))
    return {
        "status": "success",
        "kept": {"run": first.run, "created": first.created},
        "outputs": {port: data.public() for port, data in outputs.items()},
    }
