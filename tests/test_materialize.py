import duckdb
import pytest
import sqlglot

from duckpad.datasets import Dataset
from duckpad.materialize import outer_aggregates, plan_materialization, publish_view, to_physical


@pytest.fixture
def upstream():
    """A published source dataset with a struct column, as the engine stores it."""
    with duckdb.connect() as db:
        query = (
            "SELECT * FROM (VALUES (1, 2, 3, {'x': 4, 'y': 5}), (6, 7, 8, {'x': 9, 'y': 10})) t(a, b, c, s)"
        )
        plan = plan_materialization(db, {"table": "up", "query": query, "bindings": {}}, {}, instrument=False)
        db.execute(plan["sql"])
        columns, column_map, _ = publish_view(db, "up", plan)
        data = Dataset(
            id="up",
            node="source",
            port="result",
            table="up",
            columns=columns,
            count=2,
            run="run",
            query=query,
            bindings={},
            dependencies={},
            fingerprint="fingerprint",
            source=True,
            storage=plan["storage"],
            column_map=column_map,
        )
        yield db, data


@pytest.mark.parametrize(
    ("query", "instrumented"),
    [
        ("SELECT COLUMNS('a|b'), c FROM up ORDER BY a", False),
        ("SELECT COLUMNS(*) FROM up ORDER BY a", False),
        ("SELECT COLUMNS('b|c') + 1, a FROM up ORDER BY a", False),
        ("SELECT s.*, a FROM up ORDER BY a", False),
        ("SELECT UNNEST(s), a FROM up ORDER BY a", False),
        ("SELECT * EXCLUDE (b), c * 2 AS d FROM up ORDER BY a", True),
        ("SELECT * REPLACE (a + 10 AS a), b AS e FROM up ORDER BY a", True),
        ("SELECT a, b + c AS total FROM up ORDER BY a", True),
        ("SELECT a, SUM(c) AS total FROM up GROUP BY a ORDER BY a", True),
    ],
)
def test_instrumentation_never_shifts_published_columns(upstream, query, instrumented):
    db, data = upstream
    expected = db.execute("DESCRIBE " + query).fetchall()
    rows = db.execute(query).fetchall()
    plan = plan_materialization(db, {"table": "out", "query": query, "bindings": {}}, {"up": data})
    db.execute(plan["sql"])
    columns, _, _ = publish_view(db, "out", plan)
    assert [(c["name"], c["type"]) for c in columns] == [(c[0], c[1]) for c in expected]
    assert db.execute("SELECT * FROM out").fetchall() == rows
    assert bool(plan["witnesses"] or plan["groups"]) is instrumented
    if not instrumented:
        assert plan["query"] == query


def test_outer_aggregates_exclude_aggregates_evaluated_by_windows():
    tree = sqlglot.parse_one(
        "SELECT SUM(a), SUM(SUM(b)) OVER (), COUNT(*) OVER () FROM t GROUP BY c", read="duckdb"
    )
    assert [a.sql() for a in outer_aggregates(tree)] == ["SUM(a)"]


def test_physical_names_point_tables_at_storage_and_renamed_columns_at_their_stored_name(upstream):
    _, data = upstream
    data.column_map = {"a": "__dp_user_a"}
    tree = sqlglot.parse_one('SELECT "u"."a", "u"."b" FROM "up" AS "u"', read="duckdb")
    assert to_physical(tree, {"up": data}) == {"u": data}
    assert tree.sql(dialect="duckdb") == 'SELECT "u"."__dp_user_a", "u"."b" FROM "up_storage" AS "u"'


def test_witnesses_keep_physical_rowids_beside_a_user_rowid_column():
    with duckdb.connect() as db:
        query = "SELECT * FROM (VALUES (10, 1), (20, 2)) t(rowid, a)"
        plan = plan_materialization(db, {"table": "up", "query": query, "bindings": {}}, {}, instrument=False)
        db.execute(plan["sql"])
        columns, column_map, _ = publish_view(db, "up", plan)
        data = Dataset(
            id="up",
            node="source",
            port="result",
            table="up",
            columns=columns,
            count=2,
            run="run",
            query=query,
            bindings={},
            dependencies={},
            fingerprint="fingerprint",
            source=True,
            storage=plan["storage"],
            column_map=column_map,
        )
        statement = {"table": "out", "query": "SELECT rowid, a FROM up ORDER BY a DESC", "bindings": {}}
        plan = plan_materialization(db, statement, {"up": data})
        db.execute(plan["sql"])
        publish_view(db, "out", plan)
        assert db.execute("SELECT * FROM out").fetchall() == [(20, 2), (10, 1)]
        [witness] = plan["witnesses"].values()
        assert db.execute(f'SELECT "{witness["column"]}" FROM out_storage').fetchall() == [(1,), (0,)]
