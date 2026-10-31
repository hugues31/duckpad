"""Message contracts, atomic publication, provenance, redaction and shared result storage."""

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
from duckpad.util import Problem, literal


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


def execute(services, worktree, target=None):
    store, _, _, engine = services
    return join_run(store, engine.launch(worktree, "dev", target)["id"])


def edit(services, worktree, change):
    projects = services[1]
    snapshot = projects.snapshot(worktree)
    change(snapshot["bundle"])
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))


def test_messages_follow_all_outputs_in_declaration_order(services, tmp_path):
    _, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["total"] = """-- @input source
-- @param note: text = "Total: "
-- @message
SELECT 'warning' AS level, {{ note }} || total AS message FROM {{ summary }};
-- @output result
SELECT * FROM {{ source }};
-- @message
SELECT 'info' AS level, 'Second block' AS message;
-- @output summary
SELECT sum(amount) AS total FROM {{ result }};
-- @message
SELECT 'error' AS level, 'No rows' AS message WHERE false;
"""
    wt = projects.create("Messages", bundle)["id"]
    run = execute(services, wt)
    assert run["status"] == "success", run
    assert run["warning_count"] == 1
    state = run["nodes"]["total"]
    assert [s.get("message_block", s["output"]) for s in state["statements"]] == [
        "result",
        "summary",
        1,
        2,
        3,
    ]
    assert state["results"] == [
        {
            "level": "warning",
            "message": "Total: 60",
            "origin": {"kind": "message", "block": 1},
            "output": "summary",
        },
        {
            "level": "info",
            "message": "Second block",
            "origin": {"kind": "message", "block": 2},
            "output": None,
        },
    ]
    assert engine.preview(wt, "dev", "total")["results"] == state["results"]
    assert engine.statuses(wt, "dev")["nodes"]["total"]["results"] == state["results"]
    # A launch outside this node's scope retains the generation and its messages.
    execute(services, wt, "source")
    assert engine.statuses(wt, "dev")["nodes"]["total"]["result_run"] == run["id"]
    assert engine.preview(wt, "dev", "total")["results"] == state["results"]


def test_error_retains_previous_outputs_and_messages_and_blocks_descendants(services, tmp_path):
    _, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["filter"] += (
        "\n-- @message\nSELECT 'warning' AS level, 'Original warning' AS message;"
    )
    wt = projects.create("Messages", bundle)["id"]
    original = execute(services, wt)
    previous = engine.preview(wt, "dev", "filter")

    def change(bundle):
        bundle["templates"]["filter"] += (
            "\n-- @output summary\nSELECT count(*) AS n FROM {{ result }};"
            "\n-- @message\nSELECT 'error' AS level, 'Invalid amount' AS message;"
            "\n-- @message\nSELECT 'info' AS level, 'Last block still checked' AS message;"
        )

    edit(services, wt, change)
    assert engine.preview(wt, "dev", "filter")["status"] == "stale"
    run = execute(services, wt)
    assert run["nodes"]["filter"]["status"] == "failed"
    assert run["nodes"]["filter"]["error"] == "Invalid amount"
    assert run["nodes"]["total"]["status"] == "blocked"
    assert len(run["nodes"]["filter"]["results"]) == 3
    retained = engine.preview(wt, "dev", "filter")
    assert retained["id"] == previous["id"] and retained["status"] == "stale"
    assert retained["results"] == original["nodes"]["filter"]["results"]
    with pytest.raises(Problem, match="No materialized result"):
        engine.preview(wt, "dev", "filter", "summary")
    assert not any(
        d.run == run["id"] and d.node == "filter" for d in engine.context(wt, "dev").datasets.values()
    )


