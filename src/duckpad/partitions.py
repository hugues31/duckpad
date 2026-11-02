"""Declared partition scopes and typed, injection-safe compilation.

Definitions belong to the bundle. This module never reads a source while planning,
validating, or binding a graph; execution supplies the frozen manifest entry.
"""

import copy
import re

from . import value_sources, variables
from .graph import reachable
from .templates import base_type
from .types import Record
from .util import Problem, digest, qi, uid

REFERENCE = re.compile(r"\{\{\s*partition(?:\.([a-z][a-z0-9_]*))?\s*\}\}")
TYPES = {"text", "number", "date", "boolean"}
DEFAULT_EXECUTION = {"parallelism": 1, "on_error": "stop"}
DEFAULT_PREVIEW = {"keep": "last", "count": 1, "max_bytes": 1073741824}


def problem(code, message, node=None, **location):
    return {
        "file": "flow.json",
        "code": code,
        "message": message,
        **({"node": node} if node else {}),
        **location,
    }


def definition(flow):
    """Return the normalized single dimension, or an explicit definition error."""
    raw = flow.get("partitions", {})
    if not isinstance(raw, dict) or len(raw) > 1:
        raise Problem("Declare zero or one partition dimension")
    if not raw:
        return None
    name, value = next(iter(raw.items()))
    if not variables.NAME.fullmatch(name) or not isinstance(value, dict):
        raise Problem("A partition dimension needs a valid name and an object definition")
    if value.keys() - {"type", "description", "values", "attributes", "execution", "preview"}:
        raise Problem(f"{name}: unknown partition definition fields")
    if not isinstance(value.get("type"), str) or value["type"] not in TYPES:
        raise Problem(f"{name}: partition type must be text, number, date or boolean")
    if "description" in value and not isinstance(value["description"], str):
        raise Problem(f"{name}: description must be text")
    attributes = value.get("attributes", [])
    if (
        not isinstance(attributes, list)
        or any(not isinstance(a, str) or not variables.NAME.fullmatch(a) for a in attributes)
        or len(set(attributes)) != len(attributes)
    ):
        raise Problem(f"{name}: attributes must be distinct reference names")
    source = value.get("values")
    if not isinstance(source, dict):
        raise Problem(f"{name}: values needs a node, optional port, and column")
    if source.get("column") in attributes:
        raise Problem(f"{name}: attributes must differ from the key column")
    execution = value.get("execution", {})
    preview = value.get("preview", {})
    if not isinstance(execution, dict) or execution.keys() - DEFAULT_EXECUTION.keys():
        raise Problem(f"{name}: unknown execution settings")
    if not isinstance(preview, dict) or preview.keys() - DEFAULT_PREVIEW.keys():
        raise Problem(f"{name}: unknown preview settings")
    execution = {**DEFAULT_EXECUTION, **execution}
    if type(execution["parallelism"]) is not int or execution["parallelism"] < 1:
        raise Problem(f"{name}: parallelism must be a positive integer")
    if execution["on_error"] not in ("stop", "continue"):
        raise Problem(f"{name}: on_error must be stop or continue")
    keep = preview.get("keep", "last")
    if keep not in ("none", "last", "all") or (keep != "last" and "count" in preview):
        raise Problem(f"{name}: preview count is legal only with keep last")
    preview: Record = {**DEFAULT_PREVIEW, **preview}
    for field in ("count", "max_bytes"):
        if type(preview[field]) is not int or preview[field] < 1:
            raise Problem(f"{name}: preview {field} must be a positive integer")
    if keep != "last":
        preview.pop("count")
    return {
        **copy.deepcopy(value),
        "name": name,
        "attributes": attributes,
        "execution": execution,
        "preview": preview,
    }


def references(value):
    if isinstance(value, dict) and "$partition" in value:
        attribute = value["$partition"]
        if len(value) != 1 or not (
            attribute is True or (isinstance(attribute, str) and variables.NAME.fullmatch(attribute))
        ):
            raise Problem("Use {$partition: true} or {$partition: attribute}, without other fields")
        return ["" if attribute is True else attribute]
    return list(
        dict.fromkeys(a or "" for text in variables.parameter_texts(value) for a in REFERENCE.findall(text))
    )


def has_reference(value):
    """Recognize malformed bindings too, so invalid portable definitions are diagnosed."""
    return (isinstance(value, dict) and "$partition" in value) or any(
        REFERENCE.search(text) for text in variables.parameter_texts(value)
    )


