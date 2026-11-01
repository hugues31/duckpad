"""Form parameters compile to strict SQL and survive real pipeline reruns."""

import csv
import datetime
from pathlib import Path

import duckdb
import pytest
from helpers import wait_run

from duckpad.auth import Auth
from duckpad.builtin_templates import BUILTINS
from duckpad.bundle import bundle_to_files
from duckpad.data_preparation import render_preparation
from duckpad.services import Services
from duckpad.templates import compile_template, parse_template
from duckpad.util import Problem


def compile_columns(kind, rows, schema=None):
    return compile_template(
        parse_template(BUILTINS[kind]),
        {"columns": rows},
        {"source": '"input"'},
        {"result": "out"},
        {},
        Path(),
        input_schemas={"source": schema} if schema is not None else None,
    )[0]


def test_select_names_order_types_and_quoted_identifiers():
    with duckdb.connect() as db:
        db.execute('CREATE TABLE input AS SELECT \'0042\' AS "a.b", 5 AS "a""b", 9 AS ignored')
        statement = compile_columns(
            "select_columns",
            [
                {"source": 'a"b', "name": "select"},
                {"source": "a.b", "name": 'output"; DROP TABLE input; --', "type": "BIGINT"},
            ],
        )
        result = db.execute(statement["query"])
        assert result.fetchall() == [(5, 42)]
        assert [(c[0], str(c[1])) for c in result.description] == [
            ("select", "INTEGER"),
            ('output"; DROP TABLE input; --', "BIGINT"),
        ]
        assert db.execute("SELECT count(*) FROM input").fetchone() == (1,)


def test_clean_preserves_others_and_replacement_type_and_literal_values():
    with duckdb.connect() as db:
        db.execute(
            "CREATE TABLE input AS SELECT ' 001 ' AS id, NULL::DECIMAL(12,2) AS amount, NULL::VARCHAR AS note, '31/12/2026' AS day, ' untouched ' AS other"
        )
        statement = compile_columns(
            "clean_values",
            [
                {"source": "id", "trim": True},
                {"source": "amount", "replacement": "12.50"},
                {"source": "note", "replacement": "O'Brien'; DROP TABLE input; --"},
                {"source": "day", "date_format": "%d/%m/%Y"},
            ],
        )
        result = db.execute(statement["query"])
        row = result.fetchone()
        assert row[0] == "001" and str(row[1]) == "12.50"
        assert row[2:] == ("O'Brien'; DROP TABLE input; --", datetime.date(2026, 12, 31), " untouched ")
        assert str(result.description[1][1]) == "DECIMAL(12,2)"
        assert db.execute(compile_columns("clean_values", [])["query"]).fetchone()[0] == " 001 "


@pytest.mark.parametrize("replacement", ["", "NULL", "001", "false"])
def test_text_replacements_are_never_inferred_as_sql_values(replacement):
    with duckdb.connect() as db:
        db.execute("CREATE TABLE input AS SELECT NULL::VARCHAR AS text")
        query = compile_columns("clean_values", [{"source": "text", "replacement": replacement}])["query"]
        assert db.execute(query).fetchone() == (replacement,)


def test_combined_cleaning_order_and_quoted_date_format():
    with duckdb.connect() as db:
        db.execute("CREATE TABLE input AS SELECT * FROM (VALUES (' 31/12/2026''s '), (NULL)) t(day)")
        query = compile_columns(
            "clean_values",
            [{"source": "day", "trim": True, "date_format": "%d/%m/%Y's", "replacement": "2000-01-01"}],
        )["query"]
        assert db.execute(query).fetchall() == [(datetime.date(2026, 12, 31),), (datetime.date(2000, 1, 1),)]


@pytest.mark.parametrize(
    ("kind", "rows", "message"),
    [
        ("select_columns", [], "at least one"),
        ("select_columns", "not a list", "list"),
        ("select_columns", [None], "list"),
        ("select_columns", [{"source": "id", "name": " "}], "nonempty"),
        ("select_columns", [{"source": "id", "name": "bad\x00name"}], "control"),
        ("select_columns", [{"source": "id", "name": "Key"}, {"source": "id", "name": "KEY"}], "Duplicate"),
        ("select_columns", [{"source": "removed"}], "missing"),
        ("select_columns", [{"source": "id", "type": "DECIMAL(99,2)"}], "Unsupported"),
        ("select_columns", [{"source": "id", "type": "VARCHAR); DROP TABLE input; --"}], "Unsupported"),
        ("clean_values", [{"source": "id", "trim": "false"}], "boolean"),
        ("clean_values", [{"source": "id", "date_format": ""}], "date format"),
        ("clean_values", [{"source": "id", "replacement": None}], "must be text"),
        ("clean_values", [{"source": "id", "trim": True}], "require VARCHAR"),
        ("clean_values", [{"source": "id"}, {"source": "id"}], "Duplicate"),
        ("clean_values", [{"source": "id", "unknown": True}], "Unknown"),
    ],
)
def test_invalid_settings_have_actionable_errors(kind, rows, message):
    with pytest.raises(Problem, match=message):
        compile_columns(kind, rows, [{"name": "id", "type": "INTEGER"}])


@pytest.mark.parametrize(
    ("kind", "row", "source", "error"),
    [
        ("select_columns", {"source": "value", "type": "BIGINT"}, "'bad'", "Could not convert"),
        ("clean_values", {"source": "value", "replacement": "bad"}, "NULL::BIGINT", "Could not convert"),
        ("clean_values", {"source": "value", "date_format": "%d/%m/%Y"}, "'31/02/2026'", "out of range"),
        ("clean_values", {"source": "value", "date_format": "%Q"}, "'2026'", "Unrecognized format"),
    ],
)
def test_conversion_and_date_errors_do_not_turn_into_nulls(kind, row, source, error):
    with duckdb.connect() as db:
        db.execute("CREATE TABLE input AS SELECT " + source + " AS value")
        with pytest.raises(duckdb.Error, match=error):
            db.execute(compile_columns(kind, [row])["query"])


