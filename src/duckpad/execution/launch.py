"""Launch preparation shared by interactive worktrees and Jobs."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from ..schemas import Launch
from ..types import Record
from ..util import Problem

if TYPE_CHECKING:
    from ..services import Services


def confirm_environment(
    settings: Record,
    entry_point: str,
    confirmed: bool,
    variables: Callable[[], Record] | None = None,
) -> None:
    """Interactive runs need confirmation; API clients choose their environment explicitly."""
    if entry_point != "ui" or not settings["confirm_before_run"] or confirmed:
        return
    detail = {"confirmation_required": settings}
    if variables is not None:
        try:
            detail["variables"] = variables()
        except Problem:
            detail["variables"] = {}
    raise Problem("Confirm this environment before running", 409, detail)


def launch_worktree(services: Services, worktree: str, data: Launch, requester: Record) -> Record:
    engine = services.engine
    entry_point = "ui" if data.entry_point == "ui" else "api"
    confirm_environment(
        services.catalog.environment(data.environment),
        entry_point,
        data.confirmed,
        lambda: engine.scope_variables(worktree, data.environment, data.node, data.ancestors),
    )
    return engine.launch(
        worktree,
        data.environment,
        data.node,
        entry_point,
        requester=requester,
        partition_selection=data.partitions.model_dump(exclude_none=True) if data.partitions else None,
        partition_execution=data.partition_execution.model_dump(exclude_none=True)
        if data.partition_execution
        else None,
        ancestors=data.ancestors,
    )
