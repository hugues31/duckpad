"""Small read-only views over the same services and authorization as the HTTP API.

A conversation is not tied to a page: each turn carries the page context it was sent from. A
turn's `Dependencies` hold who asks, from which page and under which instance policy; a `Branch`
is one working branch a tool call reads with that user's rights: the open one, or another the
user can open.
"""

import dataclasses
import json
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import RunContext

from .. import variables, views
from ..auth import Auth
from ..components import expand_for
from ..execution.samples import Sample
from ..graph import connection_references, reachable
from ..node_code import code_path, find_node, template_path
from ..search import node_entries
from ..services import Services
from ..util import Problem, clean
from .config import Configuration
from .registry import tool

LOST_ACCESS = "This conversation read content you can no longer open. Start a new conversation."

# One camelCase or kebab-case word, as frontend areas and route slugs are. The model reads these
# names as validated context, so they stay short and free of spaces and punctuation.
NAVIGATION_NAME = r"[a-z][A-Za-z0-9-]{0,39}"


class PageContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Navigation names describe the page; resource identifiers below determine access.
    page: str = Field(pattern=f"^{NAVIGATION_NAME}$")
    tab: str | None = Field(default=None, pattern=f"^{NAVIGATION_NAME}$")
    section: str = Field(default="", pattern=f"^({NAVIGATION_NAME})?$")
    project: str | None = None
    worktree: str = ""
    branch: str = Field(default="", max_length=255)
    node: str = Field(default="", max_length=512)
    file: str = Field(default="", max_length=512)
    environment: str = Field(default="", max_length=100)
    run: str = Field(default="", max_length=100)


