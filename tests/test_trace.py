"""Unit tests of lineage tracing, one SQL construct visitor at a time, over in-memory DuckDB data."""

from decimal import Decimal

import duckdb
import pytest
import sqlglot
from sqlglot import exp

from duckpad.datasets import Context, Dataset
from duckpad.materialize import plan_materialization, publish_view
from duckpad.trace import Coverage, TraceQuery
from duckpad.trace import builders as b
from duckpad.util import literal

# Stored rows 0 to 4 hold ids 1 to 5.
SOURCE = (
    "SELECT * FROM (VALUES (1, 'A', 10, 'X'), (2, 'A', 20, 'X'), (3, 'A', 20, 'Y'), "
    "(4, 'B', 30, 'Z'), (5, 'B', 40, 'Z')) t(id, grp, value, category)"
)


def materialize(context, name, query, source=False):
    """Publish a dataset as the engine does, with its row witnesses and group values."""
    dependencies = {
        t.name: context.datasets[t.name]
        for t in sqlglot.parse_one(query, read="duckdb").find_all(exp.Table)
        if t.name in context.datasets
    }
    statement = {"table": name, "query": query, "bindings": {}}
    plan = plan_materialization(context.db, statement, dependencies, instrument=not source)
    context.db.execute(plan["sql"])
    columns, column_map, _ = publish_view(context.db, name, plan)
    data = Dataset(
        id=name,
        node=name,
        port="result",
        table=name,
        columns=columns,
        count=context.db.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0],
        run="run",
        query=query,
        bindings={},
        dependencies={table: dependency.id for table, dependency in dependencies.items()},
        fingerprint="fingerprint",
        source=source,
        storage=plan["storage"],
        column_map=column_map,
        witnesses=plan["witnesses"],
        groups=plan["groups"],
    )
    context.datasets[name] = data
    return data


@pytest.fixture
def context():
    with duckdb.connect() as db:
        context = Context("worktree", "dev", db)
        materialize(context, "src", SOURCE, source=True)
        yield context


class Explanation:
    def __init__(self, tracer, contributions, selection, distinct):
        self.tracer = tracer
        self.contributions = cells(tracer, contributions)
        self.selection = cells(tracer, selection)
        self.distinct = distinct

    def groups(self):
        """Distinct values and their row counts, as lineage pages them."""
        base, value = self.distinct
        query = f"SELECT v, COUNT(*) FROM (SELECT {value} AS v {base}) q WHERE v IS NOT NULL GROUP BY v ORDER BY v"
        return self.tracer.cursor.execute(query).fetchall()


def cells(tracer, query):
    """Contributing cells as (relation, stored row, column); intermediate relations are named by port."""
    if not query:
        return []
    rows = tracer.cursor.execute(
        f"SELECT DISTINCT node, port, row_id, column_name FROM ({query}) c"
    ).fetchall()
    return sorted((node if port == "result" else port, row, column) for node, port, row, column in rows)


@pytest.fixture
def explain(context):
    """Trace one cell of a query over `src`."""

    def run(query, row=0, column=0, **options):
        name = f"step_{len(context.datasets)}"
        data = materialize(context, name, query)
        tracer = TraceQuery(context, context.db.cursor(), data, row)
        return Explanation(tracer, *tracer.trace(tracer.normalize(data), column, **options))

    return run


@pytest.mark.parametrize(
    ("query", "kind"),
    [
        ("SELECT value * 2 FROM src", "projection"),
        ("SELECT id FROM src WHERE value > 15", "filter"),
        ("SELECT a.id FROM src a JOIN src b ON a.id = b.id", "join"),
        ("SELECT DISTINCT grp FROM src", "distinct"),
        ("SELECT grp FROM src GROUP BY grp", "aggregate"),
        ("SELECT SUM(value) FROM src", "aggregate"),
        ("SELECT SUM(value) OVER () FROM src", "window"),
        ("SELECT grp FROM src UNION SELECT category FROM src", "union"),
        ("SELECT grp FROM src INTERSECT SELECT grp FROM src", "intersect"),
        ("SELECT grp FROM src EXCEPT SELECT category FROM src", "except"),
    ],
)
def test_each_construct_has_its_visitor(explain, query, kind):
    assert explain(query).tracer.kind == kind


def test_projection_reads_the_witnessed_row(explain):
    result = explain("SELECT value * 2 AS doubled FROM src ORDER BY id", row=1)
    assert result.tracer.expression == '"src"."value" * 2'
    assert result.contributions == [("src", 1, "value")]
    assert result.selection == []


def test_filter_reports_its_condition_cells_as_context(explain):
    result = explain("SELECT id FROM src WHERE value > 15 ORDER BY id")
    assert result.contributions == [("src", 1, "id")]
    assert result.selection == [("src", 1, "value")]


def test_join_reads_one_row_of_each_side(explain):
    result = explain("SELECT a.id, b.value FROM src a JOIN src b ON b.id = a.id + 1 ORDER BY a.id", column=1)
    assert result.contributions == [("src", 1, "value")]
    assert result.selection == [("src", 0, "id"), ("src", 1, "id")]


