"""Previews of a node's code on samples of its retained inputs, and the columns of its inputs.

A preview records no run, publishes no result and changes no status.
"""

import threading

import pytest
from fastapi.testclient import TestClient
from helpers import join_run

from duckpad.app import create_app
from duckpad.bundle import bundle_to_files
from duckpad.util import Problem

ORDERS = "id,country,amount\n" + "".join(f"{i},{['FR', 'DE', 'PT'][i % 3]},{i * 10}\n" for i in range(1, 301))
CODE = """-- @input source
-- @output result
SELECT * FROM {{ source }};
"""


def bundle(path, code=CODE):
    path.write_text(ORDERS)
    return {
        "flow": {
            "name": "Preview",
            "nodes": [
                {"id": "source", "template": "source", "params": {"file": str(path)}},
                {"id": "checked", "params": {}},
                {"id": "report", "params": {}},
            ],
            "edges": [
                {
                    "id": "source-checked",
                    "source": "source",
                    "sourceHandle": "result",
                    "target": "checked",
                    "targetHandle": "source",
                },
                {
                    "id": "checked-report",
                    "source": "checked",
                    "sourceHandle": "result",
                    "target": "report",
                    "targetHandle": "source",
                },
            ],
        },
        "templates": {
            "source": "-- @param file: file\n-- @output result\nSELECT * FROM read_csv({{ file }});",
        },
        "node_sql": {
            "nodes/checked.sql": code,
            "nodes/report.sql": "-- @input source\n-- @output result\nSELECT country, sum(amount) AS total "
            "FROM {{ source }} GROUP BY ALL ORDER BY country;\n",
        },
        "components": {},
        "documentation": {},
    }