@dataclass
class Dependencies:
    services: Services
    auth: Auth
    token: str
    configuration: Configuration
    revision: str
    context: dict
    writer: Callable | None = None
    launcher: Callable | None = None
    # Credentials of the settings revision; `check` fails once a newer revision is saved.
    secrets: list[str] | None = None
    # Tool calls whose result reports a failure. A successful result can also hold an "error"
    # field, such as the error of an inspected run.
    failed: set[str] = dataclasses.field(default_factory=set)
    # Worktree -> the committed files a branch had when the turn first read it, or last saved it.
    snapshots: dict[str, dict] = dataclasses.field(default_factory=dict)
    # Tool call -> what it read: branches by worktree, and "instance" for connection details.
    # Its chat card keeps these reads for later turns, sent from any page.
    reads: dict[str, dict[str, dict]] = dataclasses.field(default_factory=dict)
    # What the conversation's earlier turns read (see `recorded_reads`).
    earlier: list[dict] = dataclasses.field(default_factory=list)
    # Tool call -> the edit its user confirmed, when this response resumes after a confirmation.
    confirmed: dict[str, dict] = dataclasses.field(default_factory=dict)

    def __post_init__(self):
        if self.secrets is None:
            self.secrets = self.configuration.secrets()

    def check(self, *, data=False, write=False):
        user = self.auth.check(self.token)
        config = self.configuration.get()
        if not config["enabled"] or config["revision"] != self.revision:
            raise Problem("Assistant settings changed. Start a new turn.", 409)
        if data and not config["allow_data"]:
            raise Problem("The assistant cannot read data", 403)
        access = self.services.engine.access
        worktree = self.context.get("worktree")
        if worktree:
            access.worktree(user, worktree, "editor" if write else "reader")
            current = self.services.projects.get(worktree)
            if current["project"] != self.context["project"] or current["branch"] != self.context["branch"]:
                raise Problem("The open branch changed. Try again.", 409)
            if (
                write
                and self.services.projects.git(current["path"], "symbolic-ref", "-q", "HEAD", check=False)
                != "refs/heads/" + self.context["branch"]
            ):
                raise Problem("The open branch changed. Try again.", 409)
        elif self.context.get("project"):
            access.require(user, self.context["project"])
        if write and not worktree:
            raise Problem("Open a project branch to edit its content", 403)
        # What this turn read goes back to the provider with its next request.
        for read in {(r.get("instance"), r.get("project")): r for r in self.turn_reads()}.values():
            self.require_read(user, read)
        return user, config

    def can_write(self):
        user, _ = self.check()
        access = self.services.engine.access
        worktree = self.context.get("worktree")
        # Job results are read-only for every role; their runs start from the Job.
        return (
            bool(worktree)
            and not self.services.projects.get(worktree).get("read_only")
            and access.role(user, self.context["project"]) in ("editor", "admin")
        )

    def branch(self, worktree="", *, call=""):
        """The branch a tool call reads: the open one by default, or another its user can open.

        Access is rechecked on every call, and the read is recorded for its tool call.
        """
        user, _ = self.check()
        opened = self.context.get("worktree")
        worktree = worktree or opened
        if not worktree:
            raise Problem("No branch is open on this page. Pass a worktree ID from list_projects.", 422)
        if worktree == opened:
            project, name, environment = (self.context[k] for k in ("project", "branch", "environment"))
        else:
            try:
                project = self.services.engine.access.worktree(user, worktree)
            except Problem as error:
                if error.status != 404:
                    raise
                # The same answer for a missing branch and for a project its user cannot open.
                raise Problem("Branch not found. Use a worktree ID from list_projects.", 404) from None
            name, environment = self.services.projects.get(worktree)["branch"], self.environment()
        scope = self.reads.get(call, {}).get(worktree)
        if scope is None and call:
            scope = self.read(
                call,
                worktree,
                project=project,
                worktree=worktree,
                project_name=self.services.store.get("project", project)["name"],
                branch=name,
            )
        return Branch(self, project, worktree, name, environment, scope)

    def read(self, call, key, **scope):
        """Record what a tool call reads: a branch, or the instance as its administrator.

        The author must keep access to it (`require_read`), and an edit of a branch whose project
        the conversation has read beyond waits for the user's confirmation (`read_outside`).
        """
        return self.reads.setdefault(call, {}).setdefault(key, scope) if call else None

    def turn_reads(self):
        return [read for reads in self.reads.values() for read in reads.values()]

    def require_read(self, user, read):
        """Refuse a conversation whose author can no longer open what it read."""
        access = self.services.engine.access
        try:
            if read.get("instance"):
                access.instance_admin(user)
            if read.get("project"):
                access.require(user, read["project"])
        except Problem:
            raise Problem(LOST_ACCESS, 409) from None

    def read_outside(self):
        """Whether the conversation holds what the members of the open project may not see:
        content of another project, or connection settings read as an instance administrator.

        Text planted in what the conversation read could have that content written into the open
        branch: an edit then waits for the user's confirmation (see `editing.save`).
        """
        project = self.context.get("project")
        return any(
            read.get("instance") or read.get("project") != project
            for read in [*self.earlier, *self.turn_reads()]
        )

    def environment(self):
        """The page's environment, or the first configured one on a page that selects none."""
        names = self.services.catalog.environment_names()
        selected = self.context.get("environment")
        return selected if selected in names else names[0]

    def recheck_reads(self):
        """Recheck what earlier turns read, before their results go back to a provider.

        Results follow the connection grants of their branch. A branch deleted since is skipped
        while its project is still open to the user: its connections are unknown, and refusing it
        would block the conversation for good.
        """
        user, _ = self.check()
        for read in self.earlier:
            self.require_read(user, read)
            if read.get("results") and self.services.store.get("worktree", read["worktree"]):
                try:
                    self.branch(read["worktree"]).recheck_connections()
                except Problem:
                    raise Problem(LOST_ACCESS, 409) from None

    def safe(self, value):
        """Redact configured credentials even if user-authored content happens to repeat one.

        Tool results need no call: `guarded` redacts each of them.
        """
        text = json.dumps(clean(value), ensure_ascii=False)
        for key in self.secrets or ():
            if key:
                text = text.replace(json.dumps(key, ensure_ascii=False)[1:-1], "[redacted]")
        return json.loads(text)