def test_distinct_reads_every_equal_occurrence(explain):
    result = explain("SELECT DISTINCT grp FROM src ORDER BY grp")
    assert result.contributions == [("src", 0, "grp"), ("src", 1, "grp"), ("src", 2, "grp")]


def test_rows_without_witnesses_refuse_ambiguous_occurrences(explain):
    with pytest.raises(Coverage, match="indistinguishable duplicate occurrences"):
        explain("WITH t AS (SELECT * FROM src) SELECT grp FROM t ORDER BY grp")


def test_aggregate_reads_its_group(explain):
    result = explain("SELECT grp, SUM(value) AS total FROM src GROUP BY grp ORDER BY grp", row=1, column=1)
    assert result.contributions == [("src", 3, "value"), ("src", 4, "value")]


def test_aggregate_group_without_captured_values_matches_output_rows(explain):
    result = explain(
        "WITH t AS (SELECT * FROM src) SELECT grp, SUM(value) FROM t GROUP BY grp ORDER BY grp",
        row=1,
        column=1,
    )
    assert not result.tracer.dataset.groups
    assert result.contributions == [("t", 3, "value"), ("t", 4, "value")]


def test_extreme_aggregate_reads_its_ties_and_context_reads_the_group(explain):
    query = "SELECT grp, MAX(value) AS top FROM src GROUP BY grp ORDER BY grp"
    assert explain(query, column=1).contributions == [("src", 1, "value"), ("src", 2, "value")]
    context = explain(query, column=1, all_context=True)
    assert context.contributions == [("src", 0, "value"), ("src", 1, "value"), ("src", 2, "value")]


def test_extreme_aggregate_ignores_pagination_of_the_groups(explain):
    result = explain(
        "SELECT grp, MAX(value) AS top FROM src GROUP BY grp ORDER BY grp DESC LIMIT 1 OFFSET 1", column=1
    )
    assert result.contributions == [("src", 1, "value"), ("src", 2, "value")]


def test_aggregate_filter_selects_rows_and_reports_its_condition(explain):
    result = explain("SELECT SUM(value) FILTER (WHERE id > 1) AS total FROM src WHERE grp = 'A'")
    assert result.contributions == [("src", 1, "value"), ("src", 2, "value")]
    assert ("src", 0, "id") in result.selection


def test_aggregate_keeps_alternative_conditions_inside_the_group(explain):
    query = "SELECT grp, SUM(value) FILTER (WHERE id = 1 OR id = 4) FROM src WHERE id < 2 OR id > 3 GROUP BY grp ORDER BY grp"
    assert explain(query, row=0, column=1).contributions == [("src", 0, "value")]
    assert explain(query, row=1, column=1).contributions == [("src", 3, "value")]


def test_count_distinct_groups_values_and_selects_one_value(explain):
    query = "SELECT grp, COUNT(DISTINCT category) AS n FROM src GROUP BY grp ORDER BY grp"
    assert explain(query, column=1).groups() == [("X", 2), ("Y", 1)]
    result = explain(query, column=1, distinct_value="X")
    assert result.contributions == [("src", 0, "category"), ("src", 1, "category")]


def test_aggregate_refuses_combined_extrema(explain):
    with pytest.raises(Coverage, match="multiple extrema"):
        explain("SELECT MAX(value) - MIN(value) FROM src")


def test_window_reads_its_frame(explain):
    query = "SELECT id, SUM(value) OVER (PARTITION BY grp ORDER BY id ROWS UNBOUNDED PRECEDING) FROM src ORDER BY id"
    assert explain(query, row=1, column=1).contributions == [("src", 0, "value"), ("src", 1, "value")]


def test_navigation_window_reads_one_row(explain):
    result = explain("SELECT id, LAG(value, 1, 0) OVER (ORDER BY id) FROM src ORDER BY id", row=3, column=1)
    assert result.contributions == [("src", 2, "value")]


def test_ranking_window_reads_its_partition_order(explain):
    result = explain(
        "SELECT id, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY id) FROM src ORDER BY id", row=4, column=1
    )
    assert result.contributions == [("src", 3, "id"), ("src", 4, "id")]


def test_extreme_window_reads_its_ties(explain):
    result = explain("SELECT id, MAX(value) OVER (PARTITION BY grp) FROM src ORDER BY id", column=1)
    assert result.contributions == [("src", 1, "value"), ("src", 2, "value")]


def test_window_filter_keeps_alternative_conditions_inside_the_frame(explain):
    query = (
        "SELECT id, SUM(value) FILTER (WHERE id = 1 OR id = 3) OVER (PARTITION BY grp) FROM src ORDER BY id"
    )
    assert explain(query, column=1).contributions == [("src", 0, "value"), ("src", 2, "value")]
    assert explain(query, row=3, column=1).contributions == []


def test_distinct_window_groups_frame_values(explain):
    query = "SELECT id, COUNT(DISTINCT category) OVER (PARTITION BY grp) FROM src ORDER BY id"
    assert explain(query, column=1).groups() == [("X", 2), ("Y", 1)]
    result = explain(query, column=1, distinct_value="Y")
    assert result.contributions == [("src", 2, "category")]