@pytest.mark.parametrize("level", ["warning", "error"])
def test_limit_counts_all_rows_and_does_not_hide_a_late_error(services, level):
    _, projects, _, engine = services
    sql = f"""-- @kind source
-- @output result
SELECT range AS id FROM range(105);
-- @message
SELECT 'warning' AS level, 'Item ' || id AS message FROM {{{{ result }}}} ORDER BY id;
-- @message
SELECT '{level}' AS level, 'Final result' AS message;
"""
    wt = projects.create(
        "Many messages",
        {
            "flow": {"nodes": [{"id": "rows", "params": {}}], "edges": []},
            "templates": {},
            "node_sql": {"nodes/rows.sql": sql},
            "components": {},
            "documentation": {},
        },
    )["id"]
    run = execute(services, wt)
    state = run["nodes"]["rows"]
    assert state["status"] == ("failed" if level == "error" else "success")
    assert run["warning_count"] == (105 if level == "error" else 106)
    results = state["results"]
    assert len(results) == 101
    assert results[99]["message"] == "Item 99"
    assert results[-1]["omitted"] == 6
    assert results[-1]["message"] == "… and 6 more"
    assert result_counts(results)[level] == (1 if level == "error" else 106)
    assert engine.statuses(wt, "dev")["nodes"]["rows"]["results"] == results
    if level == "error":
        assert state["error"] == "Final result"
        assert not engine.context(wt, "dev").datasets


@pytest.mark.parametrize(
    ("query", "error"),
    [
        ("SELECT 'info' AS level", "level and message columns"),
        ("SELECT 'text' AS message WHERE false", "level and message columns"),
        ("SELECT 'debug' AS level, 'text' AS message", "unknown level 'debug'"),
        ("SELECT NULL AS level, 'text' AS message", "unknown level"),
        ("SELECT 'info' AS level, NULL AS message", "non-null text"),
        ("SELECT 'info' AS level, 42 AS message", "non-null text"),
    ],
)
def test_invalid_message_results_fail_without_publication(services, tmp_path, query, error):
    _, projects, _, engine = services
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["filter"] += "\n-- @message\n" + query
    wt = projects.create("Invalid messages", bundle)["id"]
    run = execute(services, wt)
    assert run["nodes"]["filter"]["status"] == "failed", run
    assert error in run["nodes"]["filter"]["error"]
    assert run["nodes"]["total"]["status"] == "blocked"
    assert not engine.context(wt, "dev").outputs.get("filter")


@pytest.mark.parametrize(
    "query",
    [
        "SELECT * FROM hidden",
        "SELECT * FROM read_csv('/undeclared.csv')",
        "DELETE FROM {{ result }}",
        "COPY {{ result }} TO '/undeclared.csv'",
        "SELECT 'info' AS level, 'one' AS message; SELECT 2",
    ],
)
def test_messages_cannot_access_undeclared_data_or_change_outputs(query):
    with pytest.raises(Problem):
        compile_sql("-- @output result\nSELECT 1 AS x;\n-- @message\n" + query)


@pytest.mark.parametrize(
    "suffix", ["-- @message named\nSELECT 1", "-- @message", "-- @message\n-- @message\nSELECT 1"]
)
def test_message_directives_reject_arguments_and_empty_blocks(suffix):
    with pytest.raises(Problem, match="@message"):
        parse_template("-- @output result\nSELECT 1;\n" + suffix)


def test_output_blocks_still_reject_forward_references():
    with pytest.raises(Problem, match="forward reference"):
        compile_sql("-- @output first\nSELECT * FROM {{ later }};\n-- @output later\nSELECT 1;")


