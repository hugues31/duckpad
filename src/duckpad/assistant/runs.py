"""Approved execution and bounded diagnostics over immutable run records."""

import hashlib
import json
import time

from pydantic_ai import RunContext

from .. import variables
from ..components import expand_for
from ..execution.runs import UNFINISHED_RUN_STATUSES, launch_scope
from ..graph import connection_references
from ..util import Problem
from .tools import Dependencies, page


def proposal(deps, environment="", node=""):
    """Build a reviewable launch plan; never expose connection settings or credentials."""
    deps.check(write=True)
    services, worktree = deps.services, deps.context["worktree"]
    environment = environment or deps.context["environment"]
    settings = services.catalog.environment(environment)
    snapshot = services.projects.snapshot(worktree)
    if snapshot["bundle"] is None:
        raise Problem("Project files are invalid; correct them before execution", 422)
    nodes, edges, _ = expand_for(snapshot["bundle"], environment)
    scope = launch_scope(nodes, edges, node or None)
    references = sorted({ref for key in scope for ref in connection_references(nodes[key])})
    services.engine.access.connections(deps.context["project"], references)
    exports = [
        {"node": key, "label": nodes[key].get("label", key), "connections": connection_references(nodes[key])}
        for key in sorted(scope)
        if nodes[key]["parsed"]["kind"] == "export"
    ]
    # Bind approval to definitions and effective configuration, including secret changes,
    # without storing those secrets in the conversation or sending them to the provider.
    configuration, _ = services.catalog.capture(references, environment)
    signature = hashlib.sha256(
        json.dumps([snapshot["files"], settings, configuration], sort_keys=True).encode()
    ).hexdigest()
    return deps.safe(
        {
            "environment": environment,
            "node": node,
            "scope": node or "project",
            "node_count": len(scope),
            "confirm_before_run": settings["confirm_before_run"],
            "variables": variables.used(snapshot["bundle"], nodes, scope, environment),
            "exports": exports,
            "signature": signature,
            "decision": None,
        }
    )


def launch_run(ctx: RunContext[Dependencies], environment: str = "", node: str = "") -> dict:
    """Propose a run in an environment, for a node (and its inputs) or the entire flow.

    Always requires explicit approval in chat. Exports and external writes cannot be undone.
    An empty environment uses the current page environment; an empty node runs the whole flow.
    """
    ctx.deps.check(write=True)
    if not ctx.tool_call_approved or ctx.deps.launcher is None:
        raise Problem("Explicit run approval is required", 403)
    return ctx.deps.launcher(ctx.tool_call_id, environment, node)


def run_record(deps, identity):
    deps.check()
    record = deps.services.store.get("run", identity)
    if not record or any(record[k] != deps.context[k] for k in ("worktree", "project", "branch")):
        raise Problem("Execution not found", 404)
    deps.services.engine.access.connections(deps.context["project"], list(record.get("connections", {})))
    return record


def run_summary(record):
    return {k: record.get(k) for k in ("id", "environment", "scope", "status", "entry_point", "commit")}


def cancel_run(ctx: RunContext[Dependencies], run: str) -> dict:
    """Cancel an active run on this branch. External writes already made cannot be undone."""
    ctx.deps.check(write=True)
    run_record(ctx.deps, run)
    return run_summary(ctx.deps.services.engine.cancel(run))


def wait_for_run(ctx: RunContext[Dependencies], run: str, seconds: int = 10) -> dict:
    """Wait at most 15 seconds for a run, then return its current status. Use inspect_run for errors."""
    deadline = time.monotonic() + max(0, min(15, seconds))
    while True:
        record = run_record(ctx.deps, run)
        if record["status"] not in UNFINISHED_RUN_STATUSES or time.monotonic() >= deadline:
            return run_summary(record)
        time.sleep(0.2)


def inspect_run(
    ctx: RunContext[Dependencies], run: str, node: str = "", offset: int = 0, limit: int = 20
) -> dict:
    """Read run/node errors, messages and data-test results. Values require instance data permission.

    Omit node to page through node outcomes; select a node to page through all its messages/tests.
    """
    record = run_record(ctx.deps, run)
    config = ctx.deps.configuration.get()
    details = {**run_summary(record), "has_error": bool(record.get("error"))}
    if config["allow_data"]:
        details["error"] = record.get("error")
    if node:
        state = record["nodes"].get(node)
        if state is None:
            raise Problem("Node execution not found", 404)
        details.update(node=node, node_status=state["status"], has_error=bool(state.get("error")))
        if config["allow_data"]:
            details.update(
                error=state.get("error"),
                **page(state.get("results", []), offset, min(limit, config["max_rows"])),
            )
    else:
        details.update(
            **page(
                [
                    {
                        "node": key,
                        "status": state["status"],
                        "has_error": bool(state.get("error")),
                        "duration": state.get("duration"),
                        **({"error": state.get("error")} if config["allow_data"] else {}),
                    }
                    for key, state in record["nodes"].items()
                ],
                offset,
                limit,
            )
        )
    return details


def read_run_sql(ctx: RunContext[Dependencies], run: str, node: str, offset: int = 0) -> dict:
    """Read the SQL actually executed in this run, including materialization statements.

    This is historical SQL, unlike read_sql(compiled=True), which compiles current definitions.
    """
    ctx.deps.check(data=True)
    record = run_record(ctx.deps, run)
    state = record["nodes"].get(node)
    if state is None:
        raise Problem("Node execution not found", 404)
    return page(state.get("statements", []), offset, 5)


def compare_run(ctx: RunContext[Dependencies], run: str, offset: int = 0, limit: int = 20) -> dict:
    """Compare node outcomes with the preceding successful run in the same environment and scope."""
    record = run_record(ctx.deps, run)
    user, config = ctx.deps.check()
    previous = next(
        (
            r
            for r in ctx.deps.services.store.runs(user, record["worktree"])
            if r["started"] < record["started"]
            and r["status"] == "success"
            and all(r[k] == record[k] for k in ("environment", "scope", "branch"))
        ),
        None,
    )
    if previous is None:
        return {"run": run, "previous": None}
    run_record(ctx.deps, previous["id"])
    fields = ["status", "duration", "fingerprint"]
    if config["allow_data"]:
        fields += ["error", "results"]
    items = [
        {
            "node": key,
            "before": {f: previous["nodes"].get(key, {}).get(f) for f in fields},
            "after": {f: record["nodes"].get(key, {}).get(f) for f in fields},
        }
        for key in sorted(set(record["nodes"]) | set(previous["nodes"]))
    ]
    return {"run": run, "previous": previous["id"], **page(items, offset, min(limit, config["max_rows"]))}


RUN_TOOLS = [launch_run, cancel_run]
DEBUG_TOOLS = [inspect_run, compare_run, wait_for_run]
