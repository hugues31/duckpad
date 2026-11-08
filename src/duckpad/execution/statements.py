"""Shared node compilation and statement classification."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from .. import variables
from ..templates import compile_template
from ..types import Connections, Record


def compile_node(
    node: Record,
    inputs: dict[str, str],
    outputs: dict[str, str],
    captured: Connections,
    project_files: dict[str, Path],
    input_schemas: dict[str, list[dict[str, str]]],
) -> list[Record]:
    return compile_template(
        node["parsed"],
        node.get("params", {}),
        inputs,
        outputs,
        captured,
        project_files,
        input_schemas=input_schemas,
        variables=variables.expression_values(node),
        bound=node.get("variables"),
    )


def statement_kind(statement: Record) -> Literal["tests", "messages", "exports", "output"]:
    if statement.get("test_name"):
        return "tests"
    if statement.get("message_block"):
        return "messages"
    return "output" if statement["output"] else "exports"