@dataclass
class Branch:
    """One working branch, read with the rights its turn's user has when a tool call resolves it."""

    deps: Dependencies
    project: str
    worktree: str
    name: str
    environment: str
    # The read its tool call records.
    scope: dict | None = None

    def snapshot(self):
        """The committed files, the same for the whole turn unless the turn saves the branch."""
        snapshots = self.deps.snapshots
        if self.worktree not in snapshots:
            snapshots[self.worktree] = self.deps.services.projects.snapshot(self.worktree, committed=True)
        return deepcopy(snapshots[self.worktree])

    def require_results(self, *, data=False):
        """Admit a read of the results the branch retains in its environment: their schemas and
        compiled SQL, or with `data` their values."""
        self.deps.check(data=data)
        snapshot = self.snapshot()
        self.deps.services.catalog.environment(self.environment)
        if not snapshot["bundle"]:
            raise Problem("Project files are invalid")
        nodes, _, _ = expand_for(snapshot["bundle"], self.environment, tolerant=False)
        self.require_connections(nodes)
        if self.scope is not None:
            self.scope["results"] = True

    def recheck_connections(self):
        """Recheck the grants of the connections the branch references, before earlier tool
        results go back to a provider.

        A broken project must not block the conversation that helps repair it: the expansion is
        tolerant, and files that form no bundle reference no connection.
        """
        bundle = self.snapshot()["bundle"]
        if bundle:
            self.deps.services.catalog.environment(self.environment)
            self.require_connections(expand_for(bundle, self.environment, tolerant=True)[0])

    def output_columns(self, bundle, node, port):
        """The column names of an expanded output in the branch's environment, from schema metadata only.

        None when the output was never run there or its rows come from a connection that is not
        granted. Errors elsewhere in the flow do not matter.
        """
        services = self.deps.services
        try:
            services.catalog.environment(self.environment)
            nodes, edges, _ = expand_for(bundle, self.environment, tolerant=True)
            lineage = reachable({node}, edges, upstream=True)
            self.require_connections({k: v for k, v in nodes.items() if k in lineage})
        except Problem:
            return None
        context = services.engine.pool.find(self.worktree, self.environment)
        if not context:
            return None
        with context.lock:
            dataset = context.outputs.get(node, {}).get(port)
            return {column["name"] for column in dataset.columns} if dataset else None

    def require_connections(self, nodes):
        # Also recheck old result reads after a grant has been revoked.
        self.require_grants([ref for node in nodes.values() for ref in connection_references(node)])

    def require_grants(self, references):
        """Refuse results that come through a connection the branch's project is not granted.

        On the open branch the refusal ends the turn, as a lost permission does. Elsewhere the
        tool call reports it and the turn continues.
        """
        try:
            self.deps.services.engine.access.connections(self.project, references)
        except Problem:
            if self.worktree == self.deps.context.get("worktree"):
                raise
            raise Problem(
                "This branch uses a connection that is not granted to its project: "
                "its results cannot be read.",
                409,
            ) from None


def reading(ctx, worktree=""):
    """The branch a reading tool call names, or the open one."""
    return ctx.deps.branch(worktree, call=ctx.tool_call_id)


def recorded_reads(turns):
    """What the tool calls of a conversation's turns read, each once."""
    reads = {}
    for turn in turns:
        for card in turn.get("tools", []):
            for read in card.get("reads", []):
                reads[json.dumps(read, sort_keys=True)] = read
    return list(reads.values())


def validate_context(services, user, context: PageContext):
    value = context.model_dump()
    access = services.engine.access
    if context.project:
        access.require(user, context.project)
    if not context.worktree:
        if context.node or context.file or context.branch or context.tab or context.run:
            raise Problem("Page context requires an open working branch", 422)
        # These pages show no result: an environment that no longer exists selects none.
        if context.environment not in services.catalog.environment_names():
            value["environment"] = ""
        if context.project:
            value["project_name"] = services.store.get("project", context.project)["name"]
        return value
    project = access.worktree(user, context.worktree)
    worktree = services.projects.get(context.worktree)
    if context.project != project or context.branch != worktree["branch"]:
        raise Problem("Page context does not match the working branch", 422)
    services.catalog.environment(context.environment)
    if context.run:
        run = services.store.get("run", context.run)
        if not run or any(run[k] != value[k] for k in ("project", "worktree", "branch", "environment")):
            raise Problem("Execution not found", 404)
    snapshot = services.projects.snapshot(context.worktree, committed=True)
    if context.node:
        entries = node_entries(snapshot["bundle"] or {})
        match = next((n for n in entries if "::".join([*n["path"], n["node"]]) == context.node), None)
        if match is None and context.run:
            match = services.store.get("run", context.run)["nodes"].get(context.node)
        if match is None:
            raise Problem("The selected node does not exist", 422)
        value["node_name"] = match["label"]
    if context.file and context.file not in snapshot["files"]:
        raise Problem("The open file does not exist", 422)
    value["project_name"] = services.store.get("project", project)["name"]
    return value


