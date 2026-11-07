"""Partition predicates and key validation shared by SQL and Python execution."""

import copy
import re

from .util import Problem, qi
from .value_types import IDENTIFIER_CASE, convert


def filter_statements(statements, node, entry, cursor=None):
    """Apply output semantics before materialization; DuckDB can push eligible filters to scans."""
    for statement in statements:
        boundary = node.get("partition_filters", {}).get(statement.get("output"))
        if not boundary:
            continue
        if entry is None:
            raise Problem("Partition values not calculated; select a key from a resolved manifest")
        column = boundary["column"]
        key = entry["key"]
        target_type = {"text": "VARCHAR", "number": "DOUBLE", "date": "DATE", "boolean": "BOOLEAN"}[
            key["type"]
        ]
        if cursor is not None:
            schema = cursor.execute("DESCRIBE " + statement["query"], statement["bindings"]).fetchall()
            matches = [
                c for c in schema if c[0].translate(IDENTIFIER_CASE) == column.translate(IDENTIFIER_CASE)
            ]
            if len(matches) != 1:
                raise Problem(f"partition_column: {column} is missing or ambiguous")
            target_type = matches[0][1]
            # Compare the round-tripped binding, never cast the scanned column.
            converted = cursor.execute(
                f"SELECT CAST($key AS {target_type})", {"key": key["value"]}
            ).fetchone()[0]
            if canonical(key["type"], target_type, converted) != key["value"]:
                raise Problem(f"partition_column: {column} cannot losslessly compare this key")
        placeholder = "dp_partition_key"
        while (
            re.search(r"\$" + re.escape(placeholder) + r"\b", statement["query"])
            or placeholder in statement["bindings"]
        ):
            placeholder += "_"
        query = f"SELECT * FROM ({statement['query']}) AS dp_partition_source WHERE {qi(column)} = CAST(${placeholder} AS {target_type})"
        statement.update(
            query=query,
            sql=query,
            partition_filter={"column": column, "binding": placeholder, "key": copy.deepcopy(key)},
        )
        statement["bindings"][placeholder] = key["value"]
    return statements


def canonical(kind, sql_type, value):
    result = convert(kind, sql_type, value)
    if kind == "number" and isinstance(result, int) and abs(result) > 2**53 - 1:
        raise Problem("Numeric partition keys must round-trip through the browser; cast this key to text")
    return result
