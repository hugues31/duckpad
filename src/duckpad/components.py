"""Project-owned reusable subgraphs with stable boundary ports."""

import copy

from . import variables
from .templates import IDENTIFIER, directives, parse_template
from .util import Problem, uid

DOCUMENTATION_SECTIONS = ("nodes", "datasets", "columns")


def in_subtree(key, root):
    """Whether an expanded node key is the root node or nested inside that component instance."""
    return key == root or key.startswith(root + "::")


def expand_for(bundle, environment, tolerant=True):
    """Expand a bundle with variable references bound to their values in an environment."""
    nodes, edges, boundaries = expand(bundle, tolerant=tolerant)
    variables.bind(bundle, nodes, environment)
    return nodes, edges, boundaries


def expand(bundle, tolerant=False):
    nodes, edges, boundaries = {}, [], {}

    def add_leaf(node, key, template, text, local_ports, error=None):
        nodes[key] = {
            **copy.deepcopy(node),
            "id": key,
            "root": key.split("::")[0],
            "parsed": template,
            "template_sql": text,
            **({"error": error} if error else {}),
        }
        local_ports[node["id"]] = {
            direction: {port: (key, port) for port in template[direction]}
            for direction in ("inputs", "outputs")
        }

    def visit(graph, prefix="", stack=()):
        local_ports = {}
        for node in graph.get("nodes", []):
            key = prefix + node["id"]
            try:
                if node.get("component"):
                    definition_id = node["component"]
                    if definition_id in stack:
                        raise Problem("Recursive component reference: " + " → ".join((*stack, definition_id)))
                    if definition_id not in bundle["components"]:
                        raise Problem(f"Missing component: {definition_id}")
                    definition = copy.deepcopy(bundle["components"][definition_id])
                    for name, parameter in definition.get("parameters", {}).items():
                        value = node.get("params", {}).get(name, parameter.get("default"))
                        for target in parameter.get("targets", []):
                            target_node = next(
                                (n for n in definition["nodes"] if n["id"] == target["node"]), None
                            )
                            if not target_node:
                                raise Problem(f"Invalid exposed parameter target: {name}")
                            target_node.setdefault("params", {})[target["param"]] = value
                    inner = visit(definition, key + "::", (*stack, definition_id))
                    ports = {"inputs": {}, "outputs": {}}
                    for direction in ("inputs", "outputs"):
                        for name, target in definition.get(direction, {}).items():
                            try:
                                ports[direction][name] = inner[target["node"]][direction][target["port"]]
                            except KeyError as error:
                                raise Problem(
                                    f"Invalid component {definition_id} {direction} port: {name}"
                                ) from error
                    local_ports[node["id"]] = ports
                    boundaries[key] = ports
                else:
                    if node.get("template") not in bundle["templates"]:
                        raise Problem(f"Missing template: {node.get('template')}")
                    text = bundle["templates"][node["template"]]
                    add_leaf(node, key, parse_template(text), text, local_ports)
            except (Problem, KeyError, TypeError) as error:
                if not tolerant:
                    raise
                for old in list(nodes):
                    if in_subtree(old, key):
                        del nodes[old]
                edges[:] = [
                    e
                    for e in edges
                    if not (e["source"].startswith(key + "::") or e["target"].startswith(key + "::"))
                ]
                text = bundle["templates"].get(node.get("template"), "")
                declared = directives(text)
                inputs = {port for kind, port in declared if kind == "input" and IDENTIFIER.fullmatch(port)}
                outputs = {port for kind, port in declared if kind == "output" and IDENTIFIER.fullmatch(port)}
                inputs.update(e["targetHandle"] for e in graph.get("edges", []) if e["target"] == node["id"])
                outputs.update(e["sourceHandle"] for e in graph.get("edges", []) if e["source"] == node["id"])
                for direction, ports in (("inputs", inputs), ("outputs", outputs)):
                    ports.update(
                        p["port"] for p in graph.get(direction, {}).values() if p["node"] == node["id"]
                    )
                # Keep the node and its known ports so its error is shown in place.
                template = {
                    "kind": "transform",
                    "inputs": sorted(inputs),
                    "outputs": sorted(outputs),
                    "parameters": [],
                }
                add_leaf(node, key, template, text, local_ports, str(error))
        for edge in graph.get("edges", []):
            try:
                source, output = local_ports[edge["source"]]["outputs"][edge["sourceHandle"]]
                target, input_name = local_ports[edge["target"]]["inputs"][edge["targetHandle"]]
            except KeyError as error:
                message = f"Invalid edge or incompatible interface: {edge.get('id', 'unknown')}"
                if not tolerant:
                    raise Problem(message) from error
                target_key = prefix + edge["target"]
                for key, node in nodes.items():
                    if in_subtree(key, target_key):
                        node["error"] = message
                continue
            edges.append(
                {
                    "id": prefix + edge["id"],
                    "source": source,
                    "sourceHandle": output,
                    "target": target,
                    "targetHandle": input_name,
                }
            )
        return local_ports

    visit(bundle["flow"])
    if tolerant:
        occupied = set()
        for edge in edges:
            port = (edge["target"], edge["targetHandle"])
            if port in occupied:
                nodes[edge["target"]]["error"] = f"Input {port} has more than one source"
            occupied.add(port)
        for key, node in nodes.items():
            for port in node["parsed"]["inputs"]:
                if (key, port) not in occupied:
                    node["error"] = f"Connect input {port} on {node.get('label', key)}"
    return nodes, edges, boundaries


