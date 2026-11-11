"""Published output references, scalar extraction and ephemeral computed-variable evidence.

Locating an output is independent of cardinality policy. Only the scalar extractor
requires exactly one row; neither source resolution nor inspection executes SQL.
"""

import copy

from . import variables
from .graph import output_ports, reachable
from .util import Problem, digest, qi
from .value_types import convert, resolve_column


def locate(bundle, nodes, boundaries, source):
    """Resolve a root output to its expanded producer, preserving the public source."""
    if not isinstance(source, dict) or source.keys() - {"node", "port", "column"}:
        raise Problem("Expected a source with node, optional port, and column")
    if any(not isinstance(source.get(k), str) or not source[k] for k in ("node", "column")):
        raise Problem("A value source needs a node ID and a column name")
    key = source["node"]
    roots = [n for n in bundle["flow"].get("nodes", []) if n.get("id") == key]
    if len(roots) != 1:
        raise Problem(f"Value source node {key} is missing or ambiguous in the root flow")
    ports = output_ports(nodes, boundaries, key)
    port = source.get("port")
    if "port" not in source:
        if len(ports) != 1:
            raise Problem(f"Value source {key} needs one explicit output port; found {len(ports)}")
        port = next(iter(ports))
    if not isinstance(port, str) or port not in ports:
        raise Problem(f"Value source {key} has no output {port!r}")
    producer, output = ports[port]
    return {"from": {**source, "port": port}, "node": producer, "port": output}


def sources(bundle, nodes, boundaries):
    declared, _ = variables.inspect_declarations(bundle)
    result = {}
    for name, variable in declared.items():
        if "from" not in variable:
            continue
        entry = {"type": variable["type"], "source": "node", "from": variable["from"]}
        try:
            if variable["errors"]:
                raise Problem("; ".join(variable["errors"].values()))
            entry.update(locate(bundle, nodes, boundaries, variable["from"]))
        except Problem as error:
            entry.update(code="invalid_value_source", error=f"{name}: {error}")
        result[name] = entry
    return result


def identity(source):
    return digest(
        {"from": source["from"], "type": source["type"], "producer": [source.get("node"), source.get("port")]}
    )


def unavailable(source, code, error):
    return {
        **{key: copy.deepcopy(source[key]) for key in ("type", "from")},
        "source": "node",
        "state": "unavailable",
        "code": code,
        "error": error,
    }


def retained(sources, cache):
    result = {}
    for name, source in sources.items():
        if "error" in source:
            result[name] = unavailable(source, source["code"], source["error"])
        elif identity(source) in cache:
            result[name] = {**copy.deepcopy(cache[identity(source)]), "resolution": "retained"}
        else:
            result[name] = unavailable(
                source, "value_not_calculated", f"{name}: value not calculated; run {source['from']['node']}"
            )
    return result


def dependencies(nodes, edges, sources):
    """Find forbidden value chains and report actual cycles on the expanded graph."""
    producers = {s["node"] for s in sources.values() if "node" in s}
    phase = reachable(producers, edges, upstream=True)
    adjacency = {key: [] for key in nodes}
    for edge in edges:
        adjacency[edge["source"]].append((edge["target"], []))
    uses = {}
    for key, node in nodes.items():
        names = set(variables.references(node.get("params")).values())
        names.update(name for names in variables.expression_references_of(node).values() for name in names)
        uses[key] = names & sources.keys()
        for name in uses[key]:
            if "node" in sources[name]:
                adjacency[sources[name]["node"]].append((key, [f"var.{name}"]))

    def path(start, target, visited):
        # One shared visited set keeps the search linear on graphs with many diamonds.
        if start == target:
            return [start]
        if start in visited:
            return None
        visited.add(start)
        for child, labels in adjacency[start]:
            tail = path(child, target, visited)
            if tail:
                return [start, *labels, *tail]
        return None

    errors = {}
    for key in phase:
        for name in sorted(uses[key]):
            producer = sources[name].get("node")
            chain = path(key, producer, set()) if producer else None
            code = "value_dependency_cycle" if chain else "value_chain"
            message = (
                " -> ".join([producer, f"var.{name}", *chain])
                if chain
                else f"{key} uses computed variable {name}; value nodes and their upstream may use ordinary variables only"
            )
            errors[key] = {"code": code, "error": message}
    return phase, errors


def problems(bundle, nodes, edges, boundaries, partition_phase=()):
    """Own scalar and partition value graph rules, emitting one diagnostic per node."""
    declared = sources(bundle, nodes, boundaries)
    result = [
        {"file": variables.FILE, "variable": name, "message": source["error"], "code": source["code"]}
        for name, source in declared.items()
        if "error" in source
    ]
    phase, invalid = dependencies(nodes, edges, declared)
    for key in set(partition_phase) | phase:
        node = nodes[key]
        used = set(variables.references(node.get("params")).values())
        used.update(n for names in variables.expression_references_of(node).values() for n in names)
        if node.get("partitioned") or (key in partition_phase and used & declared.keys()):
            invalid.setdefault(
                key,
                {
                    "code": "value_dependency_cycle"
                    if key in partition_phase and node.get("partitioned")
                    else "value_chain",
                    "error": f"{key}: value producers and their ancestors may use ordinary variables only",
                },
            )
    return result + [
        {"file": "flow.json", "node": key, "message": error["error"], "code": error["code"]}
        for key, error in sorted(invalid.items())
    ]


def extract(cursor, dataset, source):
    """Extract one cell from a complete published output, independently of other columns."""
    column = source["from"]["column"]
    try:
        matched = resolve_column(dataset.source_columns or dataset.columns, column)
    except Problem as error:
        return unavailable(source, "invalid_value_source", str(error))
    if dataset.count != 1:
        return unavailable(source, "value_cardinality", f"Expected exactly one row; found {dataset.count}")
    rows = cursor.execute(f"SELECT {qi(column)} FROM {qi(dataset.table)} LIMIT 2").fetchall()
    if len(rows) != 1:
        return unavailable(source, "value_cardinality", f"Expected exactly one row; found {len(rows)}")
    cell = rows[0][0]
    try:
        value = convert(source["type"], matched["type"], cell)
    except (Problem, ValueError, OverflowError) as error:
        return unavailable(source, "value_null" if cell is None else "value_type", str(error))
    return {
        "type": source["type"],
        "from": {**source["from"], "column": matched["name"]},
        "source": "node",
        "state": "ready",
        "value": value,
        "source_dataset": dataset.id,
    }
