"""SQL operations, rather than node categories, determine access and execution."""

from pathlib import Path

import pytest

from duckpad.templates import compile_template, parse_template
from duckpad.util import Problem

FILES = {"file": Path("/resources"), "destination": Path("/exports")}


def compile_sql(sql, connections=None):
    template = parse_template(sql)
    return compile_template(
        template,
        {},
        {name: '"input_' + name + '"' for name in template["inputs"]},
        {name: "output_" + name for name in template["outputs"]},
        connections or {},
        FILES,
    )


def test_outputs_reading_external_or_no_flow_data_are_lineage_sources():
    statements = compile_sql("""-- @input rows
-- @param file: file = "orders.csv"
-- @output enriched
SELECT * FROM {{ rows }} JOIN read_csv({{ file }}) USING (id);
-- @output total
SELECT count(*) FROM {{ enriched }};
-- @output constant
SELECT * FROM (VALUES (1), (2)) t(id);
""")
    assert [s["source"] for s in statements] == [True, False, True]


def test_writing_nodes_need_write_connections_and_other_nodes_read_ones():
    connections = {"db": {"alias": "db_alias", "definition": {"capabilities": ["read"]}}}
    read = '-- @param c: connection = "db"\n-- @input rows\n-- @output result\nSELECT * FROM {{ c }}.orders;'
    write = (
        '-- @param c: connection = "db"\n-- @input rows\nINSERT INTO {{ c }}.orders SELECT * FROM {{ rows }};'
    )
    assert parse_template(write)["writes_external"]
    compile_sql(read, connections)
    with pytest.raises(Problem, match="Connection db does not support write"):
        compile_sql(write, connections)
    connections["db"]["definition"]["capabilities"] = ["write"]
    compile_sql(write, connections)
    with pytest.raises(Problem, match="Connection db does not support read"):
        compile_sql(read, connections)


@pytest.mark.parametrize(
    "sql",
    [
        "-- @output result\nSELECT * FROM other_node_connection.orders;",
        "-- @input rows\n-- @output result\nSELECT * FROM other_node_connection.input_rows;",
        "-- @input rows\nINSERT INTO {{ rows }} SELECT 1;",
        "-- @input rows\nCOPY {{ rows }} FROM '/undeclared.csv';",
        "-- @output result\nCOPY (SELECT 1) TO '/undeclared.csv';",
        '-- @param path: destination = "out.csv"\nCOPY (SELECT 1) TO {{ path }};\n-- @output result\nSELECT 1;',
        "-- @test check\nDELETE FROM data;",
        "-- @message\nINSERT INTO data SELECT 1;",
        "SELECT 1;",
    ],
)
def test_operations_cannot_bypass_declarations_or_mutate_outputs(sql):
    with pytest.raises(Problem):
        compile_sql(
            sql,
            {"other": {"alias": "other_node_connection", "definition": {"capabilities": ["read", "write"]}}},
        )


def test_terminal_controls_are_not_external_writes():
    sql = "-- @test valid\nSELECT 1 WHERE false;\n-- @message\nSELECT 'info' AS level, 'OK' AS message;"
    assert not parse_template(sql)["writes_external"]
    assert len(compile_sql(sql)) == 2
