"""Bounded project edits, saved through the same optimistic writer as the UI."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue
from pydantic_ai import RunContext

from .. import variables
from ..bundle import bundle_to_files
from ..charts import declarations as chart_declarations
from ..charts import unknown_fields
from ..components import expand, group, output_port
from ..node_code import code_path, find_node
from ..util import Problem
from .arguments import (
    CreateChart,
    CreateVariable,
    DeleteChart,
    DeleteVariable,
    RenameChart,
    RenameVariable,
    UpdateChart,
    UpdateVariable,
)
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
            output_port(bundle, node, output)
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


def edit_chart(
    ctx: RunContext[Dependencies],
    change: Annotated[
        CreateChart | UpdateChart | RenameChart | DeleteChart, Field(discriminator="operation")
    ],
) -> dict:
    """Create, update, rename or delete a named chart of a node output, with a commit and Undo for each change.

    Pass one change object: {"operation": ..., "node": ..., "output": ..., "name": ..., ...} with only
    that operation's fields. A chart is a Vega-Lite 6 spec drawn from the rows of one output, shown in
    its Chart tab. Duckpad supplies the rows as "data": {"name": "data"} and accepts a subset of
    Vega-Lite: the top-level fields $schema, data, mark, encoding, layer, title, description, width and
    height, with no transforms, aggregates or expressions. Charts draw at most 5,000 rows: aggregate,
    bin and filter in the node's SQL first. Before writing a spec, read the charts guide (read_guide),
    the current charts.json (read_file) and the output schema (read_schemas). Create and update take
    spec; update replaces the whole spec, never merges it. Rename stays on the same output.
    """
    snapshot = editable(ctx)
    bundle = snapshot["bundle"]
    name = change.name
    find_node(bundle, change.node)
    producer, port = output_port(bundle, change.node, change.output)
    key = f"{producer}:{port}"
    charts = bundle.get("charts") or {}
    if not isinstance(charts, dict) or not isinstance(charts.get(key, []), list):
        raise Problem("Correct charts.json before editing charts", 422)
    entries = charts.setdefault(key, [])
    existing = next((c for c in entries if isinstance(c, dict) and c.get("name") == name), None)
    if isinstance(change, CreateChart):
        if existing is not None:
            raise Problem("A chart with this name already exists on this output", 409)
        existing = {"name": name, "spec": change.spec}
        entries.append(existing)
    elif existing is None:
        raise Problem("Chart not found", 404)
    elif isinstance(change, UpdateChart):
        existing["spec"] = change.spec
    elif isinstance(change, RenameChart):
        if any(isinstance(c, dict) and c.get("name") == change.new_name for c in entries):
            raise Problem("A chart with this name already exists on this output", 409)
        existing["name"] = change.new_name
    else:
        entries.remove(existing)
        if not entries:
            del charts[key]
    if not isinstance(change, DeleteChart):
        # The save ignores problems the file already had, and the first one hides the others:
        # check the requested chart, name included, on its own.
        chart_declarations({"charts": {key: [existing]}})
    bundle["charts"] = charts
    result = save(ctx, snapshot, bundle)
    if isinstance(change, (CreateChart, UpdateChart)) and "error" not in result:
        columns = ctx.deps.output_columns(bundle, producer, port)
        if columns is not None and (unknown := unknown_fields(change.spec, columns)):
            result["unknown_fields"] = unknown
    return result


WRITE_TOOLS = [edit_flow, write_sql, write_documentation, edit_variable, group_nodes, edit_chart]
