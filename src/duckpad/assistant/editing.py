"""Bounded project edits, saved through the same optimistic writer as the UI."""

from typing import Annotated

from pydantic import Field
from pydantic_ai import ApprovalRequired, RunContext

from .. import variables
from ..bundle import bundle_to_files
from ..charts import declarations as chart_declarations
from ..charts import unknown_fields
from ..components import expand, group, output_port
from ..git.workspace import require_valid
from ..node_code import code_path, find_node
from ..project_extensions import activate_file_readers
from ..python_nodes import remember_contracts
from ..util import Problem
from .actions import describe
from .arguments import (
    AddNode,
    ColumnDocumentation,
    ConnectEdge,
    CreateChart,
    CreateVariable,
    DatasetDocumentation,
    DeleteChart,
    DeleteVariable,
    DisconnectEdge,
    NodeDocumentation,
    ProjectDocumentation,
    RemoveNode,
    RenameChart,
    RenameVariable,
    UpdateChart,
    UpdateNode,
    UpdateVariable,
)
from .registry import tool
from .tools import Dependencies, reading, variable_usages


def editable(ctx):
    """The files of the open branch, the only one a tool edits.

    An edit is also a read: its result holds diffs and diagnostics of the branch.
    """
    ctx.deps.check(write=True)
    snapshot = reading(ctx).snapshot()
    if snapshot["bundle"] is None:
        raise Problem("Project files are invalid", 422, snapshot["diagnostics"])
    return snapshot


def save(ctx, snapshot, bundle, **details):
    """Save an edit of the open branch, once its user has confirmed it when the conversation holds
    content of another project or connection settings.

    The confirmation shows every file change in full. An edit whose changes differ from the
    confirmed ones, for example after the branch changed, needs a new confirmation: one answer
    never covers another edit.
    """
    if ctx.deps.writer is None:
        raise Problem("Start an assistant turn before editing", 403)
    files = bundle_to_files(bundle)
    if ctx.deps.read_outside():
        before = snapshot["files"]
        # What the save adds to these files is confirmed with them, and a change the project
        # would refuse is reported now, not after its confirmation. The lock of changed Python
        # dependencies is resolved by the save alone.
        after = remember_contracts(activate_file_readers(before, dict(files)))
        require_valid(after, "The proposed changes are invalid", baseline=before)
        proposal = ctx.deps.safe(describe(before, after, every=True))
        diffs = proposal["diffs"] = proposal.pop("sql_diffs")
        changed = {path for path in before.keys() | after.keys() if before.get(path) != after.get(path)}
        if any(diff["truncated"] for diff in diffs) or {diff["path"] for diff in diffs} != changed:
            raise Problem("This change is too large to confirm at once. Make it in smaller changes.", 409)
        # One answer confirms one save, also when a provider reuses the ID of its call.
        confirmed = ctx.deps.confirmed.pop(ctx.tool_call_id, None)
        # A save that changes no file has nothing to confirm.
        if confirmed is None and proposal["diffs"]:
            raise ApprovalRequired(proposal)
        if confirmed and any(confirmed.get(key) != value for key, value in proposal.items()):
            raise Problem("This change differs from the confirmed one. Request it again.", 409)
    return ctx.deps.writer(ctx.tool_call_id, snapshot, files, details)


def graph_for(bundle, component):
    if not component:
        return bundle["flow"]
    if component not in bundle["components"]:
        raise Problem("Component not found", 404)
    return bundle["components"][component]


@tool(needs="write", retries=2)
def edit_flow(
    ctx: RunContext[Dependencies],
    nodes: list[Annotated[AddNode | UpdateNode | RemoveNode, Field(discriminator="operation")]] | None = None,
    edges: list[Annotated[ConnectEdge | DisconnectEdge, Field(discriminator="operation")]] | None = None,
    component: str = "",
) -> dict:
    """Add, update or remove nodes and connect or disconnect ports in one save.

    Pass node changes {"operation": "add" | "update" | "remove", "id": ..., ...} and edge changes
    {"operation": "connect" | "disconnect", "id": ..., ...} with only that operation's fields.
    Read the flow and SQL first. IDs are stable. Add takes at most one of sql, python, template or
    component; a normal node defaults to SELECT 1 with a result output. Update changes the label,
    position (x and y) or params: params merges the supplied keys and remove_parameters deletes
    overrides. Edit existing code with write_sql. Connect takes source and target node IDs; ports
    default to result and input. Include connections in the same call when a node has required inputs;
    the resulting bundle must be valid. Set component to edit a shared component definition; omit it
    for the root flow.
    """
    snapshot = editable(ctx)
    bundle = snapshot["bundle"]
    graph = graph_for(bundle, component)
    for edit in nodes or []:
        node: dict | None = next((n for n in graph["nodes"] if n["id"] == edit.id), None)
        if isinstance(edit, AddNode):
            if node is not None:
                raise Problem("A node with this ID already exists", 409)
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
        elif isinstance(edit, RemoveNode):
            graph["nodes"].remove(node)
            graph["edges"] = [e for e in graph["edges"] if edit.id not in (e["source"], e["target"])]
            bundle.get("node_sql", {}).pop(code_path(edit.id, component, node.get("language", "sql")), None)
            continue
        if edit.label is not None:
            node["label"] = edit.label
        if edit.position is not None:
            node["position"] = edit.position.model_dump()
        node.setdefault("params", {}).update(edit.params or {})
        if isinstance(edit, UpdateNode):
            for name in edit.remove_parameters or []:
                node["params"].pop(name, None)
    for edit in edges or []:
        existing = next((e for e in graph["edges"] if e["id"] == edit.id), None)
        if isinstance(edit, DisconnectEdge):
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


@tool(needs="write")
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


@tool(needs="write", retries=2)
def write_documentation(
    ctx: RunContext[Dependencies],
    entry: Annotated[
        ProjectDocumentation | NodeDocumentation | DatasetDocumentation | ColumnDocumentation,
        Field(discriminator="section"),
    ],
) -> dict:
    """Write the README or a node, output or column description, with a commit and Undo for each change.

    Pass one entry object: {"section": ..., "text": ..., ...} with only that section's fields.
    project takes text; nodes adds node; datasets adds node and output; columns adds node, output and
    column. Use expanded node IDs and output port names.
    """
    snapshot = editable(ctx)
    bundle = snapshot["bundle"]
    docs = bundle["documentation"]
    if isinstance(entry, ProjectDocumentation):
        docs["project"] = entry.text
    else:
        find_node(bundle, entry.node)
        if isinstance(entry, NodeDocumentation):
            docs.setdefault("nodes", {})[entry.node] = entry.text
        else:
            output_port(bundle, entry.node, entry.output)
            key = f"{entry.node}:{entry.output}"
            if isinstance(entry, DatasetDocumentation):
                docs.setdefault("datasets", {})[key] = entry.text
            else:
                docs.setdefault("columns", {}).setdefault(key, {})[entry.column] = entry.text
    return save(ctx, snapshot, bundle)


@tool(needs="write", retries=2)
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


@tool(needs="write")
def group_nodes(ctx: RunContext[Dependencies], nodes: list[str], name: str, component: str = "") -> dict:
    """Group selected nodes into a reusable component using the same service as the canvas."""
    snapshot = editable(ctx)
    bundle, selected = group(snapshot["bundle"], nodes, name, parent=component or None)
    return save(ctx, snapshot, bundle, selected=selected)


@tool(needs="write", retries=2)
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
        columns = reading(ctx).output_columns(bundle, producer, port)
        if columns is not None and (unknown := unknown_fields(change.spec, columns)):
            result["unknown_fields"] = unknown
    return result