def page(items, offset=0, limit=20):
    offset, limit = max(0, offset), max(1, min(50, limit))
    values = list(items)
    selected = values[offset : offset + limit]

    # Bound nested strings/collections too: flow parameters and diagnostics can be large.
    def compact(value, depth=0):
        if isinstance(value, str):
            return value if len(value) <= 2000 else value[:2000] + "… [truncated; read the file for more]"
        if depth > 8:
            return "[nested content; read the file for more]"
        if isinstance(value, dict):
            return {k: compact(v, depth + 1) for k, v in list(value.items())[:50]}
        if isinstance(value, list):
            return [compact(v, depth + 1) for v in value[:50]]
        return value

    selected = [compact(v) for v in selected]
    while len(json.dumps(selected, default=str)) > 16000 and len(selected) > 1:
        selected.pop()
    end = offset + len(selected)
    return {"items": selected, "total": len(values), "next_offset": end if end < len(values) else None}


@tool
def read_flow(
    ctx: RunContext[Dependencies],
    section: Literal["nodes", "edges", "components", "templates"],
    component: str = "",
    offset: int = 0,
    limit: int = 20,
    worktree: str = "",
) -> dict:
    """Read a page of flow nodes (including parameters and template links), edges or definitions.

    Set component to a component definition ID to inspect its inner graph.
    """
    snapshot = reading(ctx, worktree).snapshot()
    bundle = snapshot["bundle"] or {}
    graph = bundle.get("components", {}).get(component, {}) if component else bundle.get("flow", {})
    if section in ("nodes", "edges"):
        items = graph.get(section, [])
    elif section == "components":
        items = [
            {"id": k, **{f: v.get(f) for f in ("name", "description", "inputs", "outputs", "parameters")}}
            for k, v in bundle.get("components", {}).items()
        ]
    else:
        items = [{"id": k} for k in bundle.get("templates", {})]
    return page(items, offset, limit)


@tool
def read_file(ctx: RunContext[Dependencies], path: str, offset: int = 0, worktree: str = "") -> dict:
    """Read saved SQL, README documentation, variables, extensions or another project definition.

    Paths are project file names, never server paths. Results have a character offset for pagination.
    """
    files = reading(ctx, worktree).snapshot()["files"]
    if path not in files:
        raise Problem("Project definition file not found", 404)
    text = files[path]
    offset = max(0, offset)
    end = offset + 12000
    return {"path": path, "text": text[offset:end], "next_offset": end if end < len(text) else None}


@tool
def read_sql(
    ctx: RunContext[Dependencies],
    node: str = "",
    template: str = "",
    compiled: bool = False,
    offset: int = 0,
    worktree: str = "",
) -> dict:
    """Read saved SQL/Python code, or compiled SQL statements, without executing project code."""
    branch = reading(ctx, worktree)
    if compiled:
        branch.require_results()
        return page(ctx.deps.services.engine.compile(branch.worktree, branch.environment, node), offset, 5)
    if template:
        path = template_path(template)
    else:
        bundle = branch.snapshot()["bundle"]
        if bundle is None:
            raise Problem("Project files are invalid. Read their definition files with read_file.", 422)
        found, parent = find_node(bundle, node)
        if found.get("component"):
            raise Problem("This node is a component instance. Read the nodes of its component.", 422)
        path = (
            template_path(found["template"])
            if found.get("template")
            else code_path(found["id"], parent, found.get("language", "sql"))
        )
    return read_file(ctx, path, offset, worktree)


