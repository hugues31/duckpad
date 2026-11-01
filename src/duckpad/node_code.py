"""Resolve node-owned SQL independently of reusable template definitions."""

from .util import Problem


def code_path(node_id, parent=None):
    return f"components/{parent}/{node_id}.sql" if parent else f"nodes/{node_id}.sql"


def node_sql(bundle, node, parent=None):
    if node.get("template"):
        identity = node["template"]
        if identity not in bundle["templates"]:
            raise Problem(f"Missing template: {identity}")
        return bundle["templates"][identity]
    path = code_path(node["id"], parent)
    if path not in bundle.get("node_sql", {}):
        raise Problem(f"Missing node code: {path}")
    return bundle["node_sql"][path]


def owned_paths(bundle):
    """Paths owned by normal nodes, including unused component definitions."""
    graphs = [(None, bundle["flow"]), *bundle["components"].items()]
    return {
        code_path(node["id"], parent)
        for parent, graph in graphs
        for node in graph.get("nodes", [])
        if not node.get("template") and not node.get("component")
    }
