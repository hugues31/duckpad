"""Project validation orchestration: structure, expansion, partitions, variables and views."""

import tomllib

from . import partitions, project_extensions, variables, views
from .components import expand
from .graph import topological
from .node_code import node_sql, template_path
from .node_names import node_name
from .project_schema import problems as structure_problems
from .templates import parse_template
from .util import Problem


def validate(bundle):
    structural = structure_problems(bundle)
    if not isinstance(bundle, dict):
        return structural
    errors = []
    if isinstance(bundle.get("pyproject"), str):
        try:
            tomllib.loads(bundle["pyproject"])
        except ValueError as error:
            errors.append({"file": "pyproject.toml", "message": str(error)})
    helpers = bundle.get("python_helpers", {})
    for name in helpers if isinstance(helpers, dict) else ():
        if not isinstance(name, str):
            continue
        parts = name.removesuffix(".py").split("/")
        if parts[0] == "duckpad":
            message = "A helper module named duckpad would replace the Duckpad SDK; rename it"
        elif not all(part.isidentifier() for part in parts):
            message = "Helper module paths must be Python identifiers to be importable"
        else:
            continue
        errors.append({"file": "modules/" + name, "message": message})
    errors.extend(structural)
    if structural:
        return errors
    graphs = [
        ("flow.json", bundle["flow"], None),
        *[(f"components/{key}.json", value, key) for key, value in bundle["components"].items()],
    ]
    for file, graph, parent in graphs:
        try:
            for definition in graph.get("parameters", {}).values():
                for target in definition.get("targets", []):
                    node = next((n for n in graph.get("nodes", []) if n["id"] == target["node"]), None)
                    if node is None:
                        raise Problem("Exposed parameter target is missing")
                    if node.get("component"):
                        component = bundle["components"].get(node["component"])
                        if component is None:
                            raise Problem(f"Missing component: {node['component']}")
                        parameters = component.get("parameters", {})
                    else:
                        parameters = {
                            p["name"]: p
                            for p in parse_template(
                                node_sql(bundle, node, parent), node.get("language", "sql")
                            )["parameters"]
                        }
                    if target["param"] not in parameters:
                        raise Problem("Exposed parameter does not exist on its target")
            if parent is not None:
                nodes, edges, _ = expand(
                    {**bundle, "flow": {"nodes": [{"id": "instance", "component": parent}], "edges": []}}
                )
                topological(nodes, edges)
        except Problem as error:
            errors.append({"file": file, "message": str(error)})
    for name, sql in {
        **{template_path(key): text for key, text in bundle["templates"].items()},
        **bundle.get("node_sql", {}),
    }.items():
        try:
            parse_template(sql, "python" if name.endswith(".py") else "sql")
        except Problem as error:
            errors.append({"file": name, "message": str(error)})
    errors.extend(project_extensions.problems(bundle))
    try:
        nodes, edges, boundaries = expand(bundle)
        errors.extend(partitions.plan(bundle, nodes, edges, boundaries)["errors"])
        errors.extend(variables.node_problems(bundle, nodes))
        seen_inputs = set()
        for edge in edges:
            key = (edge["target"], edge["targetHandle"])
            if key in seen_inputs:
                raise Problem(f"Input {nodes[key[0]]['display_name']}.{key[1]} has more than one source")
            seen_inputs.add(key)
        # An input a component exposes is connected on its outermost exposing instance.
        exposed = {}
        for instance in sorted(boundaries, key=lambda key: key.count("::"), reverse=True):
            for name, port in boundaries[instance]["inputs"].items():
                exposed[port] = (instance, name)
        for node in nodes.values():
            for port in node["parsed"]["inputs"]:
                if (node["id"], port) in seen_inputs:
                    continue
                key, name = exposed.get((node["id"], port), (node["id"], port))
                caption = node["display_name"] if key == node["id"] else node_name(bundle, key)
                errors.append(
                    {
                        "file": "flow.json",
                        "node": key,
                        "code": "missing_input",
                        "port": name,
                        "message": f"Connect input '{name}' on {caption}",
                    }
                )
        topological(nodes, edges)
    except Problem as error:
        errors.append({"file": "flow.json", "message": str(error)})
    errors.extend(variables.problems(bundle))
    errors.extend(views.problems(bundle))
    return errors
