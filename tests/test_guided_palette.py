"""The palette compiles through the same public template contract as custom nodes."""

import copy
from pathlib import Path

import duckdb
import pytest
from helpers import pipeline

from duckpad.builtin_templates import BUILTINS, add_builtins
from duckpad.guided_parameters import render_guided
from duckpad.templates import compile_template, parse_template
from duckpad.util import Problem


@pytest.fixture
def db():
    with duckdb.connect() as connection:
        connection.execute("""CREATE TABLE input AS SELECT * FROM (VALUES
            (1, 1, 'North', 10, 'Web'), (2, 1, 'North', 20, 'Retail'),
            (3, 2, 'South', 20, 'Web'), (4, NULL, 'South', NULL, 'Retail')
            ) t(order_id, customer_id, region, amount, channel)""")
        connection.execute(
            "CREATE TABLE customers AS SELECT * FROM (VALUES (1, 'A'), (1, 'B'), (3, 'C'), (NULL, 'D')) t(customer_id, region)"
        )
        yield connection


def schema(db, table):
    return [{"name": c[0], "type": c[1]} for c in db.execute(f'DESCRIBE "{table}"').fetchall()]


def compile_node(db, name, params=None, directory=None):
    template = parse_template(BUILTINS[name])
    inputs = {port: '"customers"' if port == "right" else '"input"' for port in template["inputs"]}
    return compile_template(
        template,
        params or {},
        inputs,
        {"result": "out"},
        {},
        {"file": directory or Path(), "destination": directory or Path()},
        input_schemas={port: schema(db, table.strip('"')) for port, table in inputs.items()},
    )[0]


def execute(db, name, params=None, directory=None):
    statement = compile_node(db, name, params, directory)
    return db.execute(statement["sql"], statement["bindings"])


ORDER = [{"column": "order_id", "direction": "asc", "nulls": "last"}]


@pytest.mark.parametrize("name", BUILTINS)
def test_every_builtin_declares_a_dedicated_icon_and_description(name):
    template = parse_template(BUILTINS[name])
    assert template["icon"] and template["description"]


def test_join_keys_nulls_duplicate_rows_types_and_output_name_collisions(db):
    params = {"condition": [{"left": "customer_id", "right": "customer_id"}], "join_type": "full"}
    result = execute(db, "join", params)
    names = [c[0] for c in result.description]
    assert names == [
        "order_id",
        "customer_id",
        "region",
        "amount",
        "channel",
        "right_customer_id",
        "right_region",
    ]
    rows = result.fetchall()
    assert len(rows) == 8  # Four matched rows, two unmatched left, two unmatched right.
    assert sum(r[1] is None and r[5] is None for r in rows) == 2
    params["condition"].append({"left": "region", "right": "region"})
    assert len(execute(db, "join", params).fetchall()) == 8  # No pair satisfies both keys.
    params["condition"] = [{"left": "customer_id", "right": "region"}]
    with pytest.raises(Problem, match=r"types.*differ"):
        execute(db, "join", params)
    db.execute("ALTER TABLE input ADD COLUMN right_region VARCHAR")
    result = execute(db, "join", {"condition": [{"left": "customer_id", "right": "customer_id"}]})
    assert result.description[-1][0] == "right_region_2"


