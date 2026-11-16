"""Server-side Python parameter validation using the common parameter descriptors."""

import math

from .json_read import loads
from .python_contract import APPEARANCE
from .templates import check_scalar, connection_for, render_parameter
from .util import Problem, dumps
from .value_types import base_type, type_argument


def port_error(node, contract, edges):
    missing = []
    for edge in edges:
        for end, direction in (("source", "outputs"), ("target", "inputs")):
            port = edge[end + "Handle"]
            if edge[end] == node["id"] and port not in contract.get(direction, []):
                missing.append(f"{direction[:-1]} {port}")
    if not missing:
        return None
    ports = ", ".join(dict.fromkeys(missing))
    return (
        f"Python ports changed: connected {ports} no longer declared; restore them or reconnect their edges"
    )


def retained_contract(node, parsed, edges):
    """Keep wired ports visible alongside newly declared ports until the user reconnects them."""
    error = parsed.get("error") or port_error(node, parsed, edges)
    if not error or not node.get("python_contract"):
        return parsed
    previous = node["python_contract"]
    if "error" not in parsed:
        # Code that parses says how the node looks: an icon or a color it no longer declares is gone.
        previous = {key: value for key, value in previous.items() if key not in APPEARANCE}
    return {
        **previous,
        **parsed,
        **{
            key: list(dict.fromkeys([*previous.get(key, []), *parsed.get(key, [])]))
            for key in ("inputs", "outputs")
        },
        "error": error,
    }


def remember_contracts(files):
    """Persist the last usable signature without changing edges or parameter values."""
    from .node_code import code_path
    from .python_contract import parse_python

    result = dict(files)
    for name, source in files.items():
        if name != "flow.json" and not (name.startswith("components/") and name.endswith(".json")):
            continue
        try:
            graph = loads(source)
            parent = name.removeprefix("components/").removesuffix(".json") if name != "flow.json" else None
            for node in graph.get("nodes", []):
                if node.get("language") != "python":
                    continue
                code = files.get(
                    "templates/" + node["template"]
                    if node.get("template")
                    else code_path(node["id"], parent, "python"),
                    "",
                )
                try:
                    contract = parse_python(code)
                except Problem:
                    continue
                if not port_error(node, contract, graph.get("edges", [])):
                    node["python_contract"] = contract
            if loads(source) != graph:
                result[name] = dumps(graph)
        except (ValueError, TypeError, KeyError):
            continue
    return result


def parameters(node, schemas, captured, project_files, variables=None, bindings=None):
    result = {p["name"]: p["default"] for p in node["parsed"]["parameters"] if "default" in p}
    result.update(node.get("params", {}))
    names = {p["name"] for p in node["parsed"]["parameters"]}
    if set(result) - names:
        raise Problem("Python parameter configuration is stale; remove undeclared values before running", 422)
    for parameter in node["parsed"]["parameters"]:
        name = parameter["name"]
        if name not in result:
            raise Problem(f"Missing Python parameter: {name}", 422)
        value = result[name]
        kind, argument = base_type(parameter["type"]), type_argument(parameter["type"])
        if kind not in ("number", "boolean") and not isinstance(value, str):
            raise Problem(f"Parameter {name} requires text", 422)
        if parameter["python_type"] == "int" and type(value) is not int:
            raise Problem(f"Parameter {name} requires an integer", 422)
        if kind == "number" and (type(value) not in (int, float) or not math.isfinite(value)):
            raise Problem(f"Parameter {name} requires a finite number", 422)
        check_scalar(name, kind, argument, value)
        for bound, compare in (
            ("ge", lambda a, b: a >= b),
            ("gt", lambda a, b: a > b),
            ("le", lambda a, b: a <= b),
            ("lt", lambda a, b: a < b),
        ):
            if bound in parameter and not compare(value, parameter[bound]):
                raise Problem(f"Parameter {name} must satisfy {bound}={parameter[bound]}", 422)
        if parameter["python_type"] == "float":
            result[name] = float(value)
        if kind == "column" and value not in {c["name"] for c in schemas.get(argument, [])}:
            raise Problem(f"Unknown column {value!r} on input {argument}", 422)
        if kind == "connection":
            if value:
                connection_for(captured, value)
            continue
        rendered = render_parameter(
            node["parsed"], parameter, result, captured, project_files, schemas, variables, bound=bindings
        )
        if kind in ("file", "destination"):
            result[name] = rendered[1:-1].replace("''", "'")
    return result
