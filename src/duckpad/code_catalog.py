"""What the code editors suggest: the SQL and Python APIs of the server's DuckDB.

The catalog describes the DuckDB build that runs the nodes, so suggestions match
the functions, keywords and types it accepts. Extension functions appear once
their extension is part of that build.
"""

from __future__ import annotations

import gzip
import inspect
import json
import re
from functools import cache

import duckdb

from .types import Record

# Function names a user can type; operators and internal helpers are left out.
FUNCTION_NAME = re.compile(r"[a-z][a-z0-9_]*")
FUNCTION_KINDS = ("scalar", "aggregate", "window", "macro", "table", "table_macro")
# A table function with more parameters than this lists named options after its first one.
POSITIONAL_LIMIT = 4
SIGNATURES_PER_FUNCTION = 6
KEYWORD_CATEGORIES = ("reserved", "unreserved", "type_function", "column_name")
# Module functions that build expressions for relations, as nodes use them.
PYTHON_EXPRESSIONS = (
    "CaseExpression",
    "CoalesceOperator",
    "ColumnExpression",
    "ConstantExpression",
    "FunctionExpression",
    "LambdaExpression",
    "SQLExpression",
    "StarExpression",
    "col",
    "lit",
)


@cache
def code_catalog() -> Record:
    """The catalog of this server's DuckDB, computed once per process."""
    with duckdb.connect(config={"threads": 1}) as db:
        functions = db.sql(
            """
            SELECT function_name, function_type, description, examples, parameters,
                   parameter_types, varargs, return_type
            FROM duckdb_functions()
            WHERE function_type IN ?
            ORDER BY function_name, function_oid
            """,
            params=[list(FUNCTION_KINDS)],
        ).fetchall()
        keywords = db.sql(
            "SELECT keyword_name, keyword_category FROM duckdb_keywords() ORDER BY keyword_name"
        ).fetchall()
        types = db.sql(
            """
            SELECT DISTINCT upper(type_name) AS name FROM duckdb_types()
            WHERE database_name = 'system' AND type_name NOT IN ('null', 'type', 'tuple')
            ORDER BY name
            """
        ).fetchall()
    return {
        "duckdb_version": duckdb.__version__,
        "functions": sql_functions(functions),
        "keywords": [
            {"name": name.upper(), "category": category}
            for name, category in keywords
            if category in KEYWORD_CATEGORIES
        ],
        "types": [name for (name,) in types],
        "python": {
            "relation": python_members(duckdb.DuckDBPyRelation),
            "connection": python_members(duckdb.DuckDBPyConnection),
            "module": [
                member
                for member in (
                    python_member(name, getattr(duckdb, name, None)) for name in PYTHON_EXPRESSIONS
                )
                if member
            ],
        },
    }


@cache
def compressed_catalog() -> bytes:
    """The catalog as gzip-compressed JSON: about a tenth of its 350 KB."""
    return gzip.compress(json.dumps(code_catalog(), separators=(",", ":")).encode())


def sql_functions(rows) -> list[Record]:
    """One entry per function name, its overloads folded into distinct parameter lists."""
    found: dict[str, Record] = {}
    for name, kind, description, examples, parameters, types, varargs, returns in rows:
        if not FUNCTION_NAME.fullmatch(name):
            continue
        entry = found.setdefault(
            name, {"name": name, "kind": kind, "description": "", "examples": [], "signatures": []}
        )
        entry["description"] = entry["description"] or description or ""
        entry["examples"] = entry["examples"] or list(examples or [])[:2]
        parameters = list(parameters or [])
        types = (list(types or []) + [""] * len(parameters))[: len(parameters)]
        if kind == "table" and len(parameters) > POSITIONAL_LIMIT:
            options = entry.setdefault("options", {})
            for option, option_type in zip(parameters[1:], types[1:], strict=True):
                options.setdefault(option, option_type)
            parameters, types = parameters[:1], types[:1]
        signature = next(
            (s for s in entry["signatures"] if [p["name"] for p in s["parameters"]] == parameters),
            None,
        )
        if signature is None:
            signature = {
                "parameters": [{"name": p, "type": t} for p, t in zip(parameters, types, strict=True)],
                "returns": returns or "",
            }
            if varargs:
                signature["varargs"] = varargs
            entry["signatures"].append(signature)
            continue
        # Overloads that differ only by types keep the name; a type they disagree on is dropped.
        for parameter, other in zip(signature["parameters"], types, strict=True):
            if parameter["type"] != other:
                parameter["type"] = ""
        if signature["returns"] != (returns or ""):
            signature["returns"] = ""
    for entry in found.values():
        entry["signatures"] = sorted(entry["signatures"], key=lambda s: len(s["parameters"]))[
            :SIGNATURES_PER_FUNCTION
        ]
        if "options" in entry:
            entry["options"] = [{"name": n, "type": t} for n, t in sorted(entry["options"].items())]
    return list(found.values())


def python_members(owner) -> list[Record]:
    members = (python_member(name, getattr(owner, name)) for name in dir(owner) if not name.startswith("_"))
    return [member for member in members if member]


def python_member(name: str, value) -> Record | None:
    if value is None:
        return None
    if isinstance(value, property):
        return {"name": name, "kind": "property", "signature": "", "doc": summary(value.__doc__)}
    if not callable(value):
        return None
    try:
        signature = str(inspect.signature(value)).replace("(self, ", "(").replace("(self)", "()")
    except (TypeError, ValueError):
        signature = "(…)"
    kind = "class" if inspect.isclass(value) else "method"
    return {"name": name, "kind": kind, "signature": signature, "doc": summary(value.__doc__)}


def summary(doc: str | None) -> str:
    """The first paragraph of a docstring, on one line."""
    paragraph = inspect.cleandoc(doc or "").split("\n\n")[0]
    return " ".join(paragraph.split())