def test_nested_filters_keep_text_literals_and_null_checks(db):
    predicate = {
        "mode": "and",
        "conditions": [
            {
                "mode": "or",
                "conditions": [
                    {"column": "amount", "operator": ">", "value": "10"},
                    {"column": "amount", "operator": "IS NULL"},
                ],
            },
            {"column": "region", "operator": "=", "value": "South"},
        ],
    }
    assert [r[0] for r in execute(db, "filter", {"condition": predicate}).fetchall()] == [3, 4]
    predicate = {"column": "channel", "operator": "=", "value": "Web' OR TRUE --"}
    assert execute(db, "filter", {"condition": predicate}).fetchall() == []
    assert len(execute(db, "filter").fetchall()) == 4
    # A group just added in the form constrains nothing until it has a condition.
    assert len(execute(db, "filter", {"condition": {"mode": "or", "conditions": []}}).fetchall()) == 4
    nested = {"mode": "and", "conditions": [{"column": "region", "operator": "=", "value": "South"}]}
    nested["conditions"].append({"mode": "or", "conditions": [{"mode": "and", "conditions": []}]})
    assert [r[0] for r in execute(db, "filter", {"condition": nested}).fetchall()] == [3, 4]
    with pytest.raises(Problem, match=r"^condition: Enter a number"):
        execute(db, "filter", {"condition": {"column": "amount", "operator": "=", "value": "bad"}})
    with pytest.raises(Problem, match=r"^key: Choose a column"):
        execute(db, "sample", {"key": ""})


def test_grouped_and_global_aggregates_and_empty_input(db):
    measures = [
        {"function": "SUM", "column": "amount", "alias": "revenue"},
        {"function": "COUNT DISTINCT", "column": "customer_id", "alias": "customers"},
    ]
    assert sorted(execute(db, "aggregate", {"groups": ["region"], "measures": measures}).fetchall()) == [
        ("North", 30, 1),
        ("South", 20, 1),
    ]
    assert execute(db, "aggregate", {"measures": measures}).fetchall() == [(50, 2)]
    db.execute("DELETE FROM input")
    assert execute(db, "aggregate").fetchall() == [(0,)]
    assert execute(db, "aggregate", {"measures": measures}).fetchall() == [(None, 0)]
    assert execute(db, "aggregate", {"groups": ["region"]}).fetchall() == []


def test_sort_and_deduplication_select_first_ordered_row_including_null_keys(db):
    assert [
        r[0]
        for r in execute(
            db, "sort", {"order": [{"column": "amount", "direction": "desc", "nulls": "first"}, *ORDER]}
        ).fetchall()
    ] == [4, 2, 3, 1]
    params = {"keys": ["customer_id"], "order": [{"column": "order_id", "direction": "desc"}]}
    assert sorted(r[0] for r in execute(db, "deduplicate", params).fetchall()) == [2, 3, 4]


def test_calculate_pivot_and_unpivot_null_retention(db):
    assert execute(db, "calculate").fetchone()[-1] == 12
    pivot = execute(db, "pivot").fetchall()
    assert sorted(pivot) == [("North", 10, 20, None), ("South", 20, None, None)]
    db.execute(
        "CREATE OR REPLACE TABLE input AS SELECT 'North' AS region, 10 AS Web, NULL::INTEGER AS Retail"
    )
    assert execute(db, "unpivot", {"columns": ["Web", "Retail"]}).fetchall() == [
        ("North", "Web", 10),
        ("North", "Retail", None),
    ]


def test_union_alignment_missing_columns_duplicates_and_incompatible_types(db):
    rows = execute(db, "union").fetchall()
    assert len(rows) == 8
    assert (None, 1, "A", None, None) in rows
    db.execute("CREATE OR REPLACE TABLE customers AS SELECT * FROM input")
    assert len(execute(db, "union", {"mode": "BY NAME"}).fetchall()) == 4
    assert len(execute(db, "union", {"mode": "ALL"}).fetchall()) == 8
    db.execute("CREATE OR REPLACE TABLE customers AS SELECT {'a': 1} AS order_id")
    with pytest.raises(duckdb.Error):
        execute(db, "union")
    with pytest.raises(duckdb.Error):
        execute(db, "union", {"mode": "ALL"})


def test_sampling_is_reproducible_across_input_order_and_checks_bounds(db):
    db.execute("CREATE OR REPLACE TABLE input AS SELECT range AS order_id FROM range(1000)")
    selected = {r[0] for r in execute(db, "sample", {"percent": 50}).fetchall()}
    assert 400 < len(selected) < 600
    db.execute("CREATE OR REPLACE TABLE input AS SELECT * FROM input ORDER BY order_id DESC")
    assert {r[0] for r in execute(db, "sample", {"percent": 50}).fetchall()} == selected
    assert {r[0] for r in execute(db, "sample", {"percent": 50, "seed": "43"}).fetchall()} != selected
    assert len(execute(db, "sample", {"percent": 100}).fetchall()) == 1000
    assert execute(db, "sample", {"percent": 0}).fetchall() == []
    with pytest.raises(duckdb.Error, match="between 0 and 100"):
        execute(db, "sample", {"percent": 101})


