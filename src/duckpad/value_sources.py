"""Published output references, scalar extraction and ephemeral computed-variable evidence.

Locating an output is independent of cardinality policy. Only the scalar extractor
requires exactly one row; neither source resolution nor inspection executes SQL.
"""

import copy
import datetime
import json
import math
import re
from decimal import Decimal

from . import variables
from .graph import reachable
from .templates import base_type
from .util import Problem, digest, qi

INTEGER = re.compile(r"U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)")


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
    ports = boundaries.get(key, {}).get("outputs")
    if ports is None:
        ports = {port: (key, port) for port in nodes.get(key, {}).get("parsed", {}).get("outputs", [])}
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
    declared, _ = variables.declarations(bundle)
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
        if start == target:
            return [start]
        if start in visited:
            return None
        for child, labels in adjacency[start]:
            tail = path(child, target, visited | {start})
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


def convert(type_name, duck_type, value):
    """Convert by the SQL column type, never infer it from the worker's JSON value."""
    if value is None:
        raise Problem("NULL is not a variable value")
    kind = base_type(type_name)
    sql_type = duck_type.upper()
    if kind == "list":
        match = re.fullmatch(r"(.+)\[\d*\]", sql_type)
        if not match or not isinstance(value, (list, tuple)):
            raise Problem(f"Expected {type_name}, got {duck_type}")
        return [convert("text" if type_name == "list<text>" else "number", match[1], v) for v in value]
    valid = False
    if kind in ("text", "choice", "identifier"):
        valid = sql_type == "VARCHAR" and isinstance(value, str)
    elif kind == "boolean":
        valid = sql_type == "BOOLEAN" and isinstance(value, bool)
    elif kind == "date":
        valid = sql_type in ("DATE", "VARCHAR")
        if isinstance(value, datetime.date) and not isinstance(value, datetime.datetime):
            value = value.isoformat()
    elif kind == "number":
        if INTEGER.fullmatch(sql_type):
            valid = isinstance(value, int) and not isinstance(value, bool)
        elif sql_type in ("FLOAT", "DOUBLE"):
            valid = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        elif re.fullmatch(r"DECIMAL\(\d+,\s*\d+\)", sql_type):
            decimal = Decimal(str(value))
            if decimal.is_finite():
                value = int(decimal) if decimal == decimal.to_integral_value() else float(decimal)
                valid = math.isfinite(value) and Decimal(json.dumps(value)) == decimal
    error = variables.check_value(type_name, value) if valid else f"expected {type_name}, got {duck_type}"
    if error:
        raise Problem(error + "; use an explicit lossless cast in the producer")
    return value


def extract(cursor, dataset, source):
    """Extract one cell from a complete published output, independently of other columns."""
    column = source["from"]["column"]
    matches = [c for c in (dataset.source_columns or dataset.columns) if c["name"] == column]
    if len(matches) != 1:
        return unavailable(source, "invalid_value_source", f"Column {column} is missing or ambiguous")
    if dataset.count != 1:
        return unavailable(source, "value_cardinality", f"Expected exactly one row; found {dataset.count}")
    rows = cursor.execute(f"SELECT {qi(column)} FROM {qi(dataset.table)} LIMIT 2").fetchall()
    if len(rows) != 1:
        return unavailable(source, "value_cardinality", f"Expected exactly one row; found {len(rows)}")
    cell = rows[0][0]
    try:
        value = convert(source["type"], matches[0]["type"], cell)
    except (Problem, ValueError, OverflowError) as error:
        return unavailable(source, "value_null" if cell is None else "value_type", str(error))
    return {
        "type": source["type"],
        "from": copy.deepcopy(source["from"]),
        "source": "node",
        "state": "ready",
        "value": value,
        "source_dataset": dataset.id,
    }
