from pathlib import Path

import pytest

from duckpad.builtin_templates import BUILTINS
from duckpad.graph import connection_references
from duckpad.templates import compile_template, directives, executable_sql, parse_template
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


@pytest.mark.parametrize(
    "directive",
    ["-- @label Renamed", "--@label Renamed", "  --   @label   Renamed  ", "--@description Renamed"],
)
def test_descriptive_directives_are_recognized_in_every_form(directive):
    sql = "-- @input source\n-- @output result\nSELECT * FROM {{ source }};"
    described = directive + "\n" + sql
    assert executable_sql(described) == sql
    assert directives(described)[0] == (directive.split("@")[1].split()[0], "Renamed")
    assert parse_template(described)["blocks"] == parse_template(sql)["blocks"]


def test_directives_inside_sql_lines_are_not_directives():
    assert directives("SELECT 1 -- @input ghost\n-- @output result") == [("output", "result")]


def source(body):
    return parse_template(
        "-- @kind source\n"
        '-- @param connection: connection = "local"\n'
        '-- @param file: file(connection) = "a.csv"\n'
        '-- @param other: file(connection) = "b.csv"\n'
        '-- @param delimiter: text = ","\n'
        "-- @output result\n" + body
    )


LOCAL = {
    "local": {
        "alias": "local",
        "definition": {"family": "storage", "capabilities": ["read"]},
        "values": {"root": "/data"},
    }
}


@pytest.mark.parametrize(
    "body",
    [
        "SELECT * FROM read_csv({{ file }}, delim={{ delimiter }}, header=true, types={'id': 'INT'})",
        "SELECT * FROM read_csv([{{ file }}, {{ other }}])",
        "SELECT * FROM read_csv({{ file }}) AS a JOIN read_parquet({{ other }}) AS b USING (id)",
        "SELECT * FROM range(3)",
    ],
)
def test_source_readers_accept_declared_resources(body):
    compile_template(source(body), {}, {}, {"result": "out"}, LOCAL, Path())


@pytest.mark.parametrize(
    "body",
    [
        "SELECT * FROM read_csv([{{ file }}, '/elsewhere/other.csv'])",
        "SELECT * FROM read_csv({{ file }}, '/elsewhere/other.csv')",
        "SELECT * FROM read_csv('/elsewhere/other.csv', delim={{ file }})",
        "SELECT * FROM read_csv({{ file }} || '.bak')",
        "SELECT * FROM read_csv(files := '/elsewhere/other.csv')",
        "SELECT * FROM read_csv({{ file }}, types=(SELECT * FROM read_text('/elsewhere/secret')))",
        "SELECT * FROM read_csv({{ file }}) AS a JOIN read_csv('/elsewhere/other.csv') AS b USING (id)",
    ],
)
def test_source_readers_reject_undeclared_or_unverifiable_files(body):
    with pytest.raises(Problem, match="declared file resource parameters"):
        compile_template(source(body), {}, {}, {"result": "out"}, LOCAL, Path())


PROJECT_FILES = {"file": Path("/resources"), "destination": Path("/exports")}
FILE_TEMPLATES = ["load_csv", "load_parquet", "load_xlsx", "export_csv", "export_xlsx"]


@pytest.mark.parametrize("name", FILE_TEMPLATES)
def test_builtin_file_templates_default_to_project_files(name):
    template = parse_template(BUILTINS[name])
    [connection] = [p for p in template["parameters"] if p["type"] == "connection"]
    assert connection["default"] == ""
    node = {"parsed": template, "params": {}}
    assert connection_references(node) == []
    assert connection_references({**node, "params": {"connection": "lake"}}) == ["lake"]


