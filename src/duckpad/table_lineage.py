"""Table dependencies from saved definitions, including computed variables, without a run."""

from . import value_sources, variables
from .components import expand
from .graph import reachable
from .util import Problem


def describe(bundle, node, port=None, direction="origin", environment="dev"):
    if bundle is None:
        raise Problem("Project files are invalid", 422)
    nodes, edges, boundaries = expand(bundle, tolerant=True)
    if node not in nodes and node not in boundaries:
        raise Problem("Node not found", 404)
    declared, _ = variables.inspect_declarations(bundle)
    sources = value_sources.sources(bundle, nodes, boundaries)
    used = {}
    for key, item in nodes.items():
        names = variables.names_used(item)
        used[key] = [{"name": name, "node": sources.get(name, {}).get("node")} for name in sorted(names)]
        edges.extend(
            {"source": sources[name]["node"], "target": key, "variable": name}
            for name in sorted(names)
            if sources.get(name, {}).get("node")
        )
    if node in nodes:
        seeds = [node]
    else:
        # A component starts from the inner nodes producing its outputs, in both directions.
        outputs = boundaries[node]["outputs"]
        if port and port not in outputs:
            raise Problem("Output not found", 404)
        seeds = list(dict.fromkeys(value[0] for name, value in outputs.items() if not port or name == port))
    selected = reachable(seeds, edges, upstream=direction == "origin")
    result = {}
    for key, item in nodes.items():
        if key not in selected:
            continue
        parsed = item["parsed"]
        params = item.get("params", {})
        resource = {}
        # Never return credentials or the contents of connections.
        for parameter in parsed["parameters"]:
            name = parameter["name"]
            if (
                name in {"file", "path", "table", "filename", "destination"}
                or parameter["type"] == "connection"
            ):
                value = params.get(name, parameter.get("default"))
                reference = variables.reference(value)
                if reference in declared:
                    resolved = variables.resolve(declared[reference], environment)
                    value = resolved.get("value", value)
                resource[name] = value
        result[key] = {
            "id": key,
            "source": not parsed["inputs"] and not parsed.get("writes_external"),
            "export": bool(parsed.get("writes_external")),
            "resource": resource,
            "variables": used[key],
            "error": item.get("error"),
        }
    return {
        "node": node,
        "seeds": seeds,
        "nodes": result,
        "edges": [e for e in edges if e["source"] in selected and e["target"] in selected],
    }
