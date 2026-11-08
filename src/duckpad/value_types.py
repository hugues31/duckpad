"""Typed value validation and lossless SQL conversion shared with isolated workers."""

import datetime
import json
import math
import re
from decimal import Decimal

from .util import Problem

INTEGER = re.compile(r"U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)")
ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
# DuckDB folds ASCII letters in identifiers, including quoted identifiers.
IDENTIFIER_CASE = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def base_type(type_name):
    """`file(connection)` -> `file`, `list<text>` -> `list`."""
    return re.split(r"[<(]", type_name.strip())[0]


def type_argument(type_name):
    """`choice(a|b)` -> `a|b`; None without parentheses."""
    match = re.search(r"\((.*)\)", type_name)
    return (match[1] or None) if match else None


def is_date(value):
    if not isinstance(value, str) or not ISO_DATE.fullmatch(value):
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def options(type_name):
    argument = type_argument(type_name)
    return argument.split("|") if argument else []


def check_value(type_name, value):
    """Why a value does not match a variable type, or None."""
    kind = base_type(type_name)
    if kind == "text":
        valid = isinstance(value, str)
    elif kind == "identifier":
        valid = isinstance(value, str) and value.strip() != ""
    elif kind == "number":
        # Integers are exact and always finite: math.isfinite would convert them to floats,
        # which overflows beyond about 10**308.
        valid = (isinstance(value, int) and not isinstance(value, bool)) or (
            isinstance(value, float) and math.isfinite(value)
        )
    elif kind == "boolean":
        valid = isinstance(value, bool)
    elif kind == "date":
        valid = is_date(value)
    elif kind == "choice":
        valid = isinstance(value, str) and value in options(type_name)
    else:
        item = "text" if type_name == "list<text>" else "number"
        valid = isinstance(value, list) and all(check_value(item, x) is None for x in value)
    if valid:
        return None
    expected = {
        "text": "text",
        "identifier": "a non-empty identifier",
        "number": "a finite number",
        "boolean": "true or false",
        "date": "a date written YYYY-MM-DD",
        "choice": "one of " + ", ".join(options(type_name)),
    }.get(kind, "a list of " + ("text values" if type_name == "list<text>" else "numbers"))
    return f"expected {expected}, got {json.dumps(value, ensure_ascii=False, default=str)}"


def convert(type_name, duck_type, value):
    """Convert by the SQL column type, never infer it from the worker's JSON value."""
    if value is None:
        raise Problem("NULL is not a variable value")
    kind = base_type(type_name)
    sql_type = duck_type.upper()
    if kind == "list":
        match = re.fullmatch(r"(.+)\[\d*\]", sql_type)
        if not match or not isinstance(value, (list, tuple)):
            raise Problem(f"Expected {type_name}, got {duck_type}")
        return [convert("text" if type_name == "list<text>" else "number", match[1], v) for v in value]
    valid = False
    if kind in ("text", "choice", "identifier"):
        valid = sql_type == "VARCHAR" and isinstance(value, str)
    elif kind == "boolean":
        valid = sql_type == "BOOLEAN" and isinstance(value, bool)
    elif kind == "date":
        valid = sql_type in ("DATE", "VARCHAR")
        if isinstance(value, datetime.date) and not isinstance(value, datetime.datetime):
            value = value.isoformat()
    elif kind == "number":
        if INTEGER.fullmatch(sql_type):
            valid = isinstance(value, int) and not isinstance(value, bool)
        elif sql_type in ("FLOAT", "DOUBLE"):
            valid = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        elif re.fullmatch(r"DECIMAL\(\d+,\s*\d+\)", sql_type):
            decimal = Decimal(str(value))
            if decimal.is_finite():
                value = int(decimal) if decimal == decimal.to_integral_value() else float(decimal)
                valid = math.isfinite(value) and Decimal(json.dumps(value)) == decimal
    error = check_value(type_name, value) if valid else f"expected {type_name}, got {duck_type}"
    if error:
        raise Problem(error + "; use an explicit lossless cast in the producer")
    return value


def resolve_column(columns, name):
    """Resolve exactly one column using DuckDB's ASCII case-insensitive identifiers."""
    matches = [c for c in columns if c["name"].translate(IDENTIFIER_CASE) == name.translate(IDENTIFIER_CASE)]
    if len(matches) != 1:
        raise Problem(f"Column {name} is missing or ambiguous")
    return matches[0]
