from pathlib import Path

import pytest

from duckpad.templates import compile_template, parse_template
from duckpad.util import Problem

EXPRESSIONS = parse_template(
    "-- @input source\n-- @param columns: expressions\n-- @output result\nSELECT {{ columns }} FROM {{ source }};"
)


@pytest.mark.parametrize(
    "sql",
    [
        "-- @param secret: secret\n-- @output result\nSELECT {{ secret }} AS x;",
        "-- @param name: text\n-- @param path: file(name)\n-- @output result\nSELECT {{ path }} AS x;",
        "-- @param path: destination(missing)\n-- @output result\nSELECT {{ path }} AS x;",
    ],
)
def test_resource_parameters_must_reference_a_connection_parameter(sql):
    with pytest.raises(Problem, match="declared connection parameter"):
        parse_template(sql)


@pytest.mark.parametrize("value", ["SUM(", "a, b FROM other_table", "a WHERE b > 1"])
def test_expression_lists_reject_invalid_sql_and_extra_clauses(value):
    with pytest.raises(Problem, match=r"(?i)expression list"):
        compile_template(
            EXPRESSIONS, {"columns": value}, {"source": '"input"'}, {"result": "out"}, {}, Path()
        )


def test_expression_lists_accept_projection_modifiers():
    statements = compile_template(
        EXPRESSIONS,
        {"columns": "l.*, SUM(amount) AS revenue"},
        {"source": '"input"'},
        {"result": "out"},
        {},
        Path(),
    )
    assert statements[0]["query"] == 'SELECT l.*, SUM(amount) AS revenue FROM "input"'