def group(bundle, selection, label, exposed=None, parent=None):
    bundle = copy.deepcopy(bundle)
    if parent and parent not in bundle["components"]:
        raise Problem(f"Missing component: {parent}", 404)
    graph = bundle["components"][parent] if parent else bundle["flow"]
    selected = set(selection)
    internal = [n for n in graph["nodes"] if n["id"] in selected]
    if not internal:
        raise Problem("Select at least one node")
    component_id, instance_id = uid("component_"), uid("node_")
    definition = {
        "id": component_id,
        "name": label,
        "description": "",
        "nodes": internal,
        "edges": [],
        "inputs": {},
        "outputs": {},
        "parameters": exposed or {},
    }
    prefixes = component_paths(bundle).get(parent, []) if parent else [""]
    for section in DOCUMENTATION_SECTIONS:
        values = bundle.get("documentation", {}).get(section, {})
        for prefix in prefixes:
            for key in list(values):
                local = key[len(prefix) :] if key.startswith(prefix) else ""
                if any(local == node or local.startswith(node + ":") for node in selected):
                    value = values.pop(key)
                    values[prefix + instance_id + "::" + local] = value
                    definition.setdefault("documentation", {}).setdefault(section, {})[local] = copy.deepcopy(
                        value
                    )
    outer = []
    outgoing_ports, incoming_ports = {}, {}
    for edge in graph["edges"]:
        a, b = edge["source"] in selected, edge["target"] in selected
        if a and b:
            definition["edges"].append(edge)
        elif b:
            key = (edge["target"], edge["targetHandle"])
            port = incoming_ports.setdefault(key, f"input_{len(incoming_ports) + 1}")
            definition["inputs"][port] = {"node": key[0], "port": key[1]}
            outer.append({**edge, "target": instance_id, "targetHandle": port})
        elif a:
            key = (edge["source"], edge["sourceHandle"])
            port = outgoing_ports.setdefault(key, f"output_{len(outgoing_ports) + 1}")
            definition["outputs"][port] = {"node": key[0], "port": key[1]}
            outer.append({**edge, "source": instance_id, "sourceHandle": port})
        else:
            outer.append(edge)
    # Preserve the containing component's boundary and exposed parameters.
    for direction, lookup in (("inputs", incoming_ports), ("outputs", outgoing_ports)):
        for name, target in graph.get(direction, {}).items():
            if target["node"] in selected:
                key = (target["node"], target["port"])
                port = lookup.setdefault(key, f"{direction[:-1]}_{len(lookup) + 1}")
                definition[direction][port] = dict(target)
                graph[direction][name] = {"node": instance_id, "port": port}
    for name, parameter in graph.get("parameters", {}).items():
        targets = []
        for target in parameter.get("targets", []):
            if target["node"] in selected:
                exposed_name = f"{name}_{len(definition['parameters']) + 1}"
                definition["parameters"][exposed_name] = {**copy.deepcopy(parameter), "targets": [target]}
                targets.append({"node": instance_id, "param": exposed_name})
            else:
                targets.append(target)
        parameter["targets"] = targets
    instance_params = expose_variables(bundle, internal, definition["parameters"])
    # Expose unconnected terminal outputs too, so a grouped result is inspectable.
    for node in internal:
        outputs = (
            bundle["components"][node["component"]].get("outputs", {})
            if node.get("component")
            else parse_template(bundle["templates"][node["template"]])["outputs"]
        )
        for output in outputs:
            key = (node["id"], output)
            if key not in outgoing_ports and not any(
                e["source"] == key[0] and e["sourceHandle"] == key[1] for e in definition["edges"]
            ):
                port = f"output_{len(definition['outputs']) + 1}"
                definition["outputs"][port] = {"node": key[0], "port": key[1]}
    bundle["components"][component_id] = definition
    graph["nodes"] = [n for n in graph["nodes"] if n["id"] not in selected] + [
        {
            "id": instance_id,
            "component": component_id,
            "label": label,
            "params": instance_params,
            "position": internal[0].get("position", {"x": 100, "y": 100}),
        }
    ]
    graph["edges"] = outer
    expand(bundle)
    return bundle, instance_id


