"""Static origins agree with value contributions without reading or running data."""

import time

import pytest
from helpers import join_run, pipeline

from duckpad.column_analysis import Incomplete, analyze
from duckpad.example import create_example

SCHEMA = {"a": {"id": "INT", "amount": "DOUBLE", "region": "VARCHAR"}, "b": {"id": "INT", "rate": "DOUBLE"}}


@pytest.mark.parametrize(
    ("query", "column", "refs"),
    [
        ("SELECT amount * 2 AS net FROM a WHERE id > 1", "net", [("a", "amount")]),
        ("WITH c(x) AS (SELECT amount * 2 FROM a) SELECT x AS net FROM c", "net", [("a", "amount")]),
        ("SELECT x AS net FROM (SELECT amount * 2 AS x FROM a) q", "net", [("a", "amount")]),
        ("SELECT l.* EXCLUDE(id), r.rate FROM a l JOIN b r ON l.id = r.id", "amount", [("a", "amount")]),
        (
            "SELECT amount AS net FROM a UNION ALL SELECT rate AS net FROM b",
            "net",
            [("a", "amount"), ("b", "rate")],
        ),
        ("SELECT amount AS net FROM a EXCEPT SELECT rate FROM b", "net", [("a", "amount")]),
        ("SELECT (SELECT SUM(rate) FROM b) + amount AS net FROM a", "net", [("b", "rate"), ("a", "amount")]),
    ],
)
def test_scoped_value_inputs(query, column, refs):
    result = next(c for c in analyze(query, SCHEMA) if c["name"] == column)
    assert result["refs"] == refs


def test_selection_columns_are_separate():
    result = analyze(
        "SELECT a.amount * b.rate AS net FROM a JOIN b ON a.id = b.id WHERE a.region = 'South' ORDER BY a.id",
        SCHEMA,
    )[0]
    assert result["refs"] == [("a", "amount"), ("b", "rate")]
    assert {r for s in result["selection"] for r in s["refs"]} == {("a", "id"), ("b", "id"), ("a", "region")}
    result = analyze("SELECT amount FROM a INTERSECT SELECT rate FROM b", SCHEMA)[0]
    assert {r for s in result["selection"] for r in s["refs"]} == {("a", "amount"), ("b", "rate")}
    window = analyze("SELECT SUM(amount) OVER (PARTITION BY region ORDER BY id) AS total FROM a", SCHEMA)[0]
    assert window["refs"] == [("a", "amount")]
    filtered = analyze("SELECT SUM(amount) FILTER (WHERE id > 1) AS total FROM a", SCHEMA)[0]
    assert filtered["refs"] == [("a", "amount")]
    assert filtered["selection"][0]["refs"] == [("a", "id")]
    distinct = analyze("SELECT DISTINCT ON(region) amount FROM a", SCHEMA)[0]
    assert distinct["selection"][0]["refs"] == [("a", "region")]
    ordered = analyze("SELECT ARRAY_AGG(amount ORDER BY id) AS amounts FROM a", SCHEMA)[0]
    assert ordered["refs"] == [("a", "amount")]
    assert ordered["selection"][0]["refs"] == [("a", "id")]
    assert {r for s in window["selection"] for r in s["refs"]} == {("a", "region"), ("a", "id")}


def test_unknown_semantics_are_incomplete():
    with pytest.raises(Incomplete):
        analyze("SELECT SUM(amount) OVER w AS total FROM a WINDOW w AS (PARTITION BY region)", SCHEMA)
    with pytest.raises(Incomplete):
        analyze("SELECT amount + (SELECT rate FROM b WHERE b.id = a.id) AS net FROM a", SCHEMA)
    with pytest.raises(Incomplete):
        analyze("WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t WHERE x<5) SELECT x FROM t", {})


