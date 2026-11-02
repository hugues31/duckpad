"""Small read-only views over the same services and authorization as the HTTP API."""

import json
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai import RunContext

from .. import variables
from ..auth import Auth
from ..components import expand_for
from ..graph import connection_references
from ..node_code import code_path
from ..search import node_entries
from ..services import Services
from ..util import Problem, clean
from .config import Configuration


class PageContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: Literal[
        "home", "projects", "pipelines", "instanceSettings", "userSettings", "projectSettings", "notFound"
    ]
    tab: Literal["flow", "code", "documentation", "variables", "extensions", "history"] | None = None
    section: Literal[
        "",
        "usersPermissions",
        "ssoSettings",
        "assistant",
        "gitHosts",
        "environments",
        "connections",
        "extensions",
    ] = ""
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
    editing_snapshot: dict | None = None
    writer: Callable | None = None
    launcher: Callable | None = None

    def check(self, *, data=False, write=False):
        user = self.auth.check(self.token)
        config = self.configuration.get()
        if not config["enabled"] or config["revision"] != self.revision:
            raise Problem("Assistant settings changed. Start a new turn.", 409)
        if data and not config["allow_data"]:
            raise Problem("The assistant cannot read data", 403)
        access = self.services.engine.access
        assert access is not None
        worktree = self.context.get("worktree")
        if worktree:
            access.worktree(user, worktree, "editor" if write else "reader")
            current = self.services.projects.get(worktree)
            if current["project"] != self.context["project"] or current["branch"] != self.context["branch"]:
                raise Problem("The conversation branch changed. Start a new conversation.", 409)
            if (
                write
                and self.services.projects.git(current["path"], "symbolic-ref", "-q", "HEAD", check=False)
                != "refs/heads/" + self.context["branch"]
            ):
                raise Problem("The conversation branch changed. Start a new conversation.", 409)
        elif self.context.get("project"):
            access.require(user, self.context["project"])
        if write and not worktree:
            raise Problem("Open a project branch to edit its content", 403)
        return user, config

    def can_write(self):
        user, _ = self.check()
        access = self.services.engine.access
        assert access is not None
        worktree = self.context.get("worktree")
        # Job results are read-only for every role; their runs start from the Job.
        return (
            bool(worktree)
            and not self.services.projects.get(worktree).get("read_only")
            and access.role(user, self.context["project"]) in ("editor", "admin")
        )

    def snapshot(self):
        self.check()
        worktree = self.context.get("worktree")
        if not worktree:
            raise Problem("Open a project branch to read its content")
        if self.editing_snapshot is None:
            self.editing_snapshot = self.services.projects.snapshot(worktree, committed=True)
        return deepcopy(self.editing_snapshot)

    def results(self, *, data=False):
        self.check(data=data)
        snapshot = self.snapshot()
        environment = self.context["environment"]
        self.services.catalog.environment(environment)
        if not snapshot["bundle"]:
            raise Problem("Project files are invalid")
        nodes, _, _ = expand_for(snapshot["bundle"], environment, tolerant=False)
        references = [ref for node in nodes.values() for ref in connection_references(node)]
        # Also recheck old result reads after a grant has been revoked.
        access = self.services.engine.access
        assert access is not None
        access.connections(self.context["project"], references)
        return self.context["worktree"], environment

    def safe(self, value):
        """Redact configured credentials even if user-authored content happens to repeat one."""
        text = json.dumps(clean(value), ensure_ascii=False)
        keys = [p.get("api_key", "") for p in self.configuration.get()["providers"]]
        for key in keys:
            if key:
                text = text.replace(json.dumps(key, ensure_ascii=False)[1:-1], "[redacted]")
        return json.loads(text)


def validate_context(services, user, context: PageContext):
    value = context.model_dump()
    access = services.engine.access
    assert access is not None
    if context.project:
        access.require(user, context.project)
    if not context.worktree:
        if context.node or context.file or context.branch or context.tab or context.run:
            raise Problem("Page context requires an open working branch", 422)
        return value
    project = access.worktree(user, context.worktree)
    worktree = services.projects.get(context.worktree)
    if context.project != project or context.branch != worktree["branch"] or context.page != "pipelines":
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


def read_flow(
    ctx: RunContext[Dependencies],
    section: Literal["nodes", "edges", "components", "templates"],
    component: str = "",
    offset: int = 0,
    limit: int = 20,
) -> dict:
    """Read a page of flow nodes (including parameters and template links), edges or definitions.

    Set component to a component definition ID to inspect its inner graph.
    """
    snapshot = ctx.deps.snapshot()
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
    return ctx.deps.safe(page(items, offset, limit))


def read_file(ctx: RunContext[Dependencies], path: str, offset: int = 0) -> dict:
    """Read saved SQL, README documentation, variables, extensions or another project definition.

    Paths are project file names, never server paths. Results have a character offset for pagination.
    """
    files = ctx.deps.snapshot()["files"]
    if path not in files:
        raise Problem("Project definition file not found", 404)
    text = files[path]
    offset = max(0, offset)
    end = offset + 12000
    return ctx.deps.safe(
        {"path": path, "text": text[offset:end], "next_offset": end if end < len(text) else None}
    )


