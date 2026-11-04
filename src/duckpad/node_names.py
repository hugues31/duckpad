"""Display names shared by diagnostics, history and the interface, independent of valid SQL."""

from .node_code import code_path
from .templates import directives
from .types import Record

Name = list[dict[str, str]]


def node_caption(bundle: Record, node: Record, parent: str | None = None) -> dict[str, str]:
    """Resolve one node; mark only SQL-derived names as eligible for UI translation."""
    if node.get("label"):
        return {"label": str(node["label"])}
    if node.get("component"):
        definition = bundle.get("components", {}).get(node["component"], {})
        return {"label": str(definition.get("name") or node["component"])}
    template = node.get("template")
    sql = (
        bundle.get("templates", {}).get(template, "")
        if template
        else bundle.get("node_sql", {}).get(code_path(node["id"], parent), "")
    )
    labels = [text for kind, text in directives(sql) if kind == "label"]
    preset = node.get("preset") or template or node.get("origin") or "sql"
    return {"label": labels[-1] if labels and labels[-1] else "SQL template", "template": preset}


def node_name_parts(bundle: Record, identity: str, parent: str | None = None) -> Name:
    """Resolve an instance path, or a node in an uninstantiated component definition."""
    graph = bundle.get("components", {}).get(parent, {}) if parent else bundle.get("flow", {})
    names = [{"label": graph.get("name") or parent}] if parent else []
    for part in identity.split("::"):
        node = next((n for n in graph.get("nodes", []) if n.get("id") == part), None)
        names.append(node_caption(bundle, node, parent) if node else {"label": part})
        parent = node.get("component") if node else None
        graph = bundle.get("components", {}).get(parent, {})
    return names


def node_name(bundle: Record, identity: str, parent: str | None = None) -> str:
    return " / ".join(part["label"] for part in node_name_parts(bundle, identity, parent))


def node_names(bundle: Record | None) -> dict[str, Name]:
    """Names keyed by instance path and by component code path, including unused definitions."""
    if not bundle:
        return {}
    result: dict[str, Name] = {}

    def visit(graph: Record, prefix: str, parents: Name, stack: tuple[str, ...]) -> None:
        for node in graph.get("nodes", []):
            key = prefix + node["id"]
            parts = [*parents, node_caption(bundle, node, stack[-1] if stack else None)]
            result[key] = parts
            component = node.get("component")
            if component and component not in stack:
                visit(bundle.get("components", {}).get(component, {}), key + "::", parts, (*stack, component))

    try:
        visit(bundle.get("flow", {}), "", [], ())
        for parent, graph in bundle.get("components", {}).items():
            for node in graph.get("nodes", []):
                result[f"components/{parent}/{node['id']}"] = node_name_parts(bundle, node["id"], parent)
    except (AttributeError, KeyError, TypeError):
        # A malformed file must remain editable, with names for any readable nodes.
        pass
    return result