def test_rank_ties_and_running_total_row_frame(db):
    db.execute("UPDATE input SET amount = 20 WHERE order_id = 1")
    ranks = execute(db, "rank", {"order": [{"column": "amount", "direction": "desc"}]}).fetchall()
    assert {r[0]: r[-1] for r in ranks} == {1: 1, 2: 1, 3: 1, 4: 2}
    totals = execute(db, "running_total", {"order": ORDER}).fetchall()
    assert {r[0]: r[-1] for r in totals} == {1: 20, 2: 40, 3: 20, 4: 20}


def test_parquet_export_is_downloadable_and_preserves_types_and_nulls(db, tmp_path):
    assert parse_template(BUILTINS["export_parquet"])["download"] == {
        "parameter": "destination",
        "format": "parquet",
    }
    execute(db, "export_parquet", directory=tmp_path)
    assert (
        db.execute("SELECT * FROM read_parquet(?)", [str(tmp_path / "export.parquet")]).fetchall()
        == db.execute("SELECT * FROM input").fetchall()
    )
    assert compile_node(db, "export_parquet", directory=tmp_path)["export_file"]["format"] == "parquet"


@pytest.mark.parametrize(
    ("name", "params"),
    [
        ("sort", {"order": ORDER}),
        ("deduplicate", {"keys": ["customer_id"], "order": ORDER}),
        ("calculate", {}),
        ("pivot", {}),
        ("unpivot", {"columns": ["order_id", "amount"]}),
        ("sample", {}),
        ("rank", {"order": ORDER}),
        ("running_total", {"order": ORDER}),
    ],
)
def test_new_transformations_accept_empty_input(db, name, params):
    db.execute("DELETE FROM input")
    assert execute(db, name, params).fetchall() == []


@pytest.mark.parametrize(
    ("kind", "value", "message"),
    [
        ("columns", [], "at least one"),
        ("columns", ["missing"], "missing"),
        ("join_keys", [], "at least one"),
        ("ordering", [{"column": "amount", "direction": "DROP"}], "ASC/DESC"),
        ("measures", [{"function": "SUM", "column": "region", "alias": "n"}], "numeric"),
        ("measures", [{"function": "SUM", "column": "*", "alias": "n"}], "Only COUNT"),
        (
            "measures",
            [
                {"function": "COUNT", "column": "*", "alias": "N"},
                {"function": "COUNT", "column": "*", "alias": "n"},
            ],
            "unique",
        ),
        ("ordering", "amount DESC; SELECT 1", "valid SQL"),
    ],
)
def test_invalid_settings_fail_with_actionable_messages(db, kind, value, message):
    with pytest.raises(Problem, match=message):
        render_guided(kind, value, [schema(db, "input"), schema(db, "customers")])


def test_custom_template_reuses_forms_without_builtin_identity_and_quotes_columns(db):
    db.execute('ALTER TABLE input RENAME amount TO "total.amount"')
    custom = parse_template(
        "-- @label My own node\n-- @icon filter\n-- @input records\n-- @param rules: conditions(records)\n-- @output accepted\nSELECT * FROM {{ records }} WHERE {{ rules }};"
    )
    statement = compile_template(
        custom,
        {"rules": {"column": "total.amount", "operator": ">", "value": "15"}},
        {"records": '"input"'},
        {"accepted": "out"},
        {},
        Path(),
        input_schemas={"records": schema(db, "input")},
    )[0]
    assert [r[0] for r in db.execute(statement["sql"]).fetchall()] == [2, 3]
    with pytest.raises(Problem, match="declared input"):
        parse_template(BUILTINS["join"].replace("join_keys(left,right)", "join_keys(left,missing)"))