def plan(bundle, nodes, edges, boundaries):
    """Annotate the real expanded dependencies, including component input barriers."""
    from .bundle import topological

    errors = []
    try:
        dimension = definition(bundle["flow"])
    except Problem as error:
        dimension = None
        errors.append(problem("partition_definition", str(error)))
    source = None
    if dimension:
        try:
            source = {
                "type": dimension["type"],
                **value_sources.locate(bundle, nodes, boundaries, dimension["values"]),
            }
        except Problem as error:
            errors.append(problem("invalid_value_source", str(error)))
    filters, collectors = {}, {}
    for root in bundle["flow"].get("nodes", []):
        key = root["id"]
        ports = boundaries.get(key, {}).get(
            "outputs", {p: (key, p) for p in nodes.get(key, {}).get("parsed", {}).get("outputs", [])}
        )
        declarations = root.get("outputs", {})
        if not isinstance(declarations, dict):
            errors.append(problem("partition_definition", "Output metadata must be an object", key))
            declarations = {}
        for port, metadata in declarations.items():
            if not isinstance(metadata, dict) or metadata.keys() != {"partition"}:
                errors.append(
                    problem(
                        "partition_definition",
                        "Output metadata needs a partition declaration",
                        key,
                        port=port,
                    )
                )
                continue
            declaration = metadata["partition"]
            if port not in ports:
                errors.append(problem("partition_column", f"Unknown output port {port}", key, port=port))
                continue
            producer, output = ports[port]
            previous = filters.setdefault(producer, {}).get(output)
            if previous is not None and previous != declaration:
                errors.append(
                    problem(
                        "partition_definition",
                        "Exposed aliases disagree on the output partition",
                        producer,
                        port=output,
                    )
                )
            filters[producer][output] = declaration
            if (
                not isinstance(declaration, dict)
                or declaration.keys() != {"by", "column"}
                or not isinstance(declaration.get("column"), str)
                or not declaration["column"]
            ):
                errors.append(
                    problem(
                        "partition_definition",
                        "An output partition needs by and column",
                        producer,
                        port=output,
                    )
                )
            elif not dimension or declaration["by"] != dimension["name"]:
                errors.append(
                    problem(
                        "partition_definition",
                        f"Unknown partition dimension {declaration['by']}",
                        producer,
                        port=output,
                    )
                )
        if "partitions" in root:
            if root["partitions"] != "all" or declarations:
                errors.append(
                    problem(
                        "partition_collect", "Collect all partitions cannot declare output partitions", key
                    )
                )
            inputs = boundaries.get(key, {}).get(
                "inputs", {p: (key, p) for p in nodes.get(key, {}).get("parsed", {}).get("inputs", [])}
            )
            collectors[key] = set(inputs.values())
    # Portable definitions must express boundaries on their root instance instead.
    for component, graph in bundle["components"].items():
        if any(
            node.get("outputs")
            or "partitions" in node
            or any(has_reference(v) for v in node.get("params", {}).values())
            for node in graph.get("nodes", [])
        ):
            affected = [k for k in nodes if component in variables.definition_chain(bundle, k)]
            errors.extend(
                problem(
                    "partition_definition",
                    f"Component {component}: expose partition boundaries and parameters on the root instance",
                    k,
                )
                for k in affected
            )
    collected = set().union(*collectors.values()) if collectors else set()
    for key in topological(nodes, edges, tolerant=True):
        incoming = [e for e in edges if e["target"] == key]
        inherited = [
            e["source"]
            for e in incoming
            if nodes[e["source"]].get("partitioned") and (key, e["targetHandle"]) not in collected
        ]
        node = nodes[key]
        if REFERENCE.search(node.get("template_sql", "")):
            errors.append(
                problem(
                    "partition_reference",
                    "SQL definitions cannot reference the current partition; expose a parameter on the root instance",
                    key,
                )
            )
        node["partitioned"] = bool(key in filters or inherited)
        node["partition_filters"] = filters.get(key, {})
        node["partition_collect_inputs"] = [
            e["targetHandle"]
            for e in incoming
            if (key, e["targetHandle"]) in collected and nodes[e["source"]].get("partitioned")
        ]
        if node["partitioned"]:
            node["partition_dimension"] = dimension["name"] if dimension else None
            node["partition_origin"] = key if key in filters else inherited[0]
        for param, value in node.get("params", {}).items():
            try:
                used = references(value)
                if not used:
                    continue
                if not node["partitioned"]:
                    raise Problem("Partition references require a partitioned data scope")
                if not dimension or any(a and a not in dimension["attributes"] for a in used):
                    raise Problem("Unknown partition attribute")
                parameter = next((p for p in node["parsed"]["parameters"] if p["name"] == param), {})
                kind = base_type(parameter.get("type", ""))
                if isinstance(value, dict):
                    if kind not in {"text", "number", "date", "boolean", "file", "destination", "choice"}:
                        raise Problem("Partition bindings require a compatible scalar or path parameter")
                    if used == [""] and not variables.compatible(dimension["type"], parameter["type"]):
                        raise Problem("Partition key type is incompatible with this parameter")
                elif kind not in variables.REFERENCE_PARAMETERS:
                    raise Problem("Partition references are legal only in expression and path parameters")
            except Problem as error:
                errors.append(problem("partition_reference", str(error), key, parameter=param))
    for root, inputs in collectors.items():
        if not any(
            nodes[e["source"]].get("partitioned") for e in edges if (e["target"], e["targetHandle"]) in inputs
        ):
            errors.append(
                problem("partition_collect", "Collect all partitions needs a partitioned input", root)
            )
    phase = reachable({source["node"]}, edges, upstream=True) if source else set()
    scalars = value_sources.sources(bundle, nodes, boundaries)
    scalar_phase, scalar_errors = value_sources.dependencies(nodes, edges, scalars)
    for key in phase | scalar_phase:
        node = nodes[key]
        uses = set(variables.references(node.get("params")).values())
        uses.update(n for names in variables.expression_references_of(node).values() for n in names)
        if node.get("partitioned") or (key in phase and uses & scalars.keys()):
            errors.append(
                problem(
                    "value_dependency_cycle" if key in phase and node.get("partitioned") else "value_chain",
                    f"{key}: value producers and their ancestors may use ordinary variables only",
                    key,
                )
            )
    errors.extend(problem(e["code"], e["error"], key) for key, e in scalar_errors.items())
    for error in errors:
        affected = (
            {k for k in nodes if k == error.get("node") or k.startswith(str(error.get("node")) + "::")}
            if error.get("node")
            else {k for k, n in nodes.items() if n.get("partitioned")}
        )
        if error.get("node") in phase:
            affected |= {k for k, n in nodes.items() if n.get("partitioned")}
        for key in affected:
            nodes[key].setdefault("error", error["message"])
            nodes[key]["partition_error"] = error["code"]
    return {"dimension": dimension, "source": source, "value_phase": phase, "errors": errors}


