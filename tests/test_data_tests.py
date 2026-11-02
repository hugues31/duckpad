"""SQL data tests share the execution result boundary and never persist failing rows."""

import json
import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import example_bundle, join_run

from duckpad.app import create_app
from duckpad.bundle import bundle_to_files
from duckpad.execution.messages import result_counts
from duckpad.templates import compile_template, parse_template
from duckpad.util import Problem


def compile_sql(sql):
    template = parse_template(sql)
    return compile_template(
        template,
        {},
        dict.fromkeys(template["inputs"], '"input"'),
        {name: "out_" + name for name in template["outputs"]},
        {},
        Path(),
    )


def execute(services, worktree, target=None, environment="dev"):
    store, _, _, engine = services
    return join_run(store, engine.launch(worktree, environment, target)["id"])


def edit(services, worktree, change):
    projects = services[1]
    snapshot = projects.snapshot(worktree)
    change(snapshot["bundle"])
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))


@pytest.mark.parametrize(
    ("declaration", "error"),
    [
        ("-- @test", "name must be an identifier"),
        ("-- @test bad name", "name must be an identifier"),
        ("-- @test 1bad", "name must be an identifier"),
        ("-- @test valid: info", "Unknown @test severity"),
        ("-- @test valid:", "Unknown @test severity"),
        ("-- @test valid: WARNING", "Unknown @test severity"),
        ("-- @test valid: error\nSELECT 1;\n-- @test valid: warning", "Duplicate @test name"),
    ],
)
def test_invalid_test_declarations(declaration, error):
    with pytest.raises(Problem, match=error):
        parse_template("-- @output result\nSELECT 1;\n" + declaration + "\nSELECT 1;")


@pytest.mark.parametrize("suffix", ["-- @test empty", "-- @test empty\n-- @message\nSELECT 1;"])
def test_empty_test_blocks(suffix):
    with pytest.raises(Problem, match="@test block must contain a query"):
        parse_template("-- @output result\nSELECT 1;\n" + suffix)


@pytest.mark.parametrize(
    "query",
    [
        "SELECT * FROM hidden",
        "SELECT * FROM read_csv('/undeclared.csv')",
        "DELETE FROM {{ result }}",
        "COPY {{ result }} TO '/undeclared.csv'",
        "SELECT 1; SELECT 2",
    ],
)
def test_tests_follow_read_only_access_contract(query):
    with pytest.raises(Problem):
        compile_sql("-- @output result\nSELECT 1;\n-- @test valid\n" + query)


def test_default_severity_and_interleaved_block_order():
    statements = compile_sql("""-- @input source
-- @test result
SELECT * FROM {{ summary }};
-- @output result
SELECT * FROM {{ source }};
-- @message
SELECT 'info' AS level, 'Checked' AS message;
-- @output summary
SELECT * FROM {{ result }};
-- @test second: warning
SELECT * FROM {{ result }} JOIN {{ summary }} USING (id);
""")
    assert [s.get("test_name", s.get("message_block", s["output"])) for s in statements] == [
        "result",
        "summary",
        "result",
        1,
        "second",
    ]
    assert statements[2]["test_severity"] == "error"
    assert statements[2]["message_output"] == "summary"
    assert statements[-1]["message_output"] is None


@pytest.mark.parametrize("severity", ["error", "warning"])
def test_pass_fail_recovery_atomic_publication_history_and_logs(services, tmp_path, caplog, severity):
    store, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["filter"] += f"""
-- @param maximum: number = 100
-- @test amount: {severity}
SELECT * FROM {{{{ result }}}} WHERE amount > {{{{ maximum }}}};
-- @test complete
SELECT * FROM {{{{ result }}}} WHERE amount IS NULL;
"""
    wt = projects.create("Data tests", bundle)["id"]
    original = execute(services, wt)
    assert original["status"] == "success", original
    passed = original["nodes"]["filter"]["results"][0]
    assert passed == {
        "level": "info",
        "status": "ok",
        "message": "Test amount passed",
        "origin": {"kind": "test", "name": "amount"},
        "output": "result",
        "observed": 0,
    }
    previous = engine.preview(wt, "dev", "filter")
    edit(
        services,
        wt,
        lambda b: b["templates"].update(
            filter=b["templates"]["filter"].replace("= 100", "= 20")
            + "\n-- @output summary\nSELECT count(*) AS n FROM {{ result }};"
        ),
    )
    assert engine.preview(wt, "dev", "filter")["status"] == "stale"
    with caplog.at_level(logging.INFO, logger="duckpad.execution"):
        failed = execute(services, wt)
    state = failed["nodes"]["filter"]
    assert state["results"][0]["observed"] == 1
    assert state["results"][0]["status"] == severity
    assert state["results"][1]["status"] == "ok"
    records = [json.loads(r.message) for r in caplog.records if r.name == "duckpad.execution"]
    assert records == [
        {
            "event": "node_result",
            "run": failed["id"],
            "project": failed["project"],
            "branch": failed["branch"],
            "environment": "dev",
            "node": "filter",
            **state["results"][0],
        }
    ]
    if severity == "error":
        assert state["status"] == "failed"
        assert failed["nodes"]["total"]["status"] == "blocked"
        retained = engine.preview(wt, "dev", "filter")
        assert retained["id"] == previous["id"] and retained["status"] == "stale"
        assert retained["results"] == original["nodes"]["filter"]["results"]
        with pytest.raises(Problem, match="No materialized result"):
            engine.preview(wt, "dev", "filter", "summary")
        assert not any(
            d.run == failed["id"] and d.node == "filter" for d in engine.context(wt, "dev").datasets.values()
        )
    else:
        assert failed["status"] == "success" and failed["warning_count"] == 1
        assert engine.preview(wt, "dev", "filter")["run"] == failed["id"]
        assert engine.statuses(wt, "dev")["nodes"]["filter"]["results"] == state["results"]
    edit(
        services,
        wt,
        lambda b: b["templates"].update(filter=b["templates"]["filter"].replace("= 20", "= 100")),
    )
    recovered = execute(services, wt)
    assert recovered["status"] == "success"
    assert recovered["warning_count"] == 0
    execute(services, wt, "source")
    history = store.test_history(wt, "dev", "filter")
    assert [h["run"] for h in history] == [recovered["id"], failed["id"], original["id"]]
    assert history[1]["results"] == state["results"]
    assert store.test_history(wt, "dev", "filter", limit=1) == history[:1]
    assert store.test_history(wt, "prod", "filter") == []
    assert store.test_history(wt, "dev", "other") == []


