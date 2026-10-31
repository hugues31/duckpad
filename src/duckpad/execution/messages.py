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
    output, and an optional observed value. Every named test is retained; only
    message rows are subject to the display limit.
    """
    results = run["nodes"][node]["results"]
    summary: Record | None = next((item for item in results if item.get("omitted")), None)
    messages = sum(item["origin"]["kind"] == "message" for item in results)
    if result["origin"]["kind"] == "test" or messages < RESULT_LIMIT:
        results.insert(len(results) - bool(summary), result)
    else:
        if summary is None:
            summary = {
                "level": "info",
                "message": "",
                "origin": {"kind": "summary"},
                "output": None,
                "omitted": 0,
                "counts": dict.fromkeys(LEVELS, 0),
            }
            results.append(summary)
        summary["omitted"] += 1
        summary["counts"][result["level"]] += 1
        summary["message"] = f"… and {summary['omitted']} more"
    if result["origin"]["kind"] == "test" and result["level"] == "info":
        return
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


def execute_test(
    cursor: SQLCursor,
    statement: Record,
    run: Record,
    node: str,
    secrets: list[str],
    canceled: Callable[[], bool],
) -> str | None:
    """Count failing rows inside DuckDB, without fetching or storing their contents."""
    row = cursor.execute(
        f'SELECT count(*) FROM ({statement["sql"]}) AS "_duckpad_test"',
        statement["bindings"],
    ).fetchone()
    if canceled():
        raise Problem("Execution canceled")
    assert row is not None
    observed = row[0]
    level = statement["test_severity"] if observed else "info"
    name = redact(statement["test_name"], secrets)
    message = f"Test {name} failed: {observed} failing rows" if observed else f"Test {name} passed"
    record_result(
        run,
        node,
        {
            "level": level,
            "status": level if observed else "ok",
            "message": message,
            "origin": {"kind": "test", "name": name},
            "output": statement.get("message_output"),
            "observed": observed,
        },
    )
    return message if level == "error" else None