def bind(nodes, entry=None):
    """Reuse variable SQL/path rendering with collision-free internal reference names."""
    for node in nodes.values():
        if not node.get("partitioned"):
            continue
        if entry is None:
            node.setdefault("error", "Partition values not calculated; select a key from a resolved manifest")
            node.setdefault("partition_error", "partition_not_calculated")
        for param, value in list(node.get("params", {}).items()):
            try:
                used = references(value)
                if not used:
                    continue
                if entry is None:
                    raise Problem("Partition values not calculated; select a key from a resolved manifest")
                bindings = {}
                taken = set(variables.expression_values(node))
                for attribute in used:
                    evidence = entry["attributes"][attribute] if attribute else entry["key"]
                    name = "dp_partition_" + (attribute or "key")
                    while name in taken:
                        name += "_"
                    taken.add(name)
                    bindings[attribute] = {
                        **evidence,
                        "name": name,
                        "source": "node",
                        "partition": attribute or True,
                    }
                if isinstance(value, dict):
                    evidence = bindings[used[0]]
                    parameter = next(p for p in node["parsed"]["parameters"] if p["name"] == param)
                    if not variables.compatible(evidence["type"], parameter["type"]):
                        raise Problem("Partition value type is incompatible with this parameter")
                    node["params"][param] = evidence["value"]
                    node.setdefault("variables", {})[param] = evidence
                else:

                    def replace(text, bindings=bindings):
                        return REFERENCE.sub(
                            lambda m: "{{ var." + str(bindings[m[1] or ""]["name"]) + " }}", text
                        )

                    node["params"][param] = (
                        [replace(s) for s in value] if isinstance(value, list) else replace(value)
                    )
                    node.setdefault("references", {}).setdefault(param, []).extend(bindings.values())
            except (Problem, KeyError) as error:
                node.setdefault("error", str(error))
                node["partition_error"] = "partition_reference"


