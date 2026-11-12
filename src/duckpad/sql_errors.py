"""Translate SQL failures back to the saved node's source, before instrumentation."""

import re
from difflib import SequenceMatcher

import sqlglot

from .types import Record
from .util import Problem

REFERENCE = re.compile(r"\{\{\s*(\w+)\s*\}\}")
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def source_context(block: Record, values: Record, outputs: Record | None = None) -> Record:
    return {
        "sql": block["sql"],
        "lines": block.get("source_lines", [1]),
        "column": block.get("source_column", 1),
        "relations": {
            name: value
            for name, value in {**values, **(outputs or {})}.items()
            if re.fullmatch(r'"?data_[a-f0-9]+"?', value)
        },
        "values": {name: values[name] for name in REFERENCE.findall(block["sql"])},
    }


def rendered_source(source: Record) -> tuple[str, list[int]]:
    """Each rendered character points to a character of the authored block."""
    text, offsets, start = "", [], 0
    for match in REFERENCE.finditer(source["sql"]):
        text += source["sql"][start : match.start()]
        offsets.extend(range(start, match.start()))
        value = source["values"][match[1]]
        text += value
        offsets.extend([match.start()] * len(value))
        start = match.end()
    text += source["sql"][start:]
    offsets.extend(range(start, len(source["sql"])))
    return text, offsets


def error_offset(message: str, executed: str) -> int | None:
    """Read DuckDB's caret, including its truncated single-line excerpts."""
    match = re.search(r"LINE (\d+): ([^\n]*)\n( *)\^", message)
    if not match:
        return None
    lines = executed.splitlines()
    line = int(match[1]) - 1
    if line >= len(lines):
        return None
    excerpt = match[2]
    column = len(match[3]) - len(f"LINE {match[1]}: ")
    if excerpt.startswith("..."):
        excerpt = excerpt[3:]
        column -= 3
    excerpt = excerpt.removesuffix("...")
    start = lines[line].find(excerpt)
    if start < 0:
        return None
    return sum(len(value) + 1 for value in lines[:line]) + start + max(0, column)


class SqlSourceError(Problem):
    def __init__(self, error: Exception, source: Record, executed: str, *, phase: str = "execution"):
        raw = ANSI.sub("", str(error))
        rendered, offsets = rendered_source(source)
        position = 0
        cause = error.__cause__
        if isinstance(cause, sqlglot.errors.ParseError) and cause.errors:
            detail = cause.errors[0]
            line, col = detail.get("line", 1), detail.get("col", 1)
            position = sum(len(value) + 1 for value in rendered.splitlines()[: line - 1])
            position += max(0, col - len(detail.get("highlight", "")))
            message = "Syntax error: " + (
                "incomplete expression"
                if detail["description"].startswith("Required keyword:")
                else detail["description"]
            )
        else:
            target = error_offset(raw, executed)
            message = re.split(r"\nLINE \d+:", raw)[0].strip()
            if target is not None:
                try:
                    before = sqlglot.tokenize(rendered, read="duckdb")
                    after = sqlglot.tokenize(executed, read="duckdb")
                    selected = next(
                        (i for i, token in enumerate(after) if token.start <= target <= token.end), None
                    )
                    matches = SequenceMatcher(
                        None,
                        [t.text.lower() for t in before],
                        [t.text.lower() for t in after],
                        autojunk=False,
                    )
                    for a, b, size in matches.get_matching_blocks():
                        if selected is not None and b <= selected < b + size:
                            position = before[a + selected - b].start
                            break
                except sqlglot.errors.TokenError:
                    pass
        # Replace only relations allocated for this node, including physical storage.
        for name, value in source["relations"].items():
            relation = re.escape(value.strip('"'))
            message = re.sub(r'"?' + relation + r'(?:_storage|_disk)?"?', "{{ " + name + " }}", message)
        offset = offsets[min(position, len(offsets) - 1)] if offsets else 0
        relative_line = source["sql"][:offset].count("\n")
        lines = source["lines"]
        line = lines[min(relative_line, len(lines) - 1)]
        column = offset - source["sql"].rfind("\n", 0, offset)
        if relative_line == 0:
            column += source["column"] - 1
        self.diagnostic = {
            "message": message,
            "line": line,
            "column": column,
            "executed_sql": executed,
            "phase": phase,
        }
        super().__init__(message)