@pytest.mark.parametrize(
    ("name", "params", "path"),
    [
        ("load_csv", {}, "/resources/orders.csv"),
        ("load_parquet", {"file": "inbox/customers.parquet"}, "/resources/inbox/customers.parquet"),
        ("load_xlsx", {"file": "/resources/abc_budget.xlsx"}, "/resources/abc_budget.xlsx"),
        ("load_csv", {"connection": "local"}, "/data/orders.csv"),
        ("load_csv", {"file": "s3://bucket/orders.csv"}, "s3://bucket/orders.csv"),
        ("export_csv", {}, "/exports/export.csv"),
        ("export_xlsx", {"destination": "reports/budget.xlsx"}, "/exports/reports/budget.xlsx"),
    ],
)
def test_relative_project_file_sources_resolve_under_resources_and_destinations_under_exports(
    name, params, path
):
    connections = {
        "local": {
            "alias": "local",
            "definition": {"family": "storage", "capabilities": ["read", "write"]},
            "values": {"root": "/data"},
        }
    }
    inputs = {"source": '"input"'} if name.startswith("export") else {}
    [statement] = compile_template(
        parse_template(BUILTINS[name]), params, inputs, {"result": "out"}, connections, PROJECT_FILES
    )
    assert f"'{path}'" in statement["query"]


@pytest.mark.parametrize(
    ("root", "file", "path"),
    [
        ("gs://bucket/landing/", "a.csv", "gs://bucket/landing/a.csv"),
        ("s3://bucket/landing", "inbox/a.csv", "s3://bucket/landing/inbox/a.csv"),
        ("s3://bucket/landing", "s3://other/b.csv", "s3://other/b.csv"),
        ("/srv/finance", "inbox/budget.xlsx", "/srv/finance/inbox/budget.xlsx"),
        ("", "/srv/elsewhere/a.csv", "/srv/elsewhere/a.csv"),
    ],
)
def test_storage_roots_receive_relative_paths_and_uri_roots_stay_as_written(root, file, path):
    connections = {
        "lake": {
            "alias": "lake",
            "definition": {"family": "storage", "capabilities": ["read"]},
            "values": {"root": root},
        }
    }
    [statement] = compile_template(
        parse_template(BUILTINS["load_csv"]),
        {"connection": "lake", "file": file},
        {},
        {"result": "out"},
        connections,
        PROJECT_FILES,
    )
    assert f"READ_CSV('{path}'" in statement["query"]


@pytest.mark.parametrize(
    ("root", "file", "expected"),
    [
        ("s3://bucket/landing", "inbox/{{ var.name }}.csv", "s3://bucket/landing/inbox/orders.csv"),
        ("s3://bucket/landing", "s3://bucket/other/{{ var.name }}.csv", "outside the connection root"),
        ("", "{{ var.name }}.csv", "has no root in this environment"),
    ],
)
def test_path_references_stay_under_storage_roots(root, file, expected):
    connections = {
        "lake": {
            "alias": "lake",
            "definition": {"family": "storage", "capabilities": ["read"]},
            "values": {"root": root},
        }
    }

    def compile_path():
        [statement] = compile_template(
            parse_template(BUILTINS["load_csv"]),
            {"connection": "lake", "file": file},
            {},
            {"result": "out"},
            connections,
            PROJECT_FILES,
            variables={"name": {"type": "text", "value": "orders"}},
        )
        return statement["query"]

    if expected.startswith("s3://"):
        assert f"READ_CSV('{expected}'" in compile_path()
    else:
        with pytest.raises(Problem, match=expected):
            compile_path()


def test_file_locations_need_a_storage_connection_with_a_root_for_relative_paths():
    def compile_with(definition, values, file="a.csv"):
        connection = {"alias": "conn", "definition": definition, "values": values}
        return compile_template(
            parse_template(BUILTINS["load_csv"]),
            {"connection": "conn", "file": file},
            {},
            {"result": "out"},
            {"conn": connection},
            PROJECT_FILES,
        )

    with pytest.raises(Problem, match="Connection conn is not a file storage location"):
        compile_with({"family": "database", "capabilities": ["read"]}, {"root": "/data"})
    # Relative paths never fall back to project files once a location is chosen.
    with pytest.raises(Problem, match="Connection conn has no root in this environment"):
        compile_with({"family": "storage", "capabilities": ["read"]}, {"root": ""})


def test_a_connection_without_a_value_selects_project_files():
    template = parse_template(
        "-- @kind source\n-- @param connection: connection\n-- @param file: file(connection)\n"
        "-- @output result\nSELECT * FROM read_csv({{ file }});"
    )
    [statement] = compile_template(template, {"file": "a.csv"}, {}, {"result": "out"}, {}, PROJECT_FILES)
    assert statement["query"] == "SELECT * FROM READ_CSV('/resources/a.csv')"


