"""Execution diagnostics point to authored SQL, including after a retained result."""

import pytest
from helpers import join_run

from duckpad.bundle import bundle_to_files
from duckpad.sql_errors import SqlSourceError, source_context
from duckpad.templates import parse_template


def project(services, sql):
    return services[1].create(
        "SQL errors",
        {
            "flow": {
                "nodes": [{"id": "source"}, {"id": "query"}],
                "edges": [
                    {
                        "id": "edge",
                        "source": "source",
                        "sourceHandle": "result",
                        "target": "query",
                        "targetHandle": "source",
                    }
                ],
            },
            "templates": {},
            "components": {},
            "node_sql": {
                "nodes/source.sql": "-- @output result\nSELECT 'France' AS country, 1 AS customer_id;",
                "nodes/query.sql": sql,
            },
        },
    )["id"]


@pytest.mark.parametrize(
    ("sql", "line", "message"),
    [
        ("SELECT countryy, COUNT(*) AS customers FROM {{ source }} GROUP BY ALL;", 4, "countryy"),
        ("SELECT\n  countryy\nFROM {{ source }};", 5, "countryy"),
        ("SELECT country FROM {{ source }} WHERE (", 4, "Syntax error"),
        ("SELECT\n  CAST(country AS INTEGER)\nFROM {{ source }};", 5, "Conversion Error"),
        (
            "SELECT * FROM {{ source }};\n-- @output other\nSELECT\n  countryy FROM {{ result }};",
            7,
            "countryy",
        ),
    ],
)
def test_failed_runs_report_authored_source(services, sql, line, message):
    code = "-- @label Customers\n-- @input source\n-- @output result\n" + sql
    worktree = project(services, code)
    store, _, _, engine = services
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    state = run["nodes"]["query"]
    assert state["status"] == "failed"
    diagnostic = state["diagnostic"]
    assert message in diagnostic["message"]
    assert diagnostic["line"] == line, diagnostic
    assert diagnostic["source"] == code
    assert "data_" not in diagnostic["message"]
    assert "DESCRIBE" not in diagnostic["message"]
    assert "data_" in diagnostic["executed_sql"]
    # Source locations only map errors back: runs record the executed statements alone.
    assert not any({"source_location", "executed_sql"} & set(s) for s in state.get("statements", []))


def test_latest_failure_survives_retained_data_and_clears_on_success(services):
    good = "-- @input source\n-- @output result\nSELECT * FROM {{ source }};"
    worktree = project(services, good)
    store, projects, _, engine = services
    assert not engine.statuses(worktree, "dev")["nodes"]

    def run():
        return join_run(store, engine.launch(worktree, "dev")["id"])

    success = run()
    snapshot = projects.snapshot(worktree)
    bad = good.replace("SELECT *", "SELECT countryy")
    projects.write(worktree, snapshot["revision"], {**snapshot["files"], "nodes/query.sql": bad})
    failure = run()
    state = engine.statuses(worktree, "dev")["nodes"]["query"]
    assert state["result_run"] == success["id"]
    assert state["error_run"] == failure["id"]
    assert state["diagnostic"]["source"] == bad
    assert state["outputs"]["result"]["status"] == "stale"
    snapshot = projects.snapshot(worktree)
    projects.write(worktree, snapshot["revision"], {**snapshot["files"], "nodes/query.sql": good})
    assert run()["status"] == "success"
    state = engine.statuses(worktree, "dev")["nodes"]["query"]
    assert not state["error"]
    assert not state.get("diagnostic")


def test_generated_relation_names_are_replaced_with_user_references():
    block = parse_template("-- @input source\n-- @output result\nSELECT country FROM {{ source }};")[
        "blocks"
    ][0]
    source = source_context(block, {"source": '"data_0123abcd"'})
    error = SqlSourceError(
        Exception('Binder Error: table "data_0123abcd" has no column country'), source, "SELECT country"
    )
    assert error.diagnostic["message"] == "Binder Error: table {{ source }} has no column country"


@pytest.mark.parametrize("retained", [False, True])
def test_blocked_nodes_expose_original_failures_from_the_same_run(services, retained):
    good = "-- @input source\n-- @output result\nSELECT * FROM {{ source }};"
    worktree = project(services, good)
    store, projects, _, engine = services
    snapshot = projects.snapshot(worktree)
    bundle = snapshot["bundle"]
    for node, sources in [
        ("middle", ["query"]),
        ("other", ["source"]),
        ("end", ["middle", "query", "other"]),
    ]:
        bundle["flow"]["nodes"].append({"id": node})
        for source in sources:
            bundle["flow"]["edges"].append(
                {
                    "id": source + node,
                    "source": source,
                    "sourceHandle": "result",
                    "target": node,
                    "targetHandle": source,
                }
            )
        bundle["node_sql"][f"nodes/{node}.sql"] = (
            "".join(f"-- @input {source}\n" for source in sources)
            + "-- @output result\nSELECT * FROM {{ "
            + sources[0]
            + " }};"
        )
    projects.write(worktree, snapshot["revision"], bundle_to_files(bundle))
    if retained:
        assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    snapshot = projects.snapshot(worktree)
    files = snapshot["files"]
    bad = good.replace("SELECT *", "SELECT countryy")
    projects.write(worktree, snapshot["revision"], {**files, "nodes/query.sql": bad, "nodes/other.sql": bad})
    failed = join_run(store, engine.launch(worktree, "dev")["id"])
    assert failed["nodes"]["end"]["status"] == "blocked"
    status = engine.statuses(worktree, "dev")["nodes"]["end"]
    assert bool(status["outputs"]) == retained
    causes = status["error_causes"]
    assert {cause["node"] for cause in causes} == {"query", "other"}
    assert len(causes) == 2
    for cause in causes:
        assert cause["error_run"] == failed["id"]
        assert "countryy" in cause["error"]
        assert cause["diagnostic"]["source"] == bad
    # Fixing and rerunning one ancestor must not rewrite the downstream failure's history.
    snapshot = projects.snapshot(worktree)
    projects.write(worktree, snapshot["revision"], files)
    assert join_run(store, engine.launch(worktree, "dev", "query")["id"])["status"] == "success"
    assert engine.statuses(worktree, "dev")["nodes"]["end"]["error_causes"] == causes
    assert not engine.statuses(worktree, "prod")["nodes"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    status = engine.statuses(worktree, "dev")["nodes"]["end"]
    assert not status["error"]
    assert not status.get("error_causes")