def test_preparation_parameters_reference_declared_inputs_and_validate_types():
    with pytest.raises(Problem, match="declared input"):
        parse_template(
            BUILTINS["select_columns"].replace("column_selection(source)", "column_selection(missing)")
        )
    assert "DECIMAL(12,2)" in render_preparation(
        "column_selection", [{"source": "id", "type": "decimal(12,2)"}]
    )


@pytest.fixture(params=[False, True], ids=["embedded", "isolated"])
def preparation_services(tmp_path, request):
    instance = Services.open(tmp_path / "instance", enforce_access=request.param)
    (tmp_path / "data").mkdir()
    instance.catalog.save(
        "connection",
        {
            "id": "input_files",
            "name": "Input files",
            "connector": "folder",
            "environments": {"dev": {"root": str(tmp_path / "data")}},
        },
        create=True,
    )
    yield instance
    instance.close()


def test_save_reload_replacement_schema_change_failure_and_downstream_export(preparation_services, tmp_path):
    instance = preparation_services
    source = tmp_path / "data" / "input.csv"
    source.write_text("id,amount,day,other\n 001 ,,31/12/2026,keep\n 002 ,12,01/01/2027,also\n")
    clean = [
        {"source": "id", "trim": True},
        {"source": "amount", "replacement": "0"},
        {"source": "day", "date_format": "%d/%m/%Y"},
    ]
    selection = [
        {"source": "day", "name": "date"},
        {"source": "id", "name": "key"},
        {"source": "amount", "name": "total", "type": "BIGINT"},
    ]
    bundle = {
        "flow": {
            "nodes": [
                {
                    "id": "source",
                    "template": "load_csv",
                    "params": {"connection": "input_files", "file": "input.csv"},
                },
                {"id": "clean", "template": "clean_values", "params": {"columns": clean}},
                {"id": "select", "template": "select_columns", "params": {"columns": selection}},
                {
                    "id": "export",
                    "template": "export_csv",
                    "params": {"connection": "input_files", "destination": "output.csv"},
                },
            ],
            "edges": [
                {"id": str(i), "source": a, "sourceHandle": "result", "target": b, "targetHandle": "source"}
                for i, (a, b) in enumerate(
                    zip(["source", "clean", "select"], ["clean", "select", "export"], strict=True)
                )
            ],
        },
        "templates": {
            **BUILTINS,
            "load_csv": BUILTINS["load_csv"].replace(
                "types={{ types }}", "types={{ types }}, all_varchar=true"
            ),
        },
        "components": {},
        "documentation": {},
    }
    worktree = instance.projects.create("Data preparation", bundle)
    if instance.engine.access:
        Auth(instance.store)
        instance.engine.access.own(worktree, {"id": "admin"}, ["input_files"])
    wt = worktree["id"]
    snapshot = instance.projects.snapshot(wt)
    instance.projects.write(wt, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert instance.projects.snapshot(wt)["bundle"]["flow"]["nodes"][1]["params"]["columns"] == clean
    assert instance.projects.snapshot(wt)["bundle"]["flow"]["nodes"][2]["params"]["columns"] == selection
    run = wait_run(instance.store, instance.engine.launch(wt, "dev"), timeout=30)
    assert run["status"] == "success", run
    previous = instance.engine.preview(wt, "dev", "select")
    assert [(c["name"], c["type"]) for c in previous["columns"]] == [
        ("date", "DATE"),
        ("key", "VARCHAR"),
        ("total", "BIGINT"),
    ]
    assert [r["values"] for r in previous["rows"]] == [["2026-12-31", "001", 0], ["2027-01-01", "002", 12]]
    with (tmp_path / "data" / "output.csv").open() as file:
        assert list(csv.reader(file)) == [
            ["date", "key", "total"],
            ["2026-12-31", "001", "0"],
            ["2027-01-01", "002", "12"],
        ]
    assert "CAST" in instance.engine.compile(wt, "dev", "select")[0]["query"]
    source.write_text("id,amount,day,other\n 003 ,bad,31/12/2026,next\n")
    failed = wait_run(instance.store, instance.engine.launch(wt, "dev"), timeout=30)
    assert failed["nodes"]["select"]["status"] == "failed"
    assert "Conversions must be valid" in failed["nodes"]["select"]["error"]
    assert failed["nodes"]["export"]["status"] == "blocked"
    retained = instance.engine.preview(wt, "dev", "select")
    assert retained["rows"] == previous["rows"] and retained["status"] == "stale"
    source.write_text("id,amount,day,other\n 003 ,7,31/12/2026,next\n")
    assert wait_run(instance.store, instance.engine.launch(wt, "dev"), timeout=30)["status"] == "success"
    assert instance.engine.preview(wt, "dev", "select")["rows"][0]["values"] == ["2026-12-31", "003", 7]
    source.write_text("id,amount,changed,other\n 003 ,7,31/12/2026,next\n")
    failed = wait_run(instance.store, instance.engine.launch(wt, "dev"), timeout=30)
    assert "Source column 'day' is missing" in failed["nodes"]["clean"]["error"]
    with pytest.raises(Problem, match="missing"):
        instance.engine.compile(wt, "dev", "clean")
