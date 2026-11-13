"""Instance-wide views, offered on every page: the user's projects and the connections they can see."""

from pydantic_ai import RunContext

from ..util import Problem
from .registry import tool
from .tools import Dependencies, page


@tool
def list_projects(ctx: RunContext[Dependencies], offset: int = 0, limit: int = 20) -> dict:
    """List the projects the user can open, with the user's role and each working branch.

    Pass a branch's worktree ID as the worktree argument of a reading tool to read that branch
    instead of the open one. Editing and runs stay on the open branch.
    """
    user, _ = ctx.deps.check()
    store = ctx.deps.services.store
    branches = {}
    for worktree in store.all("worktree"):
        # Job results are internal checkouts of a Job, opened from its page.
        if not worktree.get("read_only"):
            branches.setdefault(worktree["project"], []).append(
                {"worktree": worktree["id"], "branch": worktree["branch"]}
            )
    items = [
        {"id": p["id"], "name": p["name"], "role": p["role"], "branches": branches.get(p["id"], [])}
        for p in store.visible_projects(user)
    ]
    return page(items, offset, limit)


@tool
def read_connections(
    ctx: RunContext[Dependencies],
    project: str = "",
    connection: str = "",
    details: bool = False,
    offset: int = 0,
    limit: int = 20,
) -> dict:
    """Read connections: name, family, capabilities and the projects each is granted to.

    Lists the connections of the projects the user can open; instance administrators see every
    connection. Set project to keep those granted to one project, or connection to read one by ID.
    Set details whenever the question is about a connection's settings, such as its host, path
    or database: an instance administrator then also gets the connector type and the parameter
    values by environment, secrets masked.
    """
    user, _ = ctx.deps.check()
    services = ctx.deps.services
    admin = user["role"] == "admin"
    visible = {p["id"]: p["name"] for p in services.store.visible_projects(user)}
    if project and project not in visible:
        raise Problem("Project not found. Use a project ID from list_projects.", 404)
    # Granted connections by their labels alone: no parameter is loaded for other users.
    granted, records = {}, {}
    for identity in [project] if project else visible:
        for summary in services.store.connection_summaries(identity):
            granted.setdefault(summary["id"], []).append({"id": identity, "name": visible[identity]})
            records[summary["id"]] = summary
    if admin:
        # Secrets are already masked; without a project, connections no project uses are listed too.
        records = {
            c["id"]: c for c in services.catalog.public()["connections"] if not project or c["id"] in granted
        }
    detailed = admin and details
    if detailed:
        ctx.deps.read(ctx.tool_call_id, "instance", instance=True)
    items = []
    for record in records.values():
        if connection and record["id"] != connection:
            continue
        definition = services.catalog.connector(record["connector"]) or {}
        item = {
            "id": record["id"],
            "name": record["name"],
            "family": definition.get("family"),
            "capabilities": definition.get("capabilities", []),
            "projects": granted.get(record["id"], []),
        }
        if detailed:
            item.update(connector=record["connector"], environments=record["environments"])
        items.append(item)
    if connection and not items:
        raise Problem("Connection not found", 404)
    result = {**page(items, offset, limit), "environments": services.catalog.environment_names()}
    if details and not admin:
        result["details"] = "Parameter values are visible to instance administrators only."
    return result