def test_northstar_origins_cache_and_limits(services, monkeypatch):
    store, projects, catalog, engine = services
    worktree = create_example(projects, catalog)["id"]
    before = engine.column_lineage.describe(worktree, "dev", "report", "report", "net_share")
    assert not before["complete"]
    assert {n for o in before["outputs"] for n in o["run_nodes"]} >= {"orders", "customers", "fees"}
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    started = time.monotonic()
    result = engine.column_lineage.describe(worktree, "dev", "report", "report", "net_share")
    assert time.monotonic() - started < 1
    assert result["complete"], result
    assert {s["node"] for s in result["steps"] if s["kind"] == "computed"} == {
        "report::rank",
        "report::summary::metrics",
        "net",
    }
    assert {s["node"] for s in result["steps"] if s["kind"] == "source"} == {"orders", "fees"}
    region = engine.column_lineage.describe(worktree, "dev", "report", "report", "region")
    assert region["complete"]
    assert region["steps"][-1]["node"] == "customers"
    assert any(s["kind"] == "join" for step in region["steps"] for s in step["selection"])
    monkeypatch.setattr(engine.column_lineage, "_build", lambda *args: pytest.fail("Analysis was recomputed"))
    assert engine.column_lineage.describe(worktree, "dev", "report", "report", "net_share") == result


def test_never_run_literal_source_and_earlier_output(services):
    store, projects, _, engine = services
    worktree = projects.create(
        "Static",
        {
            "flow": {"nodes": [{"id": "n"}], "edges": []},
            "templates": {},
            "components": {},
            "node_sql": {
                "nodes/n.sql": "-- @output first\nSELECT 2::INTEGER AS amount;\n-- @output result\nSELECT amount * 3 AS net FROM {{ first }};"
            },
        },
    )["id"]
    result = engine.column_lineage.describe(worktree, "dev", "n", "result", "net")
    assert result["complete"], result
    assert [(s["port"], s["column"]) for s in result["steps"]] == [("result", "net"), ("first", "amount")]
    assert result["steps"][-1]["type"] == "INTEGER"
    assert not store.all("run")


def test_python_stops_at_input_tables(services):
    from test_python_nodes import flow

    store, _, _, engine = services
    worktree = flow(services)["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    result = engine.column_lineage.describe(worktree, "dev", "total", "result", "s")
    assert not result["complete"]
    python = result["steps"][-1]
    assert python["status"] == "python"
    assert not python["inputs"]
    assert python["tables"] == [{"node": "source", "port": "result"}]


def test_environment_and_definition_changes_invalidate_analysis(services):
    from duckpad.bundle import bundle_to_files

    _, projects, catalog, engine = services
    worktree = create_example(projects, catalog)["id"]
    # A literal source is described without data, using the selected variable value.
    snapshot = projects.snapshot(worktree)
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"].append({"id": "constant", "params": {"factor": {"$var": "factor"}}})
    bundle["variables"]["factor"] = {"type": "number", "default": 2, "environments": {"prod": 7}}
    bundle["node_sql"]["nodes/constant.sql"] = (
        "-- @param factor: number = 2\n-- @output first\nSELECT 1::INTEGER AS x;\n-- @output result\nSELECT x * {{ factor }} AS y FROM {{ first }};"
    )
    projects.write(worktree, snapshot["revision"], bundle_to_files(bundle))
    first = engine.column_lineage.describe(worktree, "dev", "constant", "result", "y")
    assert first["complete"]
    assert "* 2" in first["steps"][0]["expression"]
    prod = engine.column_lineage.describe(worktree, "prod", "constant", "result", "y")
    assert "* 7" in prod["steps"][0]["expression"]
    snapshot = projects.snapshot(worktree)
    snapshot["bundle"]["flow"]["nodes"][-1]["params"]["factor"] = 3
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    changed = engine.column_lineage.describe(worktree, "dev", "constant", "result", "y")
    assert "* 3" in changed["steps"][0]["expression"]


@pytest.mark.parametrize(
    "query",
    [
        "SELECT value * 2 AS total FROM {{ source }} ORDER BY id",
        "SELECT sum(value) AS total FROM {{ source }}",
        "SELECT value / sum(value) OVER () AS total FROM {{ source }} ORDER BY id",
    ],
)
def test_static_inputs_match_value_contributions(services, tmp_path, query):
    worktree, preview, lineage = pipeline(services, tmp_path, query)
    engine = services[3]
    result = engine.column_lineage.describe(worktree, "dev", preview["node"], preview["port"], "total")
    value = lineage.explain(worktree, "dev", preview["id"], 0, "total")
    assert value["complete"] and result["complete"]
    assert {(r["node"], r["column"]) for r in result["steps"][0]["inputs"]} == {
        (c["node"], c["column"]) for c in value["contributions"]
    }