@pytest.mark.parametrize(
    ("query", "message"),
    [
        ("SELECT SUM(value) OVER () + MIN(value) OVER () FROM src", "multiple independent windows"),
        ("SELECT STRING_AGG(category, ',') OVER () FROM src", "does not yet have an exact provenance rule"),
        (
            "SELECT SUM(a.value + b.value) OVER () FROM src a JOIN src b ON a.id = b.id",
            "spanning joined relations",
        ),
    ],
)
def test_window_refuses_constructs_without_exact_provenance(explain, query, message):
    with pytest.raises(Coverage, match=message):
        explain(query)


def test_union_matches_equal_rows_on_both_sides(explain):
    result = explain(
        "SELECT category FROM src WHERE id < 3 UNION SELECT category FROM src WHERE id = 2 ORDER BY 1"
    )
    assert result.tracer.expression == "UNION · category"
    assert result.contributions == [
        ("left", 0, "category"),
        ("left", 1, "category"),
        ("right", 0, "category"),
    ]


def test_except_reports_its_right_side_as_context(explain):
    result = explain("SELECT grp FROM src EXCEPT SELECT category FROM src ORDER BY 1")
    assert result.contributions == [("left", 0, "grp"), ("left", 1, "grp"), ("left", 2, "grp")]
    assert len(result.selection) == 5


def test_set_operations_with_all_are_not_covered(explain):
    with pytest.raises(Coverage, match="Set operations with ALL"):
        explain("SELECT grp FROM src UNION ALL SELECT grp FROM src")


def test_ctes_and_derived_tables_become_explainable_relations(explain):
    result = explain(
        "WITH a AS (SELECT * FROM src WHERE grp = 'A') SELECT SUM(value) FROM (SELECT * FROM a) d"
    )
    assert [(alias, data.port) for alias, data in result.tracer.sources.items()] == [("d", "d")]
    assert result.contributions == [("d", 0, "value"), ("d", 1, "value"), ("d", 2, "value")]


def test_grouped_windows_read_their_grouped_stage(explain):
    result = explain(
        "SELECT grp, SUM(SUM(value)) OVER (ORDER BY grp) FROM src GROUP BY grp ORDER BY grp", column=1
    )
    assert [data.port for data in result.tracer.sources.values()] == ["grouped_window_input"]
    assert result.contributions == [("grouped_window_input", 0, "_dp_group_value_1")]


def test_renamed_storage_columns_keep_their_public_name(context, explain):
    materialize(context, "mid", "SELECT id AS rowid, value FROM src")
    result = explain("SELECT rowid, value FROM mid WHERE rowid > 3 ORDER BY rowid")
    assert result.tracer.expression.startswith('"mid"."__dp_user_')
    assert result.contributions == [("mid", 3, "rowid")]


def test_source_columns_named_with_spaces_stand_for_whole_rows(context, explain):
    materialize(
        context, "people", "SELECT * FROM (VALUES ('Ada', 1), ('Bob', 2)) t(\"First Name\", id)", source=True
    )
    result = explain("SELECT COUNT(*) FROM people")
    assert result.contributions == [("people", 0, "First Name"), ("people", 1, "First Name")]


@pytest.mark.parametrize(
    ("query", "message"),
    [
        ("SELECT id, random() FROM src", "Volatile expressions"),
        (
            "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r",
            "Recursive CTE",
        ),
        ("SELECT a.id FROM src a SEMI JOIN src b ON a.id = b.id", "SEMI/ANTI join"),
        ("SELECT id FROM src QUALIFY ROW_NUMBER() OVER (PARTITION BY grp ORDER BY id) = 1", "QUALIFY"),
        ("SELECT COLUMNS('id|value') FROM src", "expanding into several columns"),
    ],
)
def test_steps_without_exact_provenance_are_refused(explain, query, message):
    with pytest.raises(Coverage, match=message):
        explain(query)


def test_description_reads_null_group_keys(context, explain):
    materialize(
        context, "gaps", "SELECT * FROM (VALUES (NULL, 1), ('A', 2), (NULL, 3)) t(grp, value)", source=True
    )
    result = explain("SELECT grp, SUM(value) FROM gaps GROUP BY grp ORDER BY grp NULLS FIRST", column=1)
    response = {"total": 2, "offset": 0, "contributions": []}
    assert result.tracer.describe(response)["selection"] == ["grp IS NULL"]


@pytest.mark.parametrize(
    "value", [None, True, False, 0, -5, 1.5, -1e20, Decimal("10.50"), "it's", b"ab", [1, "a"]]
)
def test_value_literals_render_like_util_literal(value):
    assert b.value(value).sql(dialect="duckdb") == literal(value)


def test_conditions_combine_without_changing_precedence():
    condition = b.every([sqlglot.condition("a OR b"), sqlglot.condition("c")])
    assert condition.sql(dialect="duckdb") == "(a OR b) AND c"
    assert b.every([]).sql() == "TRUE"
    assert b.union_all([]) is None
