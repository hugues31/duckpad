"""Forward lineage proves membership and rejection from immutable captured results."""

import duckdb
import pytest
from helpers import join_run
from test_trace import SOURCE, materialize

from duckpad.datasets import Context
from duckpad.example import create_example
from duckpad.row_impact import trace
from duckpad.row_impact_match import Matcher
from duckpad.trace import Coverage
from duckpad.util import Problem


@pytest.fixture
def context():
    with duckdb.connect() as db:
        result = Context("worktree", "dev", db)
        materialize(result, "src", SOURCE, source=True)
        yield result


def matched(context, query, row=0):
    data = materialize(context, "target", query)
    matcher = Matcher(context, context.db, data, context.datasets["src"], row)
    query, parameters, metadata = matcher.match()
    rows = context.db.execute(query, parameters).fetchall()
    return matcher, rows, metadata


def test_filter_reason_uses_captured_values(context):
    matcher, rows, _ = matched(context, "SELECT * FROM src WHERE value > 20")
    assert rows == []
    assert matcher.rejection() == {
        "kind": "where",
        "condition": "value > 20",
        "evaluated": "10 > 20",
        "result": False,
    }


def test_inner_join_missing_key_and_duplicate_rows(context):
    materialize(context, "other", "SELECT 2 AS id FROM range(8)", source=True)
    matcher, rows, _ = matched(context, "SELECT a.* FROM src a JOIN other b ON a.id=b.id")
    assert not rows
    reason = matcher.rejection()
    assert reason["kind"] == "join" and reason["missing_node"] == "other"
    assert reason["evaluated"] == '1 = "b"."id"'
    matcher = Matcher(context, context.db, context.datasets["target"], context.datasets["src"], 1)
    query, params, _ = matcher.match()
    assert len(context.db.execute(query, params).fetchall()) == 8


@pytest.mark.parametrize(
    "query", ["SELECT grp, sum(value) AS total FROM src GROUP BY grp", "SELECT sum(value) FROM src"]
)
def test_group_membership(context, query):
    matcher, rows, _ = matched(context, query)
    assert len(rows) == 1
    details = matcher.group_details(rows[0][0])
    assert details["other_rows"] == (2 if "GROUP" in query else 4)


def test_having_rejection_evaluates_the_whole_group(context):
    _, rows, metadata = matched(
        context, "SELECT grp, sum(value) AS total FROM src GROUP BY grp HAVING sum(value)>60"
    )
    assert not rows
    assert metadata["reason"]["kind"] == "having"
    assert metadata["reason"]["evaluated"] == "50 > 60"
    assert metadata["reason"]["result"] is False


def test_distinct_tuple_mapping(context):
    _, rows, _ = matched(context, "SELECT DISTINCT grp FROM src")
    assert len(rows) == 1


def test_public_rowid_and_null_filter_keep_physical_identity(context):
    source = materialize(context, "named", "SELECT 100 AS rowid, NULL::INTEGER AS amount", source=True)
    data = materialize(context, "target", "SELECT rowid FROM named WHERE amount > 0")
    matcher = Matcher(context, context.db, data, source, 0)
    query, parameters, _ = matcher.match()
    assert not context.db.execute(query, parameters).fetchall()
    assert matcher.rejection()["result"] is None
    assert matcher.rejection()["evaluated"] == "NULL > 0"