def test_sql_using_an_empty_connection_asks_for_one():
    with pytest.raises(Problem, match="Choose a connection for connection"):
        compile_template(
            parse_template(BUILTINS["load_table"]),
            {"connection": "", "table": "orders"},
            {},
            {"result": "out"},
            {},
            PROJECT_FILES,
        )
    with pytest.raises(Problem, match="Choose a connection for connection"):
        compile_template(
            parse_template(BUILTINS["export_oracle"]),
            {"connection": ""},
            {"source": '"input"'},
            {},
            {},
            PROJECT_FILES,
        )


def export(body, parameters='-- @param target: destination(connection) = "out.csv"\n'):
    return parse_template(
        '-- @kind export\n-- @input rows\n-- @param connection: connection = "local"\n' + parameters + body
    )


def test_downloadable_exports_are_recognized_by_their_sql():
    assert parse_template(BUILTINS["export_csv"])["download"] == {"parameter": "destination", "format": "csv"}
    assert parse_template(BUILTINS["export_xlsx"])["download"] == {
        "parameter": "destination",
        "format": "xlsx",
    }
    assert parse_template(BUILTINS["export_oracle"])["download"] is None
    assert parse_template(BUILTINS["load_csv"])["download"] is None
    assert export("COPY (SELECT id FROM {{ rows }}) TO {{ target }} (FORMAT CSV, HEADER true);")[
        "download"
    ] == {"parameter": "target", "format": "csv"}


@pytest.mark.parametrize(
    "body",
    [
        "COPY {{ rows }} TO {{ target }} (FORMAT PARQUET);",
        "COPY {{ rows }} TO {{ target }} (FORMAT {{ format }});",
        "COPY {{ rows }} TO {{ target }} (FORMAT CSV, COMPRESSION gzip);",
        "COPY {{ rows }} TO 'fixed.csv' (FORMAT CSV);",
        "INSERT INTO {{ connection }}.{{ format }} SELECT * FROM {{ rows }};",
        "COPY {{ rows }} TO {{ target }} (FORMAT CSV);\nCOPY {{ rows }} TO {{ target }} (FORMAT CSV);",
    ],
)
def test_exports_without_a_single_local_csv_or_xlsx_file_are_not_downloadable(body):
    parameters = (
        '-- @param target: destination(connection) = "out.csv"\n-- @param format: keyword(csv|parquet)\n'
    )
    assert export(body, parameters)["download"] is None


def test_schema_and_table_names_are_chosen_from_their_connection():
    with pytest.raises(Problem, match="schema must reference a declared connection parameter"):
        parse_template("-- @kind source\n-- @param schema: schema_name\n-- @output result\nSELECT 1;")
    with pytest.raises(Problem, match="table must reference a declared schema_name parameter"):
        parse_template(
            "-- @kind source\n-- @param connection: connection\n-- @param table: table_name(connection)\n"
            "-- @output result\nSELECT 1;"
        )
    template = parse_template(BUILTINS["load_table"])
    connections = {"pg": {"alias": "conn_1", "definition": {"capabilities": ["read"]}, "values": {}}}
    # One quoted name each, even with dots or quotes.
    [statement] = compile_template(
        template,
        {"connection": "pg", "schema": 'Sales "EU"', "table": "orders.2026"},
        {},
        {"result": "out"},
        connections,
        PROJECT_FILES,
    )
    assert statement["query"] == 'SELECT * FROM "conn_1"."Sales ""EU"""."orders.2026"'
    with pytest.raises(Problem, match="Choose a table for table"):
        compile_template(template, {"connection": "pg"}, {}, {"result": "out"}, connections, PROJECT_FILES)
    export = parse_template(BUILTINS["export_table"])
    assert export["download"] is None
    with pytest.raises(Problem, match="Connection pg does not support write"):
        compile_template(
            export,
            {"connection": "pg", "table": "totals"},
            {"source": '"input"'},
            {},
            connections,
            PROJECT_FILES,
        )
    connections["pg"]["definition"]["capabilities"].append("write")
    [insert] = compile_template(
        export, {"connection": "pg", "table": "totals"}, {"source": '"input"'}, {}, connections, PROJECT_FILES
    )
    assert insert["query"] == 'INSERT INTO "conn_1"."public"."totals" BY NAME SELECT * FROM "input"'
