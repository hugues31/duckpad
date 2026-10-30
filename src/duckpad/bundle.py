"""Declarative project files: the on-disk layout, its parsed bundle and validation."""

import json
import re
import tomllib
from pathlib import Path

from . import __version__, variables
from .components import expand
from .templates import parse_template
from .util import Problem, dumps

ROOT_FILES = ("flow.json", "documentation.json", "README.md", "pyproject.toml", variables.FILE)
DECLARATIVE_PATH = re.compile(r"templates/[A-Za-z0-9_-]+\.sql|components/[A-Za-z0-9_-]+\.json")


def is_declarative(name):
    """Whether a relative path is a project file that Duckpad reads, versions and edits."""
    return name in ROOT_FILES or DECLARATIVE_PATH.fullmatch(name) is not None


def files_to_bundle(files):
    try:
        documentation = json.loads(files["documentation.json"])
        if "README.md" in files and isinstance(documentation, dict):
            documentation.pop("project", None)
            if files["README.md"]:
                documentation["project"] = files["README.md"]
        return {
            "flow": json.loads(files["flow.json"]),
            "templates": {
                Path(n).stem: text
                for n, text in files.items()
                if n.startswith("templates/") and n.endswith(".sql")
            },
            "components": {
                Path(n).stem: json.loads(text)
                for n, text in files.items()
                if n.startswith("components/") and n.endswith(".json")
            },
            "documentation": documentation,
            "pyproject": files.get("pyproject.toml"),
            "variables": variables.read(files.get(variables.FILE)),
        }
    except (ValueError, KeyError) as error:
        raise Problem(f"Cannot read declarative project files: {error}") from error


def default_pyproject(name):
    """A dependency-only project, suitable for uv sync without packaging the flow."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "untitled"
    return (
        f'[project]\nname = "duckpad-project-{slug}"\n'
        'version = "0.1.0"\nreadme = "README.md"\nrequires-python = ">=3.11"\n'
        f'dependencies = ["duckpad=={__version__}"]\n'
        "\n[tool.uv]\npackage = false\n"
    )


def bundle_to_files(bundle):
    flow, documentation = bundle.get("flow"), bundle.get("documentation", {})
    templates, components = bundle.get("templates", {}), bundle.get("components", {})
    if not all(isinstance(section, dict) for section in (flow, documentation, templates, components)):
        raise Problem("A project bundle needs flow, documentation, templates and components objects", 422)
    readme, pyproject = documentation.get("project"), bundle.get("pyproject")
    readme = "" if readme is None else readme
    if not all(isinstance(text, str) for text in (*templates.values(), readme)) or not isinstance(
        pyproject, str | None
    ):
        raise Problem("Templates, project documentation and pyproject must be text", 422)
    name = flow.get("name")
    return {
        "flow.json": dumps(flow),
        "documentation.json": dumps({k: v for k, v in documentation.items() if k != "project"}),
        "README.md": readme,
        "pyproject.toml": pyproject
        if pyproject is not None
        else default_pyproject(name if isinstance(name, str) else "Untitled project"),
        **{f"templates/{key}.sql": value for key, value in templates.items()},
        **{f"components/{key}.json": dumps(value) for key, value in components.items()},
        **(
            {variables.FILE: variables.write(bundle["variables"])}
            if bundle.get("variables") is not None
            else {}
        ),
    }


def validate(bundle):
    errors = []
    if bundle.get("pyproject") is not None:
        try:
            tomllib.loads(bundle["pyproject"])
        except (ValueError, TypeError) as error:
            errors.append({"file": "pyproject.toml", "message": str(error)})
    try:
        if not all(
            isinstance(bundle.get(key), dict) for key in ("flow", "templates", "components", "documentation")
        ):
            raise Problem("Project sections must be objects")
        graphs = [
            ("flow.json", bundle["flow"]),
            *[(f"components/{key}.json", value) for key, value in bundle["components"].items()],
        ]
        for file, graph in graphs:
            if not isinstance(graph, dict):
                raise Problem(f"{file}: graph must be an object")
            for collection in ("nodes", "edges"):
                values = graph.get(collection, [])
                if not isinstance(values, list) or any(
                    not isinstance(v, dict) or not isinstance(v.get("id"), str) or not v["id"] for v in values
                ):
                    raise Problem(f"{file}: {collection} need stable string identifiers")
                if len({v["id"] for v in values}) != len(values):
                    raise Problem(f"{file}: {collection} identifiers must be unique")
            for node in graph.get("nodes", []):
                if bool(node.get("component")) == bool(node.get("template")):
                    raise Problem(f"{file}: each node needs exactly one template or component")
                if not isinstance(node.get("params", {}), dict):
                    raise Problem(f"{file}: node parameters must be an object")
            for definition in graph.get("parameters", {}).values():
                for target in definition.get("targets", []):
                    node = next((n for n in graph.get("nodes", []) if n["id"] == target["node"]), None)
                    if node is None:
                        raise Problem(f"{file}: exposed parameter target is missing")
                    parameters = (
                        bundle["components"][node["component"]].get("parameters", {})
                        if node.get("component")
                        else {
                            p["name"]: p
                            for p in parse_template(bundle["templates"][node["template"]])["parameters"]
                        }
                    )
                    if target["param"] not in parameters:
                        raise Problem(f"{file}: exposed parameter does not exist on its target")
        # Validate unused reusable definitions too, including their boundary ports and cycles.
        for key in bundle["components"]:
            nodes, edges, _ = expand(
                {**bundle, "flow": {"nodes": [{"id": "instance", "component": key}], "edges": []}}
            )
            topological(nodes, edges)
    except (Problem, KeyError, TypeError, AttributeError, RecursionError) as error:
        return [{"file": "flow.json", "message": str(error)}]
    for name, sql in bundle["templates"].items():
        try:
            parse_template(sql)
        except Exception as error:
            errors.append({"file": f"templates/{name}.sql", "message": str(error)})
    errors.extend(variables.problems(bundle))
    try:
        nodes, edges, _ = expand(bundle)
        errors.extend(variables.node_problems(bundle, nodes))
        identifiers = [n["id"] for n in bundle["flow"].get("nodes", [])]
        if len(set(identifiers)) != len(identifiers):
            raise Problem("Node identifiers must be unique")
        seen_inputs = set()
        for edge in edges:
            key = (edge["target"], edge["targetHandle"])
            if key in seen_inputs:
                raise Problem(f"Input {key[0]}.{key[1]} has more than one source")
            seen_inputs.add(key)
        errors.extend(
            {
                "file": "flow.json",
                "node": node["id"],
                "message": f"Connect input '{port}' on {node.get('label', node['id'])}",
            }
            for node in nodes.values()
            for port in node["parsed"]["inputs"]
            if (node["id"], port) not in seen_inputs
        )
        topological(nodes, edges)
    except Exception as error:
        errors.append({"file": "flow.json", "message": str(error)})
    return errors


def topological(nodes, edges, tolerant=False):
    dependencies = {n: {e["source"] for e in edges if e["target"] == n} for n in nodes}
    ordered = []
    while dependencies:
        ready = [key for key, values in dependencies.items() if not values]
        if not ready:
            if not tolerant:
                raise Problem("The graph contains a cycle")
            for key in dependencies:
                nodes[key]["error"] = "This node is part of, or depends on, a graph cycle"
            ordered.extend(dependencies)
            break
        for key in ready:
            ordered.append(key)
            del dependencies[key]
        for values in dependencies.values():
            values.difference_update(ready)
    return ordered
