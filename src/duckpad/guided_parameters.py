"""Public, schema-aware SQL parameter types; no template IDs or execution paths."""

import math
import re

import sqlglot

from .data_preparation import identifier
from .util import Problem, literal, qi

GUIDED_TYPES = {
    "conditions",
    "join_keys",
    "joined_columns",
    "group_columns",
    "measures",
    "ordering",
    "columns",
}
PAIRED_TYPES = {"join_keys", "joined_columns"}
NUMERIC = re.compile(
    r"^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|BIGNUM|FLOAT|DOUBLE|DECIMAL\b)", re.IGNORECASE
)


def input_ports(kind, argument):
    ports = [part.strip() for part in (argument or "").split(",")]
    if len(ports) != (2 if kind in PAIRED_TYPES else 1) or not all(ports):
        raise Problem(f"{kind} requires {'two input ports' if kind in PAIRED_TYPES else 'an input port'}")
    return ports


def column(name, schema):
    if name in (None, ""):
        raise Problem("Choose a column")
    quoted = identifier(name)
    if schema is not None and name not in {c["name"] for c in schema}:
        raise Problem(
            f"Source column {name!r} is missing. Run the upstream node and choose an available column"
        )
    return quoted


def column_type(name, schema):
    return next((c["type"] for c in schema or [] if c["name"] == name), "")


def rows(value, label, item=None):
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise Problem(f"{label} must be a list of settings")
    if not value and item:
        raise Problem(f"Add at least one {item}")
    return value


def fields(value, allowed):
    if not isinstance(value, dict) or value.keys() - set(allowed):
        raise Problem("Unknown or malformed guided parameter settings")


def typed_literal(value, kind):
    """Keep text as text; reject invalid numeric/Boolean comparisons before execution."""
    from .templates import VARIABLE_REFERENCE

    if value is None:
        raise Problem("Use IS NULL or IS NOT NULL to compare nulls")
    if isinstance(value, str) and VARIABLE_REFERENCE.fullmatch(value.strip()):
        # A variable is bound by DuckDB with its own type once the SQL is rendered.
        return value.strip()
    if isinstance(value, (dict, list)):
        raise Problem("A comparison value must be a scalar")
    if NUMERIC.match(kind):
        if isinstance(value, bool) or not re.fullmatch(
            r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", str(value)
        ):
            raise Problem(f"Enter a number to compare with the {kind} column")
        if not math.isfinite(float(value)):
            raise Problem("Enter a finite number")
        return str(value)
    if kind == "BOOLEAN":
        if str(value).lower() not in ("true", "false"):
            raise Problem("Enter true or false to compare with the BOOLEAN column")
        return str(value).upper()
    return literal(str(value))


def empty_group(value):
    return (
        isinstance(value, dict)
        and isinstance(value.get("conditions"), list)
        and all(empty_group(child) for child in value["conditions"])
    )


def predicate(value, schema, depth=0):
    if depth > 20:
        raise Problem("Filter groups may be nested at most 20 levels")
    if isinstance(value, dict) and "conditions" in value:
        fields(value, {"mode", "conditions"})
        mode = value.get("mode", "and")
        if mode not in ("and", "or"):
            raise Problem("Choose AND or OR for the filter group")
        # An empty group, like a group just added in the form, constrains nothing.
        children = [c for c in rows(value["conditions"], "Conditions") if not empty_group(c)]
        if not children:
            return "TRUE"
        return "(" + f" {mode.upper()} ".join(predicate(c, schema, depth + 1) for c in children) + ")"
    fields(value, {"column", "operator", "value"})
    name = value.get("column")
    source = column(name, schema)
    operator = value.get("operator", "=")
    if operator not in ("=", "!=", ">", ">=", "<", "<=", "LIKE", "IS NULL", "IS NOT NULL"):
        raise Problem("Choose a supported comparison operator")
    if operator in ("IS NULL", "IS NOT NULL"):
        return f"{source} {operator}"
    kind = column_type(name, schema)
    if operator == "LIKE" and kind and kind != "VARCHAR":
        raise Problem("LIKE requires a VARCHAR column; convert the column first")
    return f"{source} {operator} {typed_literal(value.get('value'), kind)}"


