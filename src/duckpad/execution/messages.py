"""Structured node results shared by execution checks, UI summaries and server logs."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable

from ..catalog import redact
from ..types import Record, SQLCursor
from ..util import Problem

RESULT_LIMIT = 100
LEVELS = {"info": logging.INFO, "warning": logging.WARNING, "error": logging.ERROR}
logger = logging.getLogger("duckpad.execution")


def result_counts(results: list[Record]) -> dict[str, int]:
    """Count every result, including those represented by the truncation summary."""
    counts = dict.fromkeys(LEVELS, 0)
    for result in results:
        if result.get("omitted"):
            for level, count in result["counts"].items():
                counts[level] += count
        else:
            counts[result["level"]] += 1
    return counts


def record_result(run: Record, node: str, result: Record) -> None:
    """Record an already redacted result once, preserving totals beyond the display limit.

    A result has a level, message, origin (kind, block and optional name), an optional
    output, and an optional observed value. Future checks use this same boundary.
    """
    results = run["nodes"][node]["results"]
    if len(results) < RESULT_LIMIT:
        results.append(result)
    else:
        if len(results) == RESULT_LIMIT:
            results.append(
                {
                    "level": "info",
                    "message": "",
                    "origin": {"kind": "summary"},
                    "output": None,
                    "omitted": 0,
                    "counts": dict.fromkeys(LEVELS, 0),
                }
            )
        summary = results[-1]
        summary["omitted"] += 1
        summary["counts"][result["level"]] += 1
        summary["message"] = f"… and {summary['omitted']} more"
    logger.log(
        LEVELS[result["level"]],
        json.dumps(
            {
                "event": "node_result",
                "run": run["id"],
                **{key: run[key] for key in ("project", "branch", "environment")},
                "node": node,
                **result,
            },
            ensure_ascii=True,
        ),
    )


def execute_messages(
    cursor: SQLCursor,
    statement: Record,
    run: Record,
    node: str,
    secrets: list[str],
    canceled: Callable[[], bool],
) -> str | None:
    """Validate and consume one query without retaining an unbounded set of rows."""
    block = statement["message_block"]
    schema = cursor.execute("DESCRIBE " + statement["sql"], statement["bindings"]).fetchall()
    columns = [column[0] for column in schema]
    if any(columns.count(name) != 1 for name in ("level", "message")):
        raise Problem(f"@message block {block} must return unique level and message columns")
    level_index, message_index = columns.index("level"), columns.index("message")
    cursor.execute(statement["sql"], statement["bindings"])
    failure = None
    while (row := cursor.fetchone()) is not None:
        if canceled():
            raise Problem("Execution canceled")
        level, message = row[level_index], row[message_index]
        if not isinstance(level, str) or level not in LEVELS:
            raise Problem(
                f"@message block {block}: unknown level {redact(str(level), secrets)!r}; expected info, warning or error"
            )
        if not isinstance(message, str):
            raise Problem(f"@message block {block}: message must be non-null text")
        message = redact(message, secrets)
        record_result(
            run,
            node,
            {
                "level": level,
                "message": message,
                "origin": {"kind": "message", "block": block},
                "output": statement.get("message_output"),
            },
        )
        if level == "error" and failure is None:
            failure = message
    return failure
