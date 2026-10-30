"""Validated projection parameters for the data-preparation forms."""

import re

from .util import Problem, literal, qi

PREPARATION_TYPES = {"column_selection", "value_cleaning"}
TARGET_TYPES = {
    "VARCHAR",
    "BOOLEAN",
    "TINYINT",
    "SMALLINT",
    "INTEGER",
    "BIGINT",
    "HUGEINT",
    "FLOAT",
    "DOUBLE",
    "DATE",
    "TIMESTAMP",
    "TIMESTAMPTZ",
}


def failure_hint(types):
    """Guidance appended to the SQL error of a node whose parameters of these types prepare data."""
    preparation = set(types) & PREPARATION_TYPES
    if not preparation:
        return ""
    hint = (
        "\nCheck the configured source columns and output types. Conversions must be valid for every value."
    )
    if "value_cleaning" in preparation:
        hint += " Date text must match its format (for example %d/%m/%Y); null replacements must match the resulting type (YYYY-MM-DD for DATE)."
    return hint


def identifier(value):
    if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 for c in value):
        raise Problem("Column names must be nonempty text without control characters")
    return qi(value)


def target_type(value):
    if not isinstance(value, str):
        raise Problem("Choose a supported output data type")
    value = value.upper().strip()
    if value in TARGET_TYPES:
        return value
    decimal = re.fullmatch(r"DECIMAL\((\d+),\s*(\d+)\)", value)
    if decimal and 0 <= int(decimal[2]) <= int(decimal[1]) <= 38 and int(decimal[1]) > 0:
        return value
    raise Problem(f"Unsupported output type {value!r}; choose a listed type or DECIMAL(precision, scale)")


def render_preparation(kind, rows, schema=None):
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise Problem("Column configuration must be a list of column settings")
    selecting = kind == "column_selection"
    if selecting and not rows:
        raise Problem("Select at least one output column; use Add column or Use all columns")
    names, projections = set(), []
    available = {column["name"]: column["type"] for column in schema} if schema is not None else None
    for row in rows:
        allowed = (
            {"source", "name", "type"} if selecting else {"source", "trim", "date_format", "replacement"}
        )
        if row.keys() - allowed:
            raise Problem("Unknown column settings: " + ", ".join(sorted(row.keys() - allowed)))
        source = row.get("source")
        expression = identifier(source)
        if available is not None and source not in available:
            raise Problem(
                f"Source column {source!r} is missing. Run the upstream node and choose an available column"
            )
        name = row.get("name", source) if selecting else source
        alias = identifier(name)
        # DuckDB compares identifiers case-insensitively for ASCII letters.
        folded = name.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))
        if folded in names:
            raise Problem(f"Duplicate output column {name!r}; choose unique names (ignoring letter case)")
        names.add(folded)
        if selecting:
            if row.get("type", "") != "":
                expression = f"CAST({expression} AS {target_type(row['type'])})"
        else:
            trim = row.get("trim", False)
            date_format = row.get("date_format", "")
            if not isinstance(trim, bool) or not isinstance(date_format, str) or "\x00" in date_format:
                raise Problem(
                    f"Invalid cleaning settings for {source!r}; trim must be boolean and date format must be text"
                )
            if "date_format" in row and not date_format.strip():
                raise Problem(
                    f"Enter a date format for {source!r}, for example %d/%m/%Y, or disable date parsing"
                )
            if (trim or date_format) and available is not None and available[source] != "VARCHAR":
                raise Problem(
                    f"Column {source!r} has type {available[source]}; trim and date parsing require VARCHAR. Change its type with Select columns first"
                )
            if trim:
                expression = f"trim({expression})"
            if date_format:
                expression = f"CAST(strptime({expression}, {literal(date_format)}) AS DATE)"
            if "replacement" in row:
                replacement = row["replacement"]
                if not isinstance(replacement, str) or "\x00" in replacement:
                    raise Problem(
                        f"Null replacement for {source!r} must be text entered in the resulting column's type"
                    )
                expression = f"coalesce({expression}, cast_to_type({literal(replacement)}, {expression}))"
        projections.append(f"{expression} AS {alias}")
    if selecting:
        return ", ".join(projections)
    return "* REPLACE (" + ", ".join(projections) + ")" if projections else "*"