@pytest.fixture
def project(services, tmp_path):
    store, projects, _, engine = services
    worktree = projects.create("Preview", bundle(tmp_path / "orders.csv"))["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success", run
    return worktree


def state(services, worktree):
    store, projects, _, engine = services
    return (
        engine.statuses(worktree, "dev"),
        [run["id"] for run in store.all("run")],
        projects.snapshot(worktree)["files"],
    )


def test_preview_computes_draft_code_on_input_samples_and_keeps_nothing(services, project):
    _, _, _, engine = services
    before = state(services, project)
    draft = (
        "-- @input source\n-- @output result\n"
        "SELECT country, count(*) AS orders FROM {{ source }} GROUP BY ALL ORDER BY country;\n"
    )
    preview = engine.draft_preview(project, "dev", "checked", draft, 100)
    assert preview["inputs"] == [
        {
            "input": "source",
            "node": "source",
            "port": "result",
            "status": "valid",
            "count": 300,
            "sampled": 100,
        }
    ]
    [output] = preview["outputs"]
    assert output["port"] == "result"
    assert [c["name"] for c in output["columns"]] == ["country", "orders"]
    # The first 100 input rows hold 33 or 34 orders per country.
    assert output["rows"] == [["DE", 34], ["FR", 33], ["PT", 33]]
    assert output["count"] == 3
    assert not output["truncated"]
    # No run, status, result or file changed.
    assert state(services, project) == before
    # Every row: the whole input.
    every = engine.draft_preview(project, "dev", "checked", draft, None)
    assert every["inputs"][0]["sampled"] == 300
    assert sum(row[1] for row in every["outputs"][0]["rows"]) == 300
    # Without a draft, the saved code is previewed.
    saved = engine.draft_preview(project, "dev", "checked")
    assert saved["outputs"][0]["count"] == 300
    assert state(services, project) == before


def test_preview_reports_errors_in_the_previewed_code(services, project):
    _, _, _, engine = services
    draft = "-- @input source\n-- @output result\nSELECT countryy\nFROM {{ source }};\n"
    with pytest.raises(Problem) as raised:
        engine.draft_preview(project, "dev", "checked", draft)
    assert raised.value.status == 422
    diagnostic = raised.value.detail["diagnostic"]
    assert "countryy" in diagnostic["message"]
    assert diagnostic["line"] == 3
    assert diagnostic["source"] == draft
    # Relations allocated for the preview read as the node's own references.
    assert "data_" not in diagnostic["message"]
    # A template error is reported without a location.
    with pytest.raises(Problem) as raised:
        engine.draft_preview(project, "dev", "checked", "-- @input source\n-- @bogus\nSELECT 1;\n")
    assert raised.value.status == 422
    with pytest.raises(Problem) as raised:
        engine.draft_preview(project, "dev", "checked", CODE, 7)
    assert raised.value.status == 422


def test_preview_skips_exports_tests_and_messages(services, project, tmp_path):
    _, _, _, engine = services
    destination = tmp_path / "preview-export.csv"
    draft = f"""-- @input source
-- @output result
SELECT * FROM {{{{ source }}}} WHERE amount > 2900;
-- @test large: warning
SELECT * FROM {{{{ result }}}} WHERE amount > 100;
-- @message
SELECT 'info' AS level, 'hello' AS message;
COPY {{{{ result }}}} TO '{destination}' (FORMAT CSV);
"""
    with pytest.raises(Problem):
        # An export needs a declared destination: the preview compiles it like a run.
        engine.draft_preview(project, "dev", "checked", draft)
    draft = """-- @input source
-- @output result
SELECT * FROM {{ source }} WHERE amount > 2900;
-- @test large: warning
SELECT * FROM {{ result }} WHERE amount > 100;
-- @message
SELECT 'info' AS level, 'hello' AS message;
"""
    preview = engine.draft_preview(project, "dev", "checked", draft, None)
    assert preview["skipped"] == {"exports": 0, "tests": 1, "messages": 1}
    assert [row[0] for row in preview["outputs"][0]["rows"]] == [
        291,
        292,
        293,
        294,
        295,
        296,
        297,
        298,
        299,
        300,
    ]


def test_preview_blocks_read_earlier_outputs_whole(services, project):
    _, _, _, engine = services
    draft = """-- @input source
-- @output repeated
SELECT s.* FROM {{ source }} AS s, range(100);
-- @output summary
SELECT count(*) AS orders, sum(amount) AS amount FROM {{ repeated }};
-- @output large
SELECT * FROM {{ repeated }} WHERE amount > 1000;
"""
    preview = engine.draft_preview(project, "dev", "checked", draft, None)
    repeated, summary, large = preview["outputs"]
    # The output that later blocks read is kept whole, as in a run.
    assert (repeated["count"], repeated["truncated"]) == (30_000, False)
    assert summary["rows"] == [[30_000, 100 * sum(range(10, 3001, 10))]]
    # An output that no block reads stops past the rows a preview keeps.
    assert (large["count"], large["truncated"]) == (10_000, True)
    assert len(large["rows"]) == 1_000


def test_preview_asks_to_run_ancestors_without_results(services, tmp_path):
    store, projects, _, engine = services
    worktree = projects.create("Fresh", bundle(tmp_path / "orders.csv"))["id"]
    with pytest.raises(Problem) as raised:
        engine.draft_preview(worktree, "dev", "report")
    assert raised.value.status == 409
    assert raised.value.detail["code"] == "inputs_not_materialized"
    assert raised.value.detail["missing"] == [{"input": "source", "node": "checked", "port": "result"}]
    # Running the ancestors computes the upstream nodes only.
    run = join_run(store, engine.launch(worktree, "dev", "report", ancestors=True)["id"])
    assert run["status"] == "success", run
    assert run["ancestors"] is True
    assert set(run["nodes"]) == {"source", "checked"}
    assert "report" not in engine.statuses(worktree, "dev")["nodes"]
    preview = engine.draft_preview(worktree, "dev", "report")
    rows = preview["outputs"][0]["rows"]
    assert [row[0] for row in rows] == ["DE", "FR", "PT"]
    assert sum(row[1] for row in rows) == sum(range(10, 3001, 10))
    with pytest.raises(Problem) as raised:
        engine.launch(worktree, "dev", "source", ancestors=True)
    assert raised.value.status == 422
    with pytest.raises(Problem) as raised:
        engine.launch(worktree, "dev", None, ancestors=True)
    assert raised.value.status == 422


def test_preview_is_refused_during_a_run_of_the_branch(services, project):
    _, _, _, engine = services
    token = {"id": "run_probe", "cancel": threading.Event(), "cursor": None}
    with engine.lock:
        engine.active[project] = token
    try:
        with pytest.raises(Problem) as raised:
            engine.draft_preview(project, "dev", "checked")
        assert raised.value.status == 409
        assert raised.value.detail == {"code": "run_active", "run": "run_probe"}
    finally:
        with engine.lock:
            engine.active.pop(project)


def test_preview_of_a_linked_node_uses_the_draft_template(services, project):
    _, _, _, engine = services
    draft = "-- @param file: file\n-- @output result\nSELECT count(*) AS total FROM read_csv({{ file }});"
    preview = engine.draft_preview(project, "dev", "source", draft)
    assert preview["inputs"] == []
    assert preview["outputs"][0]["rows"] == [[300]]


def test_input_columns_come_from_results_or_upstream_code(services, project, tmp_path):
    store, projects, _, engine = services
    columns = engine.input_columns(project, "dev", "report")
    [entry] = columns["inputs"]
    assert entry["origin"] == "result"
    assert entry["status"] == "valid"
    assert [c["name"] for c in entry["columns"]] == ["id", "country", "amount"]
    # A branch without results describes the upstream queries instead.
    fresh = projects.create("Fresh", bundle(tmp_path / "fresh.csv"))["id"]
    [entry] = engine.input_columns(fresh, "dev", "report")["inputs"]
    assert entry["origin"] == "description"
    assert [c["name"] for c in entry["columns"]] == ["id", "country", "amount"]
    assert not store.all("run") or all(run["worktree"] != fresh for run in store.all("run"))
    assert engine.statuses(fresh, "dev")["nodes"] == {}


def test_preview_over_http(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert (
            client.post("/api/login", json={"password": app.state.auth.initial_password}).status_code == 200
        )
        worktree = client.post("/api/projects", json={"name": "Preview"}).json()
        services = app.state.services
        snapshot = services.projects.snapshot(worktree["id"])
        # Isolated SQL workers read only the project's resources.
        folder = services.store.paths.resources(worktree["project"])
        folder.mkdir(parents=True, exist_ok=True)
        services.projects.write(
            worktree["id"], snapshot["revision"], bundle_to_files(bundle(folder / "orders.csv"))
        )
        path = f"/api/worktrees/{worktree['id']}"
        # Reading columns never starts the branch's SQL worker.
        columns = client.get(f"{path}/input-columns/report", params={"environment": "dev"})
        assert columns.json()["inputs"][0]["reason"] == "not_materialized"
        context = services.engine.pool.find(worktree["id"], "dev")
        assert context is None or context.db is None
        missing = client.post(f"{path}/draft-preview/report", json={"environment": "dev"})
        assert missing.status_code == 409
        assert missing.json()["detail"]["missing"][0]["input"] == "source"
        run = client.post(f"{path}/runs", json={"environment": "dev", "node": "report", "ancestors": True})
        assert run.status_code == 200, run.text
        join_run(services.store, run.json()["id"])
        response = client.post(
            f"{path}/draft-preview/report",
            json={"environment": "dev", "rows": 100, "code": CODE},
        )
        assert response.status_code == 200, response.text
        assert response.json()["outputs"][0]["count"] == 100
        columns = client.get(f"{path}/input-columns/report", params={"environment": "dev"})
        assert columns.json()["inputs"][0]["origin"] == "result"
