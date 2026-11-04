"""Declarative project files: the on-disk layout, its parsed bundle and validation."""

import json
import re
import tomllib
from contextlib import suppress
from pathlib import Path

from . import partitions, project_extensions, variables, views
from .components import expand
from .node_code import node_sql
from .node_names import Name, node_names
from .templates import parse_template
from .types import Files
from .util import Problem, dumps

ROOT_FILES = (
    "flow.json",
    "documentation.json",
    "README.md",
    "pyproject.toml",
    "uv.lock",
    variables.FILE,
    project_extensions.FILE,
    views.FILE,
)
DECLARATIVE_PATH = re.compile(
    r"templates/[A-Za-z0-9_-]+\.(?:sql|py)|nodes/[A-Za-z0-9_-]+\.(?:sql|py)|components/[A-Za-z0-9_-]+(?:\.json|/[A-Za-z0-9_-]+\.(?:sql|py))|modules/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+\.py"
)


def is_declarative(name):
    """Whether a relative path is a project file that Duckpad reads, versions and edits."""
    return name in ROOT_FILES or DECLARATIVE_PATH.fullmatch(name) is not None


def files_to_bundle(files):
    try:
        documentation = json.loads(files["documentation.json"])
        if isinstance(documentation, dict):
            if "project" in documentation:
                raise Problem(
                    'Move project documentation from documentation.json to README.md and remove the "project" key.',
                    422,
                )
            if files.get("README.md"):
                documentation["project"] = files["README.md"]
        return {
            "flow": json.loads(files["flow.json"]),
            "templates": {
                (Path(n).name if n.endswith(".py") else Path(n).stem): text
                for n, text in files.items()
                if n.startswith("templates/") and n.endswith((".sql", ".py"))
            },
            "node_sql": {
                n: text
                for n, text in files.items()
                if n.endswith((".sql", ".py")) and not n.startswith(("templates/", "modules/"))
            },
            "components": {
                Path(n).stem: json.loads(text)
                for n, text in files.items()
                if n.startswith("components/") and n.endswith(".json")
            },
            "documentation": documentation,
            "pyproject": files.get("pyproject.toml"),
            "python_lock": files.get("uv.lock"),
            "python_helpers": {
                n.removeprefix("modules/"): v for n, v in files.items() if n.startswith("modules/")
            },
            "variables": variables.read(files.get(variables.FILE)),
            "extensions": project_extensions.read(files.get(project_extensions.FILE)),
            "views": views.read(files.get(views.FILE)),
        }
    except (ValueError, KeyError) as error:
        raise Problem(f"Cannot read declarative project files: {error}") from error


def default_pyproject(name):
    """A dependency-only project, suitable for uv sync without packaging the flow."""
    import sys

    import duckdb

    from .python_environment import manifest_settings

    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "untitled"
    return (
        f'[project]\nname = "duckpad-project-{slug}"\n'
        f'version = "0.1.0"\nreadme = "README.md"\nrequires-python = "=={sys.version_info.major}.{sys.version_info.minor}.*"\n'
        f'dependencies = ["duckdb=={duckdb.__version__}", "pytz>=2024.1"]\n'
        "\n[tool.uv]\npackage = false\n" + manifest_settings()
    )