def render_guided(kind, value, schemas):
    # A SQL string is the Advanced SQL mode of every guided type.
    from .templates import expression, expression_list

    schema = schemas[0]
    if kind == "group_columns" and value == "":
        return ""
    if isinstance(value, str) and not (kind == "joined_columns" and value in ("all", "left")):
        if kind in ("conditions", "join_keys"):
            return expression(value)
        if kind == "ordering":
            try:
                tree = sqlglot.parse_one("SELECT * ORDER BY " + value, read="duckdb")
                order = tree.args.get("order")
                if not order or {k for k, v in tree.args.items() if v} - {"expressions", "order"}:
                    raise ValueError()
                for item in order.expressions:
                    expression(item.this.sql(dialect="duckdb"))
                return ", ".join(item.sql(dialect="duckdb") for item in order.expressions)
            except Exception as error:
                raise Problem("Enter a valid SQL ordering list") from error
        sql = ", ".join(expression(x) for x in expression_list(value))
        return sql + ", " if kind == "group_columns" and sql else sql
    if kind == "conditions":
        return predicate(value, schema)
    if kind in ("columns", "group_columns"):
        if not isinstance(value, list) or any(not isinstance(x, str) for x in value):
            raise Problem("Choose a list of column names")
        if len(set(value)) != len(value):
            raise Problem("Choose each column only once")
        if kind == "columns" and not value:
            raise Problem("Choose at least one column")
        sql = ", ".join(column(x, schema) for x in value)
        return sql + ", " if kind == "group_columns" and sql else sql
    if kind == "join_keys":
        pairs = []
        for row in rows(value, "Key pairs", "key pair"):
            fields(row, {"left", "right"})
            left, right = column(row.get("left"), schema), column(row.get("right"), schemas[1])
            lt, rt = column_type(row["left"], schema), column_type(row["right"], schemas[1])
            if lt and rt and lt != rt and not (NUMERIC.match(lt) and NUMERIC.match(rt)):
                raise Problem(
                    f"Join key types {lt} and {rt} differ. Convert one key with Select columns first"
                )
            pairs.append(f"l.{left} = r.{right}")
        return " AND ".join(pairs)
    if kind == "joined_columns":
        if value not in ("all", "left"):
            raise Problem("Choose all or left columns, or enter a SQL projection")
        if value == "left":
            return "l.*"
        if any(s is None for s in schemas):
            return "l.*, r.*"
        names, result = set(), []
        for side, columns in zip(("l", "r"), schemas, strict=True):
            for c in columns:
                name = c["name"]
                base = "right_" + name if name.lower() in names else name
                alias, suffix = base, 2
                while alias.lower() in names:
                    alias = f"{base}_{suffix}"
                    suffix += 1
                names.add(alias.lower())
                result.append(f"{side}.{qi(name)} AS {qi(alias)}")
        return ", ".join(result)
    if kind == "ordering":
        result = []
        for row in rows(value, "Sort columns", "sort column"):
            fields(row, {"column", "direction", "nulls"})
            direction, nulls = row.get("direction", "asc"), row.get("nulls", "last")
            if direction not in ("asc", "desc") or nulls not in ("first", "last"):
                raise Problem("Choose ASC/DESC and NULLS FIRST/LAST")
            result.append(f"{column(row.get('column'), schema)} {direction.upper()} NULLS {nulls.upper()}")
        return ", ".join(result)
    if kind == "measures":
        result, names = [], set()
        for row in rows(value, "Measures", "measure"):
            fields(row, {"function", "column", "alias"})
            fn = row.get("function", "COUNT")
            if fn not in ("SUM", "AVG", "MIN", "MAX", "COUNT", "COUNT DISTINCT"):
                raise Problem("Choose a supported aggregation function")
            source = row.get("column", "*")
            if source == "*" and fn != "COUNT":
                raise Problem("Only COUNT accepts all rows (*)")
            quoted = "*" if source == "*" else column(source, schema)
            source_type = column_type(source, schema)
            if fn in ("SUM", "AVG") and source_type and not NUMERIC.match(source_type):
                raise Problem(f"{fn} requires a numeric column; {source!r} has type {source_type}")
            alias = identifier(row.get("alias"))
            if alias.lower() in names:
                raise Problem("Measure names must be unique, ignoring letter case")
            names.add(alias.lower())
            aggregate = f"COUNT(DISTINCT {quoted})" if fn == "COUNT DISTINCT" else f"{fn}({quoted})"
            result.append(f"{aggregate} AS {alias}")
        return ", ".join(result)
    raise Problem(f"Unknown guided parameter type: {kind}")