def filter_statements(statements, node, entry, cursor=None):
    """Apply output semantics before materialization; DuckDB can push eligible filters to scans."""
    for statement in statements:
        boundary = node.get("partition_filters", {}).get(statement.get("output"))
        if not boundary:
            continue
        if entry is None:
            raise Problem("Partition values not calculated; select a key from a resolved manifest")
        column = boundary["column"]
        key = entry["key"]
        target_type = {"text": "VARCHAR", "number": "DOUBLE", "date": "DATE", "boolean": "BOOLEAN"}[
            key["type"]
        ]
        if cursor is not None:
            schema = cursor.execute("DESCRIBE " + statement["query"], statement["bindings"]).fetchall()
            matches = [
                c
                for c in schema
                if c[0].translate(value_sources.IDENTIFIER_CASE)
                == column.translate(value_sources.IDENTIFIER_CASE)
            ]
            if len(matches) != 1:
                raise Problem(f"partition_column: {column} is missing or ambiguous")
            target_type = matches[0][1]
            # Compare the round-tripped binding, never cast the scanned column.
            converted = cursor.execute(
                f"SELECT CAST($key AS {target_type})", {"key": key["value"]}
            ).fetchone()[0]
            if canonical(key["type"], target_type, converted) != key["value"]:
                raise Problem(f"partition_column: {column} cannot losslessly compare this key")
        placeholder = "dp_partition_key"
        while (
            re.search(r"\$" + re.escape(placeholder) + r"\b", statement["query"])
            or placeholder in statement["bindings"]
        ):
            placeholder += "_"
        query = f"SELECT * FROM ({statement['query']}) AS dp_partition_source WHERE {qi(column)} = CAST(${placeholder} AS {target_type})"
        statement.update(
            query=query,
            sql=query,
            partition_filter={"column": column, "binding": placeholder, "key": copy.deepcopy(key)},
        )
        statement["bindings"][placeholder] = key["value"]
    return statements


def canonical(kind, sql_type, value):
    result = value_sources.convert(kind, sql_type, value)
    if kind == "number" and isinstance(result, int) and abs(result) > 2**53 - 1:
        raise Problem("Numeric partition keys must round-trip through the browser; cast this key to text")
    return result


def identity(key):
    value = key["value"]
    if key["type"] == "number" and float(value).is_integer():
        value = int(value)
    return digest({"type": key["type"], "value": value})


def scalar_type(sql_type):
    if sql_type == "VARCHAR":
        return "text"
    if sql_type == "DATE":
        return "date"
    if sql_type == "BOOLEAN":
        return "boolean"
    if (
        value_sources.INTEGER.fullmatch(sql_type)
        or sql_type in ("FLOAT", "DOUBLE", "REAL")
        or sql_type.startswith("DECIMAL(")
    ):
        return "number"
    raise Problem(f"partition_type: {sql_type} is not a supported scalar type; cast it explicitly")


def extract(cursor, dataset, dimension, source, run):
    """Read the complete ordered value output, validating even a zero-row schema."""
    requested = [source["from"]["column"], *dimension["attributes"]]
    columns = []
    for name in requested:
        matches = [
            c
            for c in (dataset.source_columns or dataset.columns)
            if c["name"].translate(value_sources.IDENTIFIER_CASE)
            == name.translate(value_sources.IDENTIFIER_CASE)
        ]
        if len(matches) != 1:
            raise Problem(f"invalid_value_source: column {name} is missing or ambiguous")
        column = matches[0]
        kind = scalar_type(column["type"])
        if not columns and kind != dimension["type"] and not (kind == "text" and dimension["type"] == "date"):
            raise Problem(
                f"partition_type: column {name} has type {column['type']}, expected {dimension['type']}"
            )
        columns.append({**column, "scalar_type": dimension["type"] if not columns else kind})
    if len({c["name"].translate(value_sources.IDENTIFIER_CASE) for c in columns}) != len(columns):
        raise Problem("partition_definition: attributes must be distinct from the key column")
    rows = cursor.execute(
        f"SELECT {', '.join(qi(c['name']) for c in columns)} FROM {qi(dataset.table)}"
    ).fetchall()
    entries, seen = [], {}
    for ordinal, row in enumerate(rows):
        evidence = []
        for column, cell in zip(columns, row, strict=True):
            try:
                value = canonical(column["scalar_type"], column["type"], cell)
            except (Problem, ValueError, OverflowError) as error:
                code = "partition_null" if cell is None else "partition_type"
                raise Problem(f"{code}: column {column['name']}, row {ordinal}: {error}") from error
            evidence.append(
                {
                    "type": column["scalar_type"],
                    "value": value,
                    "state": "ready",
                    "source": "node",
                    "from": {**source["from"], "column": column["name"]},
                    "resolution": "calculated",
                    "producer_run": run["id"],
                    "producer_commit": run["commit"],
                }
            )
        key_hash = identity(evidence[0])
        if key_hash in seen:
            raise Problem(
                f"partition_duplicate: column {columns[0]['name']}, rows {seen[key_hash]} and {ordinal}"
            )
        seen[key_hash] = ordinal
        entries.append(
            {
                "partition_id": uid("part_"),
                "ordinal": ordinal,
                "key_hash": key_hash,
                "key": evidence[0],
                "attributes": dict(zip(dimension["attributes"], evidence[1:], strict=True)),
            }
        )
    return entries, columns
