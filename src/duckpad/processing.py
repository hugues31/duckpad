"""Inputs that define a node's computation, shared by execution and static comparison."""

from . import project_extensions, variables
from .python_contract import executable_python
from .templates import executable_sql


def executable(text, language="sql"):
    return (executable_python if language == "python" else executable_sql)(text)


def inputs(bundle, node, *, python_runtime=None, entry=None):
    if node is None:
        return None
    params = {p["name"]: p["default"] for p in node["parsed"]["parameters"] if "default" in p}
    params.update(node.get("params", {}))
    python = node.get("language") == "python"
    collected = node.get("partition_collect_inputs", [])
    return {
        # Absent unless muted, so existing results keep their fingerprints.
        **({"mute_inputs": node["mute_inputs"]} if node.get("muted") else {}),
        "sql": executable(node["template_sql"], node.get("language", "sql")),
        "python": [
            python_runtime,
            bundle.get("python_lock"),
            bundle.get("python_helpers"),
            bundle.get("pyproject"),
        ]
        if python
        else None,
        "error": node.get("error"),
        "params": variables.fingerprinted(node, params),
        "extensions": project_extensions.enabled(bundle.get("extensions")),
        **(
            {
                "partition": {
                    "key": {k: entry["key"][k] for k in ("type", "value")}
                    if entry and node.get("partitioned")
                    else None,
                    "definition": node.get("partition_definition"),
                    "filters": {
                        p: d.get("column") if isinstance(d, dict) else d
                        for p, d in node.get("partition_filters", {}).items()
                    },
                    "collect": collected,
                }
            }
            if node.get("partitioned") or collected
            else {}
        ),
    }