def test_single_column_choices_keep_dots_inside_identifiers(db):
    db.execute('ALTER TABLE input RENAME order_id TO "order.id"')
    assert len(execute(db, "sample", {"key": "order.id", "percent": 100}).fetchall()) == 4


def test_import_adds_missing_templates_and_preserves_existing_ones():
    customized = BUILTINS["filter"] + "\n-- custom annotation\n"
    bundle = {
        "templates": {"filter": customized},
        "flow": {"nodes": [{"id": "existing", "template": "filter"}]},
    }
    before = copy.deepcopy(bundle)
    _, metadata = add_builtins(bundle)
    assert bundle["templates"]["filter"] == customized
    assert bundle["flow"] == before["flow"]
    # An existing name is kept as is, so the palette never shows two "Filter" entries.
    assert set(bundle["templates"]) == set(BUILTINS)
    assert metadata["imported"] == [name for name in BUILTINS if name != "filter"]
    first = copy.deepcopy(bundle)
    assert add_builtins(bundle)[1] == {"imported": []}
    assert bundle == first


@pytest.mark.parametrize(
    "query",
    [
        "SELECT * FROM (SELECT grp, category, value FROM {{ source }}) PIVOT (SUM(value) FOR category IN ('X', 'Y'));",
        "SELECT * FROM {{ source }} UNPIVOT INCLUDE NULLS (measure FOR field IN (id, value));",
    ],
)
def test_reshape_lineage_reports_coverage_instead_of_inventing_contributions(services, tmp_path, query):
    worktree, preview, lineage = pipeline(services, tmp_path, query)
    column = preview["columns"][-1]["name"]
    result = lineage.explain(worktree, "dev", preview["id"], preview["rows"][0]["id"], column)
    assert not result["complete"]
    assert result["warnings"]


@pytest.mark.parametrize(
    ("query", "column", "complete"),
    [
        ("SELECT grp, SUM(value) AS total FROM {{ source }} GROUP BY ALL ORDER BY grp", "total", True),
        (
            "SELECT * FROM {{ source }} QUALIFY ROW_NUMBER() OVER (PARTITION BY grp ORDER BY id) = 1",
            "value",
            False,
        ),
        ("SELECT * FROM {{ source }} UNION ALL BY NAME SELECT * FROM {{ source }}", "value", False),
        (
            "SELECT *, SUM(value) OVER (PARTITION BY grp ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total FROM {{ source }}",
            "total",
            True,
        ),
        (
            "SELECT *, RANK() OVER (PARTITION BY grp ORDER BY value DESC) AS ranking FROM {{ source }}",
            "ranking",
            True,
        ),
    ],
)
def test_palette_sql_reports_its_actual_lineage_coverage(services, tmp_path, query, column, complete):
    worktree, preview, lineage = pipeline(services, tmp_path, query)
    result = lineage.explain(worktree, "dev", preview["id"], preview["rows"][0]["id"], column)
    assert result["complete"] is complete, result
    if not complete:
        assert result["warnings"]


@pytest.mark.parametrize(
    ("group", "count", "values"),
    [
        ("grp", 3, [10, 20, 20]),
        ("NULLIF(grp, 'A')", 3, [10, 20, 20]),
        ("1", 9, [10, 20, 20, 30, 40]),
    ],
)
def test_group_by_all_lineage_limits_contributions_to_the_actual_group(
    services, tmp_path, group, count, values
):
    worktree, preview, lineage = pipeline(
        services,
        tmp_path,
        f"SELECT {group} AS key, SUM(value) AS total FROM {{{{ source }}}} GROUP BY ALL ORDER BY key NULLS FIRST",
    )
    result = lineage.explain(worktree, "dev", preview["id"], preview["rows"][0]["id"], "total")
    assert result["complete"], result
    assert result["total"] == count
    assert sorted(item["value"] for item in result["contributions"]) == values