def test_messages_are_redacted_in_results_previews_errors_and_logs(services, tmp_path, caplog):
    store, projects, catalog, engine = services
    secret = "message-secret-distinctive-value"
    catalog.save(
        "connector",
        {
            "id": "hidden",
            "name": "Hidden",
            "parameters": [{"name": "password", "type": "text", "secret": True}],
            "capabilities": ["read"],
            "init_sql": "",
        },
    )
    catalog.save(
        "connection",
        {
            "id": "hidden",
            "name": "Hidden",
            "connector": "hidden",
            "environments": {"dev": {"password": secret}},
        },
        create=True,
    )
    bundle = example_bundle(tmp_path / "input.csv")
    bundle["templates"]["filter"] += (
        '\n-- @param connection: connection = "hidden"\n-- @message\n'
        f"SELECT 'warning' AS level, {literal(secret + chr(10) + 'second line')} AS message;"
    )
    wt = projects.create("Redacted messages", bundle)["id"]
    with caplog.at_level(logging.INFO, logger="duckpad.execution"):
        run = execute(services, wt)
    assert run["status"] == "success", run
    records = [json.loads(r.message) for r in caplog.records if r.name == "duckpad.execution"]
    assert len(records) == 1
    assert records[0] == {
        "event": "node_result",
        "run": run["id"],
        "project": run["project"],
        "branch": run["branch"],
        "environment": "dev",
        "node": "filter",
        **run["nodes"]["filter"]["results"][0],
    }
    assert secret not in json.dumps(
        [store.get("run", run["id"]), engine.preview(wt, "dev", "filter"), records]
    )
    assert "second line" in records[0]["message"]
    edit(
        services,
        wt,
        lambda b: b["templates"].update(filter=b["templates"]["filter"].replace("'warning'", "'error'")),
    )
    failed = execute(services, wt)
    assert failed["nodes"]["filter"]["status"] == "failed"
    assert secret not in str(failed)


def test_isolated_export_checks_precede_writes_and_survive_in_history(tmp_path):
    home = tmp_path / "instance"
    app = create_app(home, watch=False)
    password = app.state.auth.initial_password
    with TestClient(app) as client:
        assert client.post("/api/login", json={"password": password}).status_code == 200
        tree = client.post("/api/projects", json={"name": "Checked export"}).json()
        wt = tree["id"]
        services = app.state.services
        bundle = {
            "flow": {
                "nodes": [
                    {"id": "source", "template": "source", "params": {}},
                    {"id": "export", "template": "export", "params": {}},
                ],
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
            "templates": {
                "source": "-- @kind source\n-- @output result\nSELECT 1 AS id;",
                "export": """-- @kind export
-- @input source
-- @param destination: destination = "checked.csv"
COPY {{ source }} TO {{ destination }} (FORMAT CSV, HEADER true);
-- @message
SELECT 'warning' AS level, count(*) || ' rows to export' AS message FROM {{ source }};
""",
            },
            "components": {},
            "documentation": {},
        }
        snapshot = services.projects.snapshot(wt)
        services.projects.write(wt, snapshot["revision"], bundle_to_files(bundle))
        assert services.engine.isolated
        assert (
            client.get(f"/api/worktrees/{wt}").json()["parsed_templates"]["export"]["download"]["format"]
            == "csv"
        )
        run = join_run(services.store, services.engine.launch(wt, "dev")["id"])
        assert run["status"] == "success", run
        assert run["warning_count"] == 1
        target = services.store.paths.exports(wt, "dev") / "checked.csv"
        original = target.read_bytes()
        assert b"1" in original
        bundle["templates"]["source"] = bundle["templates"]["source"].replace("SELECT 1", "SELECT 2")
        bundle["templates"]["export"] += (
            "\n-- @message\nSELECT 'error' AS level, 'Export prevented' AS message;"
        )
        snapshot = services.projects.snapshot(wt)
        services.projects.write(wt, snapshot["revision"], bundle_to_files(bundle))
        failed = join_run(services.store, services.engine.launch(wt, "dev")["id"])
        state = failed["nodes"]["export"]
        assert state["status"] == "failed" and state["error"] == "Export prevented"
        assert state["external_outcome"] == "failed" and not state.get("external_started")
        assert target.read_bytes() == original
        assert (
            client.get(f"/api/worktrees/{wt}/status?environment=dev").json()["nodes"]["export"]["results"]
            == state["results"]
        )
    # History is persisted with node runs, independently of in-memory SQL contexts.
    reopened = create_app(home, watch=False)
    with TestClient(reopened) as client:
        client.post("/api/login", json={"password": password})
        stored = client.get(f"/api/runs/{failed['id']}").json()
        assert stored["nodes"]["export"]["results"] == state["results"]
        assert stored["warning_count"] == 1