def bundle_to_files(bundle):
    flow, documentation = bundle.get("flow"), bundle.get("documentation", {})
    templates, components = bundle.get("templates", {}), bundle.get("components", {})
    code = bundle.get("node_sql", {})
    if not isinstance(code, dict) or any(
        not isinstance(path, str)
        or not is_declarative(path)
        or not path.endswith((".sql", ".py"))
        or path.startswith("templates/")
        or not isinstance(text, str)
        for path, text in code.items()
    ):
        raise Problem("Node code must map node SQL or Python paths to text", 422)
    helpers = bundle.get("python_helpers", {})
    if (
        not isinstance(helpers, dict)
        or any(
            not isinstance(name, str) or not is_declarative("modules/" + name) or not isinstance(text, str)
            for name, text in helpers.items()
        )
        or not isinstance(bundle.get("python_lock"), str | None)
    ):
        raise Problem("Python helpers must map relative .py paths to text and uv.lock must be text", 422)
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
        **code,
        **({"uv.lock": bundle["python_lock"]} if bundle.get("python_lock") is not None else {}),
        **{f"modules/{name}": text for name, text in bundle.get("python_helpers", {}).items()},
        "flow.json": dumps(flow),
        "documentation.json": dumps({k: v for k, v in documentation.items() if k != "project"}),
        "README.md": readme,
        "pyproject.toml": pyproject
        if pyproject is not None
        else default_pyproject(name if isinstance(name, str) else "Untitled project"),
        **{
            f"templates/{key}" if key.endswith(".py") else f"templates/{key}.sql": value
            for key, value in templates.items()
        },
        **{f"components/{key}.json": dumps(value) for key, value in components.items()},
        **(
            {project_extensions.FILE: project_extensions.write(bundle["extensions"])}
            if bundle.get("extensions") is not None
            else {}
        ),
        **(
            {variables.FILE: variables.write(bundle["variables"])}
            if bundle.get("variables") is not None
            else {}
        ),
        **({views.FILE: views.write(bundle["views"])} if bundle.get("views") is not None else {}),
    }


def validate(bundle):
    errors = []
    if bundle.get("pyproject") is not None:
        try:
            tomllib.loads(bundle["pyproject"])
        except (ValueError, TypeError) as error:
            errors.append({"file": "pyproject.toml", "message": str(error)})
    for name in bundle.get("python_helpers", {}):
        parts = name.removesuffix(".py").split("/")
        if parts[0] == "duckpad":
            message = "A helper module named duckpad would replace the Duckpad SDK; rename it"
        elif not all(part.isidentifier() for part in parts):
            message = "Helper module paths must be Python identifiers to be importable"
        else:
            continue
        errors.append({"file": "modules/" + name, "message": message})
    try:
        if not all(
            isinstance(bundle.get(key), dict) for key in ("flow", "templates", "components", "documentation")
        ):
            raise Problem("Project sections must be objects")
        graphs = [
            ("flow.json", bundle["flow"], None),
            *[(f"components/{key}.json", value, key) for key, value in bundle["components"].items()],
        ]
        for file, graph, parent in graphs:
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
                if node.get("component") and node.get("template"):
                    raise Problem(f"{file}: a node cannot have both a template and a component")
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
                            for p in parse_template(
                                node_sql(bundle, node, parent), node.get("language", "sql")
                            )["parameters"]
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
    for name, sql in {
        **{
            (f"templates/{key}" if key.endswith(".py") else f"templates/{key}.sql"): text
            for key, text in bundle["templates"].items()
        },
        **bundle.get("node_sql", {}),
    }.items():
        try:
            parse_template(sql, "python" if name.endswith(".py") else "sql")
        except Exception as error:
            errors.append({"file": name, "message": str(error)})
    errors.extend(project_extensions.problems(bundle))
    errors.extend(variables.problems(bundle))
    errors.extend(views.problems(bundle))
    try:
        nodes, edges, boundaries = expand(bundle)
        errors.extend(partitions.plan(bundle, nodes, edges, boundaries)["errors"])
        errors.extend(variables.node_problems(bundle, nodes))
        identifiers = [n["id"] for n in bundle["flow"].get("nodes", [])]
        if len(set(identifiers)) != len(identifiers):
            raise Problem("Node identifiers must be unique")
        seen_inputs = set()
        for edge in edges:
            key = (edge["target"], edge["targetHandle"])
            if key in seen_inputs:
                raise Problem(f"Input {nodes[key[0]]['display_name']}.{key[1]} has more than one source")
            seen_inputs.add(key)
        errors.extend(
            {
                "file": "flow.json",
                "node": node["id"],
                "message": f"Connect input '{port}' on {node['display_name']}",
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


def file_node_names(*versions: Files) -> dict[str, Name]:
    """Prefer the current version, retaining names of nodes removed in other versions."""
    names = {}
    for files in versions:
        with suppress(Problem, AttributeError, KeyError, TypeError):
            names.update(node_names(files_to_bundle(files)))
    return names