def test_duplicate_pages_and_selected_row_control_the_continuation(services):
    store, projects, _, engine = services
    bundle = {
        "flow": {
            "nodes": [{"id": name} for name in ("source", "keys", "joined", "filtered")],
            "edges": [
                {
                    "id": "a",
                    "source": "source",
                    "sourceHandle": "result",
                    "target": "joined",
                    "targetHandle": "source",
                },
                {
                    "id": "b",
                    "source": "keys",
                    "sourceHandle": "result",
                    "target": "joined",
                    "targetHandle": "keys",
                },
                {
                    "id": "c",
                    "source": "joined",
                    "sourceHandle": "result",
                    "target": "filtered",
                    "targetHandle": "source",
                },
            ],
        },
        "node_sql": {
            "nodes/source.sql": "-- @output result\nSELECT 1 AS id",
            "nodes/keys.sql": "-- @output result\nSELECT 1 AS id, range AS position FROM range(8)",
            "nodes/joined.sql": "-- @input source\n-- @input keys\n-- @output result\nSELECT s.id, k.position FROM {{ source }} s JOIN {{ keys }} k ON s.id=k.id ORDER BY k.position",
            "nodes/filtered.sql": "-- @input source\n-- @output result\nSELECT * FROM {{ source }} WHERE position >= 5",
        },
    }
    worktree = projects.create("Duplicated rows", bundle)["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    source = engine.context(worktree, "dev").outputs["source"]["result"]
    result = trace(engine, worktree, "dev", source.id, 0)
    first, last = result["steps"]
    assert first["state"] == "duplicated" and first["total"] == 8
    assert len(first["rows"]) == 5 and first["next_offset"] == 5
    assert last["state"] == "discarded"
    next_page = trace(engine, worktree, "dev", source.id, 0, offsets={first["id"]: 5})
    assert [r["row"] for r in next_page["steps"][0]["rows"]] == [5, 6, 7]
    selected = trace(engine, worktree, "dev", source.id, 0, choices={first["id"]: 6})
    assert selected["steps"][0]["row"] == 6
    assert selected["steps"][1]["state"] == "kept"
    with pytest.raises(Problem, match="does not belong"):
        trace(engine, worktree, "dev", source.id, 0, choices={first["id"]: 99})
    engine.context(worktree, "dev").outputs["joined"]["result"].opaque_python = True
    unknown = trace(engine, worktree, "dev", source.id, 0)
    assert not unknown["complete"] and not unknown["stops"]
    assert [step["state"] for step in unknown["steps"]] == ["unknown", "unknown"]


@pytest.mark.parametrize(
    "query",
    [
        "SELECT * FROM src QUALIFY row_number() OVER ()=1",
        "WITH a AS (SELECT * FROM src) SELECT * FROM a",
        "SELECT random(), id FROM src",
    ],
)
def test_unsupported_does_not_guess(context, query):
    with pytest.raises(Coverage):
        matched(context, query)


def test_northstar_orders_paths_and_no_source_replay(services, monkeypatch):
    store, projects, catalog, engine = services
    worktree = create_example(projects, catalog)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success"
    context = engine.context(worktree, "dev")
    source = context.outputs["orders"]["result"]
    before = {key: d.count for key, d in context.datasets.items()}
    monkeypatch.setattr(engine, "launch", lambda *args: pytest.fail("Unexpected execution"))
    # Source queries must not be touched; captured source rows are sufficient.
    source.query = "SELECT * FROM read_csv('/missing.csv')"
    refunded = trace(engine, worktree, "dev", source.id, 8)
    steps = {e["node"]: e for e in reversed(refunded["steps"])}
    assert steps["validated"]["state"] == "discarded", refunded
    assert steps["validated"]["reason"]["evaluated"] == "'refunded' = 'paid'"
    assert steps["period"]["state"] == "grouped", refunded
    assert steps["period"]["other_rows"] == 119
    assert steps["net"]["state"] == steps["export"]["state"] == "unreached"
    paid = trace(engine, worktree, "dev", source.id, 1)
    steps = {e["node"]: e for e in reversed(paid["steps"])}
    assert steps["export"]["state"] == "written", paid
    assert steps["report::summary::metrics"]["other_rows"] == 26
    assert steps["report::summary::metrics"]["group"][0]["value"] == "South"
    assert all(
        steps[n]["state"] == "kept" for n in ("enriched", "validated", "net", "report::summary::eligible")
    )
    assert {key: d.count for key, d in context.datasets.items()} == before
    source.status = "stale"
    with pytest.raises(Problem, match="stale"):
        trace(engine, worktree, "dev", source.id, 1)