def test_normal_node_retains_every_test_beyond_message_limit(services):
    store, projects, _, _ = services
    sql = """-- @kind source
-- @output result
SELECT range AS id, 'row-contents-must-not-be-retained' AS private_value FROM range(105);
-- @message
SELECT 'warning' AS level, 'Warning' AS message FROM {{ result }};
-- @test first: warning
SELECT * FROM {{ result }};
-- @message
SELECT 'warning' AS level, 'Another warning' AS message;
"""
    sql += "\n".join(f"-- @test check_{i}\nSELECT * FROM {{{{ result }}}} WHERE false;" for i in range(101))
    sql += "\n-- @test last\nSELECT * FROM {{ result }};"
    wt = projects.create(
        "Many tests",
        {
            "flow": {"nodes": [{"id": "rows", "params": {}}], "edges": []},
            "templates": {},
            "node_sql": {"nodes/rows.sql": sql},
            "components": {},
            "documentation": {},
        },
    )["id"]
    run = execute(services, wt)
    results = run["nodes"]["rows"]["results"]
    assert run["nodes"]["rows"]["status"] == "failed"
    tests = [r for r in results if r["origin"]["kind"] == "test"]
    assert len(tests) == 103
    assert tests[0]["observed"] == 105 and tests[-1]["observed"] == 105
    assert results[-1]["omitted"] == 6
    assert result_counts(results)["warning"] == run["warning_count"] == 107
    assert result_counts(results)["error"] == 1
    assert "row-contents-must-not-be-retained" not in json.dumps(results)
    assert len(store.test_history(wt, "dev", "rows")[0]["results"]) == 103


def test_isolated_export_cancel_and_persisted_history_api(tmp_path):
    home = tmp_path / "instance"
    app = create_app(home, watch=False)
    password = app.state.auth.initial_password
    with TestClient(app) as client:
        assert client.post("/api/login", json={"password": password}).status_code == 200
        wt = client.post("/api/projects", json={"name": "Tested export"}).json()["id"]
        services = app.state.services
        bundle = {
            "flow": {
                "nodes": [{"id": "source", "params": {}}, {"id": "export", "params": {}}],
                "edges": [
                    {
                        "id": "edge",
                        "source": "source",
                        "sourceHandle": "result",
                        "target": "export",
                        "targetHandle": "source",
                    }
                ],
            },
            "templates": {},
            "components": {},
            "documentation": {},
            "node_sql": {
                "nodes/source.sql": "-- @kind source\n-- @output result\nSELECT 1 AS id;",
                "nodes/export.sql": """-- @kind export
-- @input source
-- @param destination: destination = "tested.csv"
COPY {{ source }} TO {{ destination }} (FORMAT CSV, HEADER true);
-- @test valid
SELECT * FROM {{ source }} WHERE id > 1;
-- @test check_warning: warning
SELECT * FROM {{ source }};
""",
            },
        }
        snapshot = services.projects.snapshot(wt)
        services.projects.write(wt, snapshot["revision"], bundle_to_files(bundle))
        run = join_run(services.store, services.engine.launch(wt, "dev")["id"])
        assert run["status"] == "success", run
        assert run["warning_count"] == 1
        assert parse_template(bundle["node_sql"]["nodes/export.sql"])["download"]["format"] == "csv"
        target = services.store.paths.exports(wt, "dev") / "tested.csv"
        original = target.read_bytes()
        bundle["node_sql"]["nodes/source.sql"] = bundle["node_sql"]["nodes/source.sql"].replace(
            "SELECT 1", "SELECT 2"
        )
        snapshot = services.projects.snapshot(wt)
        services.projects.write(wt, snapshot["revision"], bundle_to_files(bundle))
        failed = join_run(services.store, services.engine.launch(wt, "dev")["id"])
        state = failed["nodes"]["export"]
        assert state["status"] == "failed" and not state.get("external_started")
        assert target.read_bytes() == original
        assert [r["status"] for r in state["results"]] == ["error", "warning"]
    reopened = create_app(home, watch=False)
    with TestClient(reopened) as client:
        url = f"/api/worktrees/{wt}/test-history/export?environment=dev"
        assert client.get(url).status_code == 401
        client.post("/api/login", json={"password": password})
        history = client.get(url).json()
        assert [h["run"] for h in history] == [failed["id"], run["id"]]
        assert history[0]["results"] == state["results"]
        assert (
            client.get(f"/api/runs/{failed['id']}").json()["nodes"]["export"]["results"] == state["results"]
        )