def expose_variables(bundle, internal, exposed):
    """Move variable bindings and references of grouped nodes to exposed parameters of the new instance.

    Definitions never reference variables, so each bound parameter, and each expression that
    references variables, becomes an exposed parameter, or reuses one already targeting it. The
    instance binds it to the same variable or holds the same expression.
    """
    instance_params = {}
    for node in internal:
        params = node.get("params")
        using = variables.references(params).keys() | variables.referenced(params).keys()
        for param in [param for param in (params or {}) if param in using]:
            target = {"node": node["id"], "param": param}
            key = next(
                (k for k, p in exposed.items() if isinstance(p, dict) and target in p.get("targets", [])),
                None,
            )
            if key is None:
                key = param
                suffix = 2
                while key in exposed:
                    key, suffix = f"{param}_{suffix}", suffix + 1
                exposed[key] = {"targets": [target]}
                parameter_type = parameter_types(bundle, node).get(param)
                if parameter_type:
                    exposed[key]["type"] = parameter_type
            instance_params[key] = node["params"].pop(param)
    return instance_params


def parameter_types(bundle, node):
    """Parameter name -> declared type of a template node or component instance."""
    if node.get("component"):
        parameters = bundle["components"].get(node["component"], {}).get("parameters", {})
        return {name: p["type"] for name, p in parameters.items() if isinstance(p, dict) and p.get("type")}
    try:
        return {
            p["name"]: p["type"] for p in parse_template(bundle["templates"][node["template"]])["parameters"]
        }
    except (Problem, KeyError):
        return {}


def import_definition(destination, source, kind, identity, origin):
    result = copy.deepcopy(destination)
    remap = {}

    def transfer(category, key):
        if (category, key) in remap:
            return remap[(category, key)]
        if key not in source[category]:
            raise Problem(f"Missing imported definition: {key}")
        new_id = uid("template_" if category == "templates" else "component_")
        remap[(category, key)] = new_id
        value = copy.deepcopy(source[category][key])
        if category == "components":
            value.update(id=new_id, origin=origin)
            prefixes = component_paths(source).get(key, [])
            if prefixes:
                prefix = prefixes[0]
                for section in DOCUMENTATION_SECTIONS:
                    for path, text in source.get("documentation", {}).get(section, {}).items():
                        if path.startswith(prefix):
                            value.setdefault("documentation", {}).setdefault(section, {})[
                                path[len(prefix) :]
                            ] = copy.deepcopy(text)
            for node in value["nodes"]:
                field = "component" if node.get("component") else "template"
                node[field] = transfer("components" if field == "component" else "templates", node[field])
        result[category][new_id] = value
        return new_id

    imported = transfer(kind, identity)
    return result, imported


def component_paths(bundle):
    """Return every instance path without requiring valid SQL or input wiring."""
    result = {}

    def visit(graph, prefix="", stack=()):
        for node in graph.get("nodes", []):
            identity = node.get("component")
            if identity and identity in bundle["components"] and identity not in stack:
                path = prefix + node["id"] + "::"
                result.setdefault(identity, []).append(path)
                visit(bundle["components"][identity], path, (*stack, identity))

    visit(bundle["flow"])
    return result


def reconcile_documentation(previous, current):
    """Copy imported documentation and prune explicitly deleted owning nodes."""
    documentation = current.setdefault("documentation", {})
    paths = component_paths(current)
    for identity, prefixes in paths.items():
        defaults = current["components"][identity].get("documentation", {})
        for section in DOCUMENTATION_SECTIONS:
            for key, value in defaults.get(section, {}).items():
                for prefix in prefixes:
                    documentation.setdefault(section, {}).setdefault(prefix + key, copy.deepcopy(value))
    if not previous:
        return
    old_paths = component_paths(previous)
    pairs = [(previous["flow"], current["flow"], [""])]
    pairs.extend(
        (old, current["components"][key], old_paths.get(key, []))
        for key, old in previous["components"].items()
        if key in current["components"]
    )
    for before, after, prefixes in pairs:
        removed = {n["id"] for n in before.get("nodes", [])} - {n["id"] for n in after.get("nodes", [])}
        owners = [prefix + node for prefix in prefixes for node in removed]
        for section in DOCUMENTATION_SECTIONS:
            values = documentation.get(section, {})
            for key in list(values):
                if any(key == owner or key.startswith(owner + ":") for owner in owners):
                    del values[key]
