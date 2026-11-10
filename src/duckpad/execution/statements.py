"""Shared node compilation, statement classification and staged outputs."""

from __future__ import annotations

import copy
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from .. import variables
from ..datasets import Dataset
from ..templates import compile_template
from ..types import Connections, Record, SQLCursor
from ..util import qi

if TYPE_CHECKING:
    from .launches import Execution


def compile_node(
    node: Record,
    inputs: dict[str, str],
    outputs: dict[str, str],
    captured: Connections,
    project_files: dict[str, Path],
    input_schemas: dict[str, list[dict[str, str]]] | None = None,
) -> list[Record]:
    if node.get("muted"):
        inputs = {alias: inputs[port] for alias, port in node.get("mute_inputs", {}).items()}
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


def row_count(cursor: SQLCursor, table: str) -> int:
    row = cursor.execute(f"SELECT count(*) FROM {qi(table)}").fetchone()
    assert row is not None
    return int(row[0])


def staged_dataset(
    execution: Execution,
    key: str,
    port: str,
    table: str,
    columns: list[dict[str, str]],
    storage: str,
    started: float,
    **metadata: Any,
) -> Dataset:
    return Dataset(
        id=table,
        node=key,
        port=port,
        columns=columns,
        run=execution.run["id"],
        fingerprint=execution.fingerprints[key],
        storage=storage,
        bound_values=copy.deepcopy(execution.values),
        duration=time.monotonic() - started,
        **metadata,
    )
