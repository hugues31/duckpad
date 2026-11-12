"""The assistant's tools and what a response needs to offer each of them.

A tool is a function decorated with `tool`, in any module that `service` imports. Its options
are the only place that says when it is offered and how it is called.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class ToolSpec:
    function: Callable
    # What a response needs to offer the tool:
    # - "read": nothing more than the conversation, on every page;
    # - "data": an instance that lets the assistant read result values;
    # - "run": an open branch its user can edit;
    # - "edit": the same, in a conversation that has read nothing outside its project.
    needs: Literal["read", "data", "run", "edit"] = "read"
    # Each call waits for the user's explicit approval in the chat.
    approval: bool = False
    # Corrections allowed for rejected arguments: tools whose arguments are validated by
    # operation-specific models get one more than the default.
    retries: int | None = None


TOOLS: dict[str, ToolSpec] = {}


def tool(function=None, **options):
    """Register an assistant tool under its function name."""

    def register(function):
        TOOLS[function.__name__] = ToolSpec(function, **options)
        return function

    return register(function) if function else register


def offered(*, data, run, edit):
    """The tools of a response, given what it may do beyond reading."""
    allowed = {"read": True, "data": data, "run": run, "edit": edit}
    return [spec for spec in TOOLS.values() if allowed[spec.needs]]