@tool
def read_documentation(
    ctx: RunContext[Dependencies],
    section: Literal["project", "nodes", "datasets", "columns", "variables", "files"],
    offset: int = 0,
    limit: int = 20,
    worktree: str = "",
) -> dict:
    """Read project README, descriptions, variable declarations or definition file names.

    For Duckpad syntax and product help use read_guide instead. Use read_variables to page a
    particular variable's usages before deleting it or changing its bindings.
    """
    snapshot = reading(ctx, worktree).snapshot()
    bundle = snapshot["bundle"] or {}
    if section == "files":
        items = [{"path": p} for p in snapshot["files"]]
    elif section == "variables":
        items = [
            {"name": k, **v}
            for k, v in variables.summary(bundle, ctx.deps.services.catalog.environment_names())[
                "declarations"
            ].items()
        ]
    elif section == "project":
        return read_file(ctx, "README.md", offset, worktree)
    else:
        items = [
            {"id": k, "description": v} for k, v in bundle.get("documentation", {}).get(section, {}).items()
        ]
    return page(items, offset, limit)


def variable_usages(bundle):
    """Variable name -> its node bindings (whole parameters, expressions, paths) and saved view filters."""
    found = variables.usages(bundle)
    for output, saved in views.declarations(bundle).items():
        for view in saved:
            for name in variables.expression_references(view.get("filter", "")):
                found.setdefault(name, []).append(
                    {"output": output, "view": view["name"], "file": "views.json"}
                )
    return found


@tool
def read_variables(
    ctx: RunContext[Dependencies],
    name: str = "",
    section: Literal["declarations", "usages"] = "declarations",
    offset: int = 0,
    limit: int = 20,
    worktree: str = "",
) -> dict:
    """Read variable definitions, configured values by environment, or a page of references.

    Set name to inspect one variable. section=usages requires name and lists node bindings,
    expressions, file/destination paths and saved result-view filters, including undeclared names.
    Declarations include diagnostics and usage_count. Computed values are not read or executed.
    """
    bundle = reading(ctx, worktree).snapshot()["bundle"]
    if bundle is None:
        raise Problem("Project files are invalid", 422)
    if section == "usages":
        if not name:
            raise Problem("Choose a variable to inspect its usages", 422)
        return page(variable_usages(bundle).get(name, []), offset, limit)
    summary = variables.summary(bundle, ctx.deps.services.catalog.environment_names())
    if name and name not in summary["declarations"]:
        raise Problem("Variable not found", 404)
    used = variable_usages(bundle)
    items = [
        {
            "name": key,
            "definition": bundle["variables"][key],
            **{k: definition[k] for k in ("values", "errors", "warnings")},
            "usage_count": len(used.get(key, [])),
        }
        for key, definition in summary["declarations"].items()
        if not name or key == name
    ]
    return {**page(items, offset, limit), "file_error": summary["file_error"]}


@tool
def read_schemas(ctx: RunContext[Dependencies], node: str = "", offset: int = 0, worktree: str = "") -> dict:
    """Read materialized output schemas and generation IDs, without reading any row values."""
    branch = reading(ctx, worktree)
    branch.require_results()
    context = ctx.deps.services.engine.pool.find(branch.worktree, branch.environment)
    if not context:
        return {"items": [], "next_offset": None}
    with context.lock:
        items = [data.public() for data in context.datasets.values() if not node or data.node == node]
    return page(items, offset)


@tool
def read_runs(ctx: RunContext[Dependencies], offset: int = 0, limit: int = 10, worktree: str = "") -> dict:
    """Read a page of a branch's run history, newest first: IDs, status, scope and timing.

    Use inspect_run for a run's node outcomes, errors and messages. This does not launch or
    cancel executions.
    """
    branch = reading(ctx, worktree)
    user, _ = ctx.deps.check()
    items = [
        {
            k: r.get(k)
            for k in (
                "id",
                "environment",
                "scope",
                "entry_point",
                "status",
                "started",
                "finished",
                "duration",
                "commit",
            )
        }
        for r in ctx.deps.services.store.runs(user, branch.worktree, summary=True)
    ]
    return page(items, offset, limit)


