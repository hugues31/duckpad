"""Resolve node-owned SQL independently of reusable template definitions."""

from .util import Problem


def code_path(node_id, parent=None, language="sql"):
    suffix = "py" if language == "python" else "sql"
    return f"components/{parent}/{node_id}.{suffix}" if parent else f"nodes/{node_id}.{suffix}"


def template_path(identity):
    return f"templates/{identity}" if identity.endswith(".py") else f"templates/{identity}.sql"


def node_sql(bundle, node, parent=None):
    if node.get("template"):
        identity = node["template"]
        if identity not in bundle["templates"]:
            raise Problem(f"Missing template: {identity}")
        return bundle["templates"][identity]
    path = code_path(node["id"], parent, node.get("language", "sql"))
    if path not in bundle.get("node_sql", {}):
        raise Problem(f"Missing node code: {path}")
    return bundle["node_sql"][path]


def owned_paths(bundle):
    """Paths owned by normal nodes, including unused component definitions."""
    graphs = [(None, bundle["flow"]), *bundle["components"].items()]
    return {
        code_path(node["id"], parent, node.get("language", "sql"))
        for parent, graph in graphs
        for node in graph.get("nodes", [])
        if not node.get("template") and not node.get("component")
    }
