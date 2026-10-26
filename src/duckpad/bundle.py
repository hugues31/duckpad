"""Declarative project files: the on-disk layout, its parsed bundle and validation."""

import json
import re
from pathlib import Path

from .components import expand
from .templates import parse_template
from .util import Problem, dumps

ROOT_FILES = ("flow.json", "documentation.json")
DECLARATIVE_PATH = re.compile(r"templates/[A-Za-z0-9_-]+\.sql|components/[A-Za-z0-9_-]+\.json")


def is_declarative(name):
    """Whether a relative path is a project file that Duckpad reads, versions and edits."""
    return name in ROOT_FILES or DECLARATIVE_PATH.fullmatch(name) is not None


def files_to_bundle(files):
    try:
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
            "documentation": json.loads(files.get("documentation.json", "{}")),
        }
    except (ValueError, KeyError) as error:
        raise Problem(f"Cannot read declarative project files: {error}") from error


def bundle_to_files(bundle):
    return {
        "flow.json": dumps(bundle["flow"]),
        "documentation.json": dumps(bundle.get("documentation", {})),
        **{f"templates/{key}.sql": value for key, value in bundle.get("templates", {}).items()},
        **{f"components/{key}.json": dumps(value) for key, value in bundle.get("components", {}).items()},
    }


def validate(bundle):
    errors = []
    for name, sql in bundle["templates"].items():
        try:
            parse_template(sql)
        except Exception as error:
            errors.append({"file": f"templates/{name}.sql", "message": str(error)})
    try:
        nodes, edges, _ = expand(bundle)
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