@tool
def search_project(
    ctx: RunContext[Dependencies], query: str, offset: int = 0, limit: int = 20, worktree: str = ""
) -> dict:
    """Search a branch's saved definitions and return matching file names and bounded line excerpts."""
    files = reading(ctx, worktree).snapshot()["files"]
    if not query.strip():
        return page([])
    items = [
        {"file": path, "line": number, "text": line[:500]}
        for path, text in files.items()
        for number, line in enumerate(text.splitlines(), 1)
        if query.casefold() in line.casefold()
    ]
    return page(items, offset, limit)


@tool
def read_history(ctx: RunContext[Dependencies], offset: int = 0, limit: int = 20, worktree: str = "") -> dict:
    """Read a page of the Git commits of one branch only."""
    branch = reading(ctx, worktree)
    return ctx.deps.services.projects.versioning.history(
        branch.worktree, "HEAD", max(0, offset), max(1, min(20, limit))
    )


@tool(needs="data")
def preview_output(
    ctx: RunContext[Dependencies],
    node: str,
    port: str = "result",
    offset: int = 0,
    limit: int = 50,
    filter: str = "",
    worktree: str = "",
) -> dict:
    """Read a bounded page of existing output values. Never executes or launches the flow.

    The filter is one SQL condition on output columns. For explain_value, copy this result's top-level
    `id` into `dataset` and a `rows[].id` into `row`; do not use the node ID as the dataset.
    """
    branch = reading(ctx, worktree)
    branch.require_results(data=True)
    maximum = ctx.deps.configuration.get()["max_rows"]
    result = ctx.deps.services.engine.preview(
        branch.worktree,
        branch.environment,
        node,
        port,
        max(1, min(limit, maximum)),
        max(0, offset),
        sample=Sample(filter=filter),
    )
    end = result["offset"] + len(result["rows"])
    return {
        **{
            k: result[k]
            for k in ("id", "node", "port", "columns", "rows", "count", "filtered_count", "offset", "status")
        },
        "next_offset": end if end < result["filtered_count"] else None,
    }


@tool(needs="data")
def explain_value(
    ctx: RunContext[Dependencies],
    dataset: str,
    row: int,
    column: str,
    offset: int = 0,
    group: str | None = None,
    context_values: bool = False,
    worktree: str = "",
) -> dict:
    """Explain a value using its materialized generation and row ID. Follow contributions recursively.

    Contributions are paginated; this never runs project SQL or reopens source connections.

    Args:
        dataset: Exact generation ID from preview_output.id or a contribution's dataset
            (starts with data_). Never a node ID, port, region or table name.
        row: Stable rows[].id from preview_output or row ID from a contribution, not a page offset.
        column: Exact output column name to explain.
        offset: Contribution page offset, starting at zero.
        group: Only an exact groups[].key returned by an earlier distinct_groups explanation.
            Leave unset for the first call and for ordinary aggregates such as SUM.
        context_values: Include values that influenced row selection when available.
        worktree: The worktree passed to the preview_output call that returned the dataset.
    """
    branch = reading(ctx, worktree)
    branch.require_results(data=True)
    if not dataset.startswith("data_"):
        raise Problem("Use the exact generation ID from preview_output.id as dataset, not the node ID.")
    if group is not None:
        try:
            json.loads(group)
        except ValueError:
            raise Problem(
                "Use an exact groups[].key returned by explain_value, or leave group unset."
            ) from None
    result = ctx.deps.services.lineage.explain(
        branch.worktree,
        branch.environment,
        dataset,
        row,
        column,
        max(0, offset),
        group=group,
        context_values=context_values,
        page_size=ctx.deps.configuration.get()["max_rows"],
    )
    remaining = ctx.deps.configuration.get()["max_rows"]
    for field in ("contributions", "groups", "context"):
        if field in result:
            result[field] = result[field][:remaining]
            remaining -= len(result[field])
    result["page_size"] = min(5, ctx.deps.configuration.get()["max_rows"])
    return result
