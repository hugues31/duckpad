"""Hypothetical schemas reveal downstream failures without reading or writing rows."""

from copy import deepcopy

import pytest
from helpers import join_run

from duckpad.bundle import bundle_to_files
from duckpad.example import create_example
from duckpad.schema_impact import review_impact, simulate
from duckpad.util import Problem


def flow(services):
    _, projects, _, _ = services
    codes = {
        "source": "-- @output result\nSELECT 1::INTEGER AS amount, 'West' AS region;",
        "carry": "-- @input input\n-- @output result\nSELECT * FROM {{ input }};",
        "sum": "-- @input input\n-- @output result\nSELECT SUM(amount) AS total FROM {{ input }};",
        "export": "-- @input input\nCOPY (SELECT * FROM {{ input }}) TO 'should-not-exist.csv';",
    }
    bundle = {
        "flow": {
            "nodes": [{"id": key} for key in codes],
            "edges": [
                {"id": f"e{i}", "source": a, "sourceHandle": "result", "target": b, "targetHandle": "input"}
                for i, (a, b) in enumerate([("source", "carry"), ("carry", "sum"), ("sum", "export")])
            ],
        },
        "templates": {},
        "components": {},
        "node_sql": {f"nodes/{key}.sql": text for key, text in codes.items()},
    }
    return projects.create("Schema impact", bundle)["id"]


def test_simulation_propagates_types_and_stops_at_failure(services):
    store, projects, _, engine = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree)
    result = simulate(engine, worktree, "dev", "source", "result", "amount", "VARCHAR")
    assert result["before"] == "INTEGER"
    assert result["after"] == "VARCHAR"
    assert {c["node"] for c in result["changes"]} == {"source", "carry"}
    assert {f["node"] for f in result["failures"]} == {"sum"}
    assert "Binder Error" in result["failures"][0]["error"]
    assert not result["failures"][0]["existing"]
    assert {f["node"] for f in result["unknown"]} == {"export"}
    assert {e["node"] for e in result["exports"]} == {"export"}
    assert not store.all("run")
    assert projects.snapshot(worktree)["revision"] == snapshot["revision"]
    valid = simulate(engine, worktree, "dev", "source", "result", "amount", "DOUBLE")
    assert not valid["failures"]
    assert not valid["unknown"]
    assert {c["node"] for c in valid["changes"]} == {"source", "carry", "sum"}


@pytest.mark.parametrize(
    "new_type", ["not_a_type", "INTEGER); SELECT 1; --", "VARCHAR); COPY (SELECT 1) TO 'bad.csv'; --"]
)
def test_type_validation(services, new_type):
    worktree = flow(services)
    with pytest.raises(Problem, match="valid DuckDB type"):
        simulate(services[3], worktree, "dev", "source", "result", "amount", new_type)


def test_review_reports_unchanged_broken_consumers(services):
    store, projects, _, engine = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree)
    candidate = deepcopy(snapshot["bundle"])
    candidate["node_sql"]["nodes/carry.sql"] = (
        "-- @input input\n-- @output result\nSELECT amount AS value, region FROM {{ input }};"
    )
    result = review_impact(engine, worktree, "dev", snapshot["files"], bundle_to_files(candidate))
    change = next(c for c in result["changes"] if c["node"] == "carry")
    assert change["renamed"] == [{"before": "amount", "after": "value"}]
    failure = next(f for f in result["failures"] if f["node"] == "sum")
    assert not failure["direct"] and not failure["existing"]
    assert "amount" in failure["error"]
    assert {e["node"] for e in result["exports"]} == {"export"}
    assert not store.all("run")


def test_northstar_uses_only_source_metadata(services, monkeypatch):
    store, projects, catalog, engine = services
    worktree = create_example(projects, catalog)["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    runs = len(store.all("run"))
    monkeypatch.setattr(engine, "launch", lambda *a, **kw: pytest.fail("Simulation launched a run"))
    result = simulate(engine, worktree, "dev", "orders", "result", "amount", "VARCHAR")
    assert {f["node"] for f in result["failures"]} >= {"net", "validated"}
    assert result["exports"]
    assert len(store.all("run")) == runs


def test_unknown_source_does_not_look_like_deleted_columns(services, tmp_path):
    _, projects, _, engine = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree)
    candidate = deepcopy(snapshot["bundle"])
    candidate["node_sql"]["nodes/source.sql"] = (
        f"-- @output result\nSELECT * FROM read_csv('{tmp_path / 'missing.csv'}');"
    )
    result = review_impact(engine, worktree, "dev", snapshot["files"], bundle_to_files(candidate))
    assert result["unknown"]
    assert not result["changes"]
    assert not result["failures"]