def read_sql(
    ctx: RunContext[Dependencies], node: str = "", template: str = "", compiled: bool = False, offset: int = 0
) -> dict:
    """Read the SQL of a node or template, or a page of compiled statements without executing SQL."""
    snapshot = ctx.deps.snapshot()
    bundle = snapshot["bundle"] or {}
    if compiled:
        worktree, environment = ctx.deps.results()
        return ctx.deps.safe(page(ctx.deps.services.engine.compile(worktree, environment, node), offset, 5))
    if template:
        path = f"templates/{template}.sql"
    else:
        parts = node.split("::")
        graph, parent = bundle.get("flow", {}), None
        for part in parts[:-1]:
            container = next((n for n in graph.get("nodes", []) if n["id"] == part), {})
            parent = container.get("component")
            graph = bundle.get("components", {}).get(parent, {})
        found = next((n for n in graph.get("nodes", []) if n["id"] == parts[-1]), None)
        if found is None:
            raise Problem("Node not found", 404)
        path = (
            "templates/" + found["template"] + ".sql"
            if found.get("template")
            else code_path(found["id"], parent)
        )
    return read_file(ctx, path, offset)


def read_documentation(
    ctx: RunContext[Dependencies],
    section: Literal["project", "nodes", "datasets", "columns", "variables", "files"],
    offset: int = 0,
    limit: int = 20,
) -> dict:
    """Read paginated README, descriptions, variable declarations or the available definition file names."""
    snapshot = ctx.deps.snapshot()
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
        return read_file(ctx, "README.md", offset)
    else:
        items = [
            {"id": k, "description": v} for k, v in bundle.get("documentation", {}).get(section, {}).items()
        ]
    return ctx.deps.safe(page(items, offset, limit))


def read_schemas(ctx: RunContext[Dependencies], node: str = "", offset: int = 0) -> dict:
    """Read materialized output schemas and generation IDs, without reading any row values."""
    worktree, environment = ctx.deps.results()
    context = ctx.deps.services.engine.pool.find(worktree, environment)
    if not context:
        return {"items": [], "next_offset": None}
    with context.lock:
        items = [data.public() for data in context.datasets.values() if not node or data.node == node]
    return ctx.deps.safe(page(items, offset))


def read_runs(
    ctx: RunContext[Dependencies], run: str = "", node: str = "", offset: int = 0, limit: int = 10
) -> dict:
    """Read run history, or node statuses in a run. Set both run and node to page its messages.

    Error and message text are withheld when data reading is disabled. Offset pages runs,
    nodes or messages respectively. This does not launch or cancel executions.
    """
    user, config = ctx.deps.check()
    worktree, _ = ctx.deps.results()
    store = ctx.deps.services.store
    if run:
        from .runs import run_record

        record = run_record(ctx.deps, run)
        if node:
            result = record.get("nodes", {}).get(node)
            if result is None:
                raise Problem("Node execution not found", 404)
            details = {"node": node, "status": result["status"], "has_error": bool(result.get("error"))}
            if config["allow_data"]:
                details.update(
                    error=result.get("error"),
                    **page(result.get("results", []), offset, min(limit, config["max_rows"])),
                )
            return ctx.deps.safe(details)
        items = [
            {
                "node": key,
                "status": value["status"],
                "duration": value.get("duration"),
                "has_error": bool(value.get("error")),
                "message_count": len(value.get("results", [])),
            }
            for key, value in record.get("nodes", {}).items()
        ]
    else:
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
            for r in store.runs(user, worktree)
        ]
    return ctx.deps.safe(page(items, offset, limit))


def search_project(ctx: RunContext[Dependencies], query: str, offset: int = 0, limit: int = 20) -> dict:
    """Search saved project definitions and return matching file names and bounded line excerpts."""
    files = ctx.deps.snapshot()["files"]
    if not query.strip():
        return page([])
    items = [
        {"file": path, "line": number, "text": line[:500]}
        for path, text in files.items()
        for number, line in enumerate(text.splitlines(), 1)
        if query.casefold() in line.casefold()
    ]
    return ctx.deps.safe(page(items, offset, limit))


def read_history(ctx: RunContext[Dependencies], offset: int = 0, limit: int = 20) -> dict:
    """Read a page of Git commits on the current branch only."""
    ctx.deps.snapshot()
    return ctx.deps.safe(
        ctx.deps.services.projects.versioning.history(
            ctx.deps.context["worktree"], "HEAD", max(0, offset), max(1, min(20, limit))
        )
    )


def preview_output(
    ctx: RunContext[Dependencies],
    node: str,
    port: str = "result",
    offset: int = 0,
    limit: int = 50,
    filters: dict[str, str] | None = None,
) -> dict:
    """Read a bounded page of existing output values. Never executes or launches the flow.

    Filters match column values as text. For explain_value, copy this result's top-level
    `id` into `dataset` and a `rows[].id` into `row`; do not use the node ID as the dataset.
    """
    worktree, environment = ctx.deps.results(data=True)
    maximum = ctx.deps.configuration.get()["max_rows"]
    result = ctx.deps.services.engine.preview(
        worktree, environment, node, port, max(1, min(limit, maximum)), max(0, offset), filters=filters
    )
    end = result["offset"] + len(result["rows"])
    return ctx.deps.safe(
        {
            **{
                k: result[k]
                for k in (
                    "id",
                    "node",
                    "port",
                    "columns",
                    "rows",
                    "count",
                    "filtered_count",
                    "offset",
                    "status",
                )
            },
            "next_offset": end if end < result["filtered_count"] else None,
        }
    )


def explain_value(
    ctx: RunContext[Dependencies],
    dataset: str,
    row: int,
    column: str,
    offset: int = 0,
    group: str | None = None,
    context_values: bool = False,
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
    """
    worktree, environment = ctx.deps.results(data=True)
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
        worktree,
        environment,
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
    return ctx.deps.safe(result)


READ_TOOLS = [
    read_flow,
    read_file,
    read_sql,
    read_documentation,
    read_schemas,
    read_runs,
    search_project,
    read_history,
]
DATA_TOOLS = [preview_output, explain_value]
