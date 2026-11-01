"""Bounded project edits, saved through the same optimistic writer as the UI."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue
from pydantic_ai import RunContext

from .. import variables
from ..bundle import bundle_to_files
from ..components import expand, group
from ..node_code import code_path
from ..util import Problem
from .tools import Dependencies


class NodeEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["add", "update", "remove"]
    id: str = Field(pattern=r"^[A-Za-z0-9_-]+$", max_length=100)
    label: str | None = None
    position: dict[str, float] | None = None
    params: dict[str, JsonValue] | None = None
    remove_parameters: list[str] = Field(default_factory=list)
    template: str | None = None
    component: str | None = None
    sql: str | None = None


class EdgeEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["connect", "disconnect"]
    id: str = Field(min_length=1, max_length=100)
    source: str = ""
    target: str = ""
    source_port: str = "result"
    target_port: str = "input"


def editable(ctx):
    ctx.deps.check(write=True)
    snapshot = ctx.deps.snapshot()
    if snapshot["bundle"] is None:
        raise Problem("Project files are invalid", 422, snapshot["diagnostics"])
    return snapshot


def save(ctx, snapshot, bundle, **details):
    if ctx.deps.writer is None:
        raise Problem("Start an assistant turn before editing", 403)
    return ctx.deps.writer(ctx.tool_call_id, snapshot, bundle_to_files(bundle), details)


def graph_for(bundle, component):
    if not component:
        return bundle["flow"]
    if component not in bundle["components"]:
        raise Problem("Component not found", 404)
    return bundle["components"][component]


def find_node(bundle, identity):
    parts = identity.split("::")
    graph, parent = bundle["flow"], None
    for index, part in enumerate(parts):
        node = next((n for n in graph.get("nodes", []) if n["id"] == part), None)
        if node is None:
            raise Problem("Node not found", 404)
        if index == len(parts) - 1:
            return node, parent
        parent = node.get("component")
        if not parent:
            raise Problem("Node is not a component", 422)
        graph = graph_for(bundle, parent)
    raise Problem("Choose a node", 422)


def edit_flow(
    ctx: RunContext[Dependencies],
    nodes: list[NodeEdit] | None = None,
    edges: list[EdgeEdit] | None = None,
    component: str = "",
) -> dict:
    """Add, remove, rename (label), move or configure nodes and connect/disconnect ports in one save.

    Read the flow and SQL first. IDs are stable. Update params merges the supplied keys;
    remove_parameters deletes overrides. Template/component links and SQL are only for added nodes.
    A normal added node uses sql, defaulting to SELECT 1 with a result output. Include connections
    in the same call when a node has required inputs; the resulting bundle must be valid.
    Set component to edit a shared component definition; omit it for the root flow.
    """
    snapshot = editable(ctx)
    bundle = snapshot["bundle"]
    graph = graph_for(bundle, component)
    for edit in nodes or []:
        node: dict | None = next((n for n in graph["nodes"] if n["id"] == edit.id), None)
        if edit.operation == "add":
            if node is not None:
                raise Problem("A node with this ID already exists", 409)
            if sum(bool(v) for v in (edit.template, edit.component, edit.sql)) > 1:
                raise Problem("Choose node SQL, a template or a component", 422)
            node = {"id": edit.id, "params": {}, "position": {"x": 0, "y": 0}}
            if edit.template:
                node["template"] = edit.template
            elif edit.component:
                node["component"] = edit.component
            else:
                bundle.setdefault("node_sql", {})[code_path(edit.id, component)] = (
                    edit.sql or "-- @output result\nSELECT 1 AS value;\n"
                )
            graph["nodes"].append(node)
        elif node is None:
            raise Problem("Node not found", 404)
        elif edit.operation == "remove":
            graph["nodes"].remove(node)
            graph["edges"] = [e for e in graph["edges"] if edit.id not in (e["source"], e["target"])]
            bundle.get("node_sql", {}).pop(code_path(edit.id, component), None)
            continue
        elif any(v is not None for v in (edit.template, edit.component, edit.sql)):
            raise Problem("Use write_sql to edit existing code; template links cannot be changed here", 422)
        if edit.label is not None:
            node["label"] = edit.label
        if edit.position is not None:
            if set(edit.position) != {"x", "y"}:
                raise Problem("A position needs x and y coordinates", 422)
            node["position"] = edit.position
        node.setdefault("params", {}).update(edit.params or {})
        for name in edit.remove_parameters:
            node["params"].pop(name, None)
    for edit in edges or []:
        existing = next((e for e in graph["edges"] if e["id"] == edit.id), None)
        if edit.operation == "disconnect":
            if existing is None:
                raise Problem("Edge not found", 404)
            graph["edges"].remove(existing)
        else:
            if existing is not None:
                raise Problem("An edge with this ID already exists", 409)
            graph["edges"].append(
                {
                    "id": edit.id,
                    "source": edit.source,
                    "target": edit.target,
                    "sourceHandle": edit.source_port,
                    "targetHandle": edit.target_port,
                }
            )
    return save(ctx, snapshot, bundle)


def write_sql(ctx: RunContext[Dependencies], sql: str, node: str = "", template: str = "") -> dict:
    """Replace saved SQL for a normal node or a project template in one commit.

    Specify exactly one of node (expanded instance ID) or template (definition ID).
    To edit a linked node, explicitly choose its shared template instead. The result reports
    the number of linked node instances affected. This never executes SQL.
    """
    snapshot = editable(ctx)
    bundle = snapshot["bundle"]
    if bool(node) == bool(template):
        raise Problem("Choose either a normal node or a project template", 422)
    details = {}
    if template:
        if template not in bundle["templates"]:
            raise Problem("Template not found", 404)
        expanded, _, _ = expand(bundle, tolerant=True)
        details["affected_nodes"] = sum(n.get("template") == template for n in expanded.values())
        bundle["templates"][template] = sql
    else:
        found, parent = find_node(bundle, node)
        if found.get("template") or found.get("component"):
            raise Problem("Choose the shared template explicitly, or a normal SQL node", 422)
        bundle["node_sql"][code_path(found["id"], parent)] = sql
    return save(ctx, snapshot, bundle, **details)


def write_documentation(
    ctx: RunContext[Dependencies],
    section: Literal["project", "nodes", "datasets", "columns"],
    text: str,
    node: str = "",
    output: str = "",
    column: str = "",
) -> dict:
    """Write README or a node/output/column description. Use expanded node IDs and output port names."""
    snapshot = editable(ctx)
    bundle = snapshot["bundle"]
    docs = bundle["documentation"]
    if section == "project":
        docs["project"] = text
    else:
        find_node(bundle, node)
        if section == "nodes":
            docs.setdefault("nodes", {})[node] = text
        else:
            nodes, _, boundaries = expand(bundle, tolerant=True)
            outputs = boundaries[node]["outputs"] if node in boundaries else nodes[node]["parsed"]["outputs"]
            if output not in outputs:
                raise Problem("Output port not found", 404)
            key = f"{node}:{output}"
            if section == "datasets":
                docs.setdefault("datasets", {})[key] = text
            else:
                if not column:
                    raise Problem("Choose a column", 422)
                docs.setdefault("columns", {}).setdefault(key, {})[column] = text
    return save(ctx, snapshot, bundle)


def edit_variable(
    ctx: RunContext[Dependencies],
    operation: Literal["create", "update", "rename"],
    name: str,
    definition: dict[str, JsonValue] | None = None,
    new_name: str = "",
) -> dict:
    """Create/update a project variable or rename it and its references using the UI rename service.

    Read existing declarations first. definition is the declaration (type, default, description,
    environments); types include text, number, boolean, date, identifier, list<text>, list<number>
    and choice(...). Update merges the supplied fields. Rename uses only new_name.
    """
    snapshot = editable(ctx)
    bundle = snapshot["bundle"]
    if operation == "rename":
        bundle = variables.rename(bundle, name, new_name)
    else:
        declarations = bundle.get("variables") or {}
        if operation == "create" and name in declarations:
            raise Problem("Variable already exists", 409)
        if operation == "update" and name not in declarations:
            raise Problem("Variable not found", 404)
        if not definition:
            raise Problem("Provide a variable definition", 422)
        declarations[name] = {**declarations.get(name, {}), **definition}
        bundle["variables"] = declarations
    return save(ctx, snapshot, bundle)


def group_nodes(ctx: RunContext[Dependencies], nodes: list[str], name: str, component: str = "") -> dict:
    """Group selected nodes into a reusable component using the same service as the canvas."""
    snapshot = editable(ctx)
    bundle, selected = group(snapshot["bundle"], nodes, name, parent=component or None)
    return save(ctx, snapshot, bundle, selected=selected)


WRITE_TOOLS = [edit_flow, write_sql, write_documentation, edit_variable, group_nodes]