def test_review_reports_added_and_removed_outputs(services):
    _, projects, _, engine = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree)
    candidate = deepcopy(snapshot["bundle"])
    candidate["node_sql"]["nodes/carry.sql"] += "\n-- @output extra\nSELECT amount FROM {{ input }};"
    files = bundle_to_files(candidate)
    result = review_impact(engine, worktree, "dev", snapshot["files"], files)
    assert next(c for c in result["changes"] if c["port"] == "extra")["added"] == ["amount"]
    result = review_impact(engine, worktree, "dev", files, snapshot["files"])
    assert next(c for c in result["changes"] if c["port"] == "extra")["removed"] == ["amount"]


@pytest.mark.parametrize("aggregate", ["SUM(amount)", "COUNT(*)"])
def test_export_impact_tracks_columns_and_row_selection(services, aggregate):
    _, projects, _, engine = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree)
    snapshot["bundle"]["node_sql"]["nodes/sum.sql"] = snapshot["bundle"]["node_sql"]["nodes/sum.sql"].replace(
        "SUM(amount)", aggregate
    )
    snapshot["files"] = bundle_to_files(snapshot["bundle"])
    candidate = deepcopy(snapshot["bundle"])
    # The export does not use region, so an independent region rename does not affect it.
    candidate["node_sql"]["nodes/carry.sql"] = (
        "-- @input input\n-- @output result\nSELECT amount, region AS area FROM {{ input }};"
    )
    result = review_impact(engine, worktree, "dev", snapshot["files"], bundle_to_files(candidate))
    assert not result["exports"]
    candidate["node_sql"]["nodes/carry.sql"] = (
        "-- @input input\n-- @output result\nSELECT * FROM {{ input }} WHERE region = 'West';"
    )
    result = review_impact(engine, worktree, "dev", snapshot["files"], bundle_to_files(candidate))
    assert {e["node"] for e in result["exports"]} == {"export"}


def test_simulation_handles_earlier_output(services):
    _, projects, _, engine = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree)
    bundle = deepcopy(snapshot["bundle"])
    bundle["node_sql"]["nodes/source.sql"] = (
        "-- @output first\nSELECT 1::INTEGER AS amount;\n-- @output result\nSELECT amount * 2 AS amount FROM {{ first }};"
    )
    projects.write(worktree, snapshot["revision"], bundle_to_files(bundle))
    result = simulate(engine, worktree, "dev", "source", "first", "amount", "VARCHAR")
    assert any(f["node"] == "source" and f["port"] == "result" for f in result["failures"])
    assert {f["node"] for f in result["unknown"]} >= {"carry", "sum", "export"}


def test_python_is_an_unknown_boundary_without_execution(services):
    from test_python_nodes import flow as python_flow

    store, projects, _, engine = services
    worktree = python_flow(services)["id"]
    snapshot = projects.snapshot(worktree)
    snapshot["bundle"]["templates"]["source"] = "-- @output result\nSELECT 1::INTEGER AS x;"
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    result = simulate(engine, worktree, "dev", "source", "result", "x", "DOUBLE")
    assert any(f["node"] == "python" and f["reason"] == "python" for f in result["unknown"])
    assert any(f["node"] == "total" and f["reason"] == "upstream" for f in result["unknown"])
    assert not store.all("run")


def test_compilation_does_not_read_external_sources_or_write_exports(services, monkeypatch):
    import duckdb

    store, projects, catalog, engine = services
    worktree = create_example(projects, catalog)["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    real_connect = duckdb.connect
    statements = []

    class Guard:
        def __init__(self, *args, **kwargs):
            self.connection = real_connect(*args, **kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.connection.close()

        def execute(self, sql, *args):
            statements.append(sql)
            assert "read_csv" not in sql.lower() and "read_parquet" not in sql.lower()
            assert sql.startswith(("DESCRIBE ", "CREATE TABLE "))
            return self.connection.execute(sql, *args)

    monkeypatch.setattr(duckdb, "connect", Guard)
    snapshot = projects.snapshot(worktree)
    candidate = deepcopy(snapshot["bundle"])
    candidate["templates"]["net_amounts"] = candidate["templates"]["net_amounts"].replace(
        "net_amount", "net_value"
    )
    report = review_impact(engine, worktree, "dev", snapshot["files"], bundle_to_files(candidate))
    assert report["failures"]
    assert statements
    simulated = simulate(engine, worktree, "dev", "orders", "result", "amount", "VARCHAR")
    assert simulated["failures"]


def test_function_from_an_unloaded_extension_is_not_a_compilation_error(services):
    _, projects, _, engine = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree)
    bundle = deepcopy(snapshot["bundle"])
    bundle["node_sql"]["nodes/carry.sql"] = (
        "-- @input input\n-- @output result\nSELECT *, ST_Point(1, 2) AS point FROM {{ input }};"
    )
    projects.write(worktree, snapshot["revision"], bundle_to_files(bundle))
    result = simulate(engine, worktree, "dev", "source", "result", "amount", "DOUBLE")
    assert not result["failures"]
    assert any(f["node"] == "carry" and f["reason"] == "extension" for f in result["unknown"])
    assert any(f["node"] == "sum" and f["reason"] == "upstream" for f in result["unknown"])
