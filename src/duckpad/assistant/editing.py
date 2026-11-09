"""Bounded project edits, saved through the same optimistic writer as the UI."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue
from pydantic_ai import RunContext

from .. import variables
from ..bundle import bundle_to_files
from ..components import expand, group
from ..node_code import code_path, find_node
from ..util import Problem
from .arguments import CreateVariable, DeleteVariable, RenameVariable, UpdateVariable
from .tools import Dependencies, variable_usages


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
    python: str | None = None


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


def edit_flow(
    ctx: RunContext[Dependencies],
    nodes: list[NodeEdit] | None = None,
    edges: list[EdgeEdit] | None = None,
    component: str = "",
) -> dict:
    """Add, remove, rename (label), move or configure nodes and connect/disconnect ports in one save.

    Read the flow and SQL first. IDs are stable. Update params merges the supplied keys;
    remove_parameters deletes overrides. Template/component links and SQL are only for added nodes.
    A normal added node uses sql or python, defaulting to SELECT 1 with a result output. Include connections
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
            if sum(bool(v) for v in (edit.template, edit.component, edit.sql, edit.python)) > 1:
                raise Problem("Choose SQL, Python, a template or a component", 422)
            node = {"id": edit.id, "params": {}, "position": {"x": 0, "y": 0}}
            if edit.python is not None or (edit.template and edit.template.endswith(".py")):
                node["language"] = "python"
            if edit.template:
                node["template"] = edit.template
            elif edit.component:
                node["component"] = edit.component
            else:
                bundle.setdefault("node_sql", {})[
                    code_path(edit.id, component, node.get("language", "sql"))
                ] = (
                    edit.python
                    if edit.python is not None
                    else edit.sql or "-- @output result\nSELECT 1 AS value;\n"
                )
            graph["nodes"].append(node)
        elif node is None:
            raise Problem("Node not found", 404)
        elif edit.operation == "remove":
            graph["nodes"].remove(node)
            graph["edges"] = [e for e in graph["edges"] if edit.id not in (e["source"], e["target"])]
            bundle.get("node_sql", {}).pop(code_path(edit.id, component, node.get("language", "sql")), None)
            continue
        elif any(v is not None for v in (edit.template, edit.component, edit.sql, edit.python)):
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
    """Replace saved SQL or Python code for a normal node or a project template in one commit.

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
        bundle["node_sql"][code_path(found["id"], parent, found.get("language", "sql"))] = sql
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
    change: Annotated[
        CreateVariable | UpdateVariable | RenameVariable | DeleteVariable, Field(discriminator="operation")
    ],
) -> dict:
    """Create, update, rename or delete a project variable, with a commit and Undo for each change.

    Pass one change object: {"operation": ..., "name": ..., ...} with only that operation's fields.
    Read declarations/usages with read_variables first. definition contains type, description,
    default and environments, or from={node, port, column} for a computed variable. Types include
    text, number, boolean, date, identifier, list<text>, list<number> and choice(...).
    Update merges fields and individual environments, preserving other overrides. Use remove_fields
    to unset fields (not null) or switch ordinary/computed mode; remove_environments restores
    inheritance for those environments. Removals happen before merging definition.
    Rename updates references. Delete refuses variables still used by node parameters,
    expressions, paths or saved views; inspect usages to resolve them.
    """
    snapshot = editable(ctx)
    bundle = snapshot["bundle"]
    name = change.name
    declarations = bundle.get("variables") or {}
    if not isinstance(declarations, dict):
        raise Problem("Correct variables.json before editing variables", 422)
    if isinstance(change, RenameVariable):
        return save(ctx, snapshot, variables.rename(bundle, name, change.new_name))
    if isinstance(change, CreateVariable):
        if name in declarations:
            raise Problem("Variable already exists", 409)
        declarations[name] = change.definition
    elif name not in declarations:
        raise Problem("Variable not found", 404)
    elif isinstance(change, UpdateVariable):
        updated = dict(declarations[name])
        for field in change.remove_fields or []:
            updated.pop(field, None)
        if change.remove_environments and isinstance(updated.get("environments"), dict):
            updated["environments"] = {
                k: v for k, v in updated["environments"].items() if k not in change.remove_environments
            }
        patch = dict(change.definition or {})
        overrides = patch.get("environments")
        if isinstance(overrides, dict) and isinstance(updated.get("environments"), dict):
            patch["environments"] = {**updated["environments"], **overrides}
        declarations[name] = {**updated, **patch}
    else:
        if name in variable_usages(bundle):
            raise Problem(
                "Variable is still in use. Read its usages with read_variables before deleting.", 422
            )
        del declarations[name]
    bundle["variables"] = declarations
    return save(ctx, snapshot, bundle)


def group_nodes(ctx: RunContext[Dependencies], nodes: list[str], name: str, component: str = "") -> dict:
    """Group selected nodes into a reusable component using the same service as the canvas."""
    snapshot = editable(ctx)
    bundle, selected = group(snapshot["bundle"], nodes, name, parent=component or None)
    return save(ctx, snapshot, bundle, selected=selected)


def output_key(bundle, node, output):
    """The key storing an output's rows: `node:port`, or `instance::node:port` behind an instance port."""
    find_node(bundle, node)
    nodes, _, boundaries = expand(bundle, tolerant=True)
    ports = boundaries[node]["outputs"] if node in boundaries else None
    if ports is None:
        ports = {port: (node, port) for port in nodes.get(node, {}).get("parsed", {}).get("outputs", [])}
    if output not in ports:
        raise Problem("Output port not found", 404)
    producer, port = ports[output]
    return f"{producer}:{port}"


def unknown_fields(ctx, key, spec) -> dict:
    """`unknown_fields`: the fields a chart encodes that the output's materialized columns lack.

    Mirrors the Chart tab's check (top level and layers). Reads schema metadata only, from the
    page's environment; nothing when the output was never run or its schema cannot be read.
    """
    try:
        worktree, environment = ctx.deps.results()
    except Problem:
        return {}
    context = ctx.deps.services.engine.pool.find(worktree, environment)
    if not context:
        return {}
    node, _, port = key.rpartition(":")
    with context.lock:
        dataset = context.outputs.get(node, {}).get(port)
        known = {column["name"] for column in dataset.columns} if dataset else None
    if known is None:
        return {}
    # The save validated the spec: encodings map channels to definitions, or tooltip to a list.
    fields = [
        definition.get("field")
        for part in [spec, *spec.get("layer", [])]
        for channel in part.get("encoding", {}).values()
        for definition in (channel if isinstance(channel, list) else [channel])
    ]
    unknown = list(dict.fromkeys(f for f in fields if f is not None and f not in known))
    return {"unknown_fields": unknown} if unknown else {}


def edit_chart(
    ctx: RunContext[Dependencies],
    operation: Literal["create", "update", "rename", "delete"],
    node: str,
    output: str,
    name: str,
    spec: Annotated[
        dict[str, JsonValue] | None, Field(description="Vega-Lite 6 spec within Duckpad's chart allowlist")
    ] = None,
    new_name: str = "",
) -> dict:
    """Create, update, rename or delete a named chart of a node output, with a commit and Undo for each change.

    A chart is a Vega-Lite 6 spec drawn from the rows of one output, shown in its Chart tab. Duckpad
    supplies the rows as "data": {"name": "data"} and accepts a subset of Vega-Lite: the top-level
    fields $schema, data, mark, encoding, layer, title, description, width and height, with no
    transforms, aggregates or expressions. Charts draw at most 5,000 rows: aggregate, bin and filter
    in the node's SQL first. Before writing a spec, read the charts guide (read_guide), the current
    charts.json (read_file) and the output schema (read_schemas). node is the expanded node or component-instance ID shown on the
    canvas, output its output port name. Create and update take spec; update replaces the whole spec,
    never merges it. Rename uses only new_name, on the same output; delete uses only name.
    """
    snapshot = editable(ctx)
    bundle = snapshot["bundle"]
    if operation in ("rename", "delete") and spec is not None:
        raise Problem("Rename and delete do not accept a spec", 422)
    if operation != "rename" and new_name:
        raise Problem("Only rename accepts a new name", 422)
    key = output_key(bundle, node, output)
    charts = bundle.get("charts") or {}
    if not isinstance(charts, dict) or not isinstance(charts.get(key, []), list):
        raise Problem("Correct charts.json before editing charts", 422)
    entries = charts.setdefault(key, [])
    existing = next((c for c in entries if isinstance(c, dict) and c.get("name") == name), None)
    if operation in ("create", "update") and spec is None:
        raise Problem("Provide a chart spec", 422)
    if operation == "create":
        if existing is not None:
            raise Problem("A chart with this name already exists on this output", 409)
        entries.append({"name": name, "spec": spec})
    elif existing is None:
        raise Problem("Chart not found", 404)
    elif operation == "update":
        existing["spec"] = spec
    elif operation == "rename":
        if any(isinstance(c, dict) and c.get("name") == new_name for c in entries):
            raise Problem("A chart with this name already exists on this output", 409)
        existing["name"] = new_name
    else:
        entries.remove(existing)
        if not entries:
            del charts[key]
    bundle["charts"] = charts
    # The save validates every chart: chart rules live in duckpad.charts only.
    result = save(ctx, snapshot, bundle)
    if operation in ("create", "update") and "error" not in result:
        result |= unknown_fields(ctx, key, spec)
    return result


WRITE_TOOLS = [edit_flow, write_sql, write_documentation, edit_variable, group_nodes, edit_chart]
