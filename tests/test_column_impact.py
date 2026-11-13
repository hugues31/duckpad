"""Impact and rename operate on definitions, preserving SQL and independent branches."""

import pytest
from helpers import join_run

from duckpad.bundle import bundle_to_files
from duckpad.column_impact import inspect, rename
from duckpad.column_references import references, replace_spans
from duckpad.example import create_example
from duckpad.util import Problem


@pytest.mark.parametrize(
    ("query", "expected", "outputs"),
    [
        (
            "SELECT a.amount, b.amount AS other FROM a JOIN b ON a.id=b.id WHERE a.amount>0",
            "SELECT a.value, b.amount AS other FROM a JOIN b ON a.id=b.id WHERE a.value>0",
            {"amount"},
        ),
        (
            "WITH c AS (SELECT amount FROM a) SELECT amount FROM c",
            "WITH c AS (SELECT value FROM a) SELECT value FROM c",
            {"amount"},
        ),
        (
            "WITH c(x) AS (SELECT amount FROM a) SELECT x FROM c",
            "WITH c(x) AS (SELECT value FROM a) SELECT x FROM c",
            set(),
        ),
        (
            "SELECT amount AS fixed, 'amount' AS note FROM a -- amount\n",
            "SELECT value AS fixed, 'amount' AS note FROM a -- amount\n",
            set(),
        ),
        ('SELECT "amount" FROM a', 'SELECT "value" FROM a', {"amount"}),
        ("SELECT * FROM a", "SELECT * FROM a", {"amount"}),
    ],
)
def test_scoped_spans(query, expected, outputs):
    schema = {table: {"amount": "INT", "id": "INT"} for table in ("a", "b")}
    spans, changed = references(query, schema, {"a": {"amount"}})
    assert replace_spans(query, spans, "value") == expected
    assert changed == outputs


def test_northstar_impact_and_atomic_rename(services):
    store, projects, catalog, engine = services
    worktree = create_example(projects, catalog)["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    impact, _ = inspect(engine, worktree, "dev", "orders", "result", "amount")
    assert impact["source"]
    assert {e["label"] for e in impact["edit"]} >= {
        "overview",
        "amount_positive",
        "large_order_review",
        "Orders to review",
    }
    assert {e["node"] for e in impact["edit"]} >= {
        "net",
        "validated",
        "report::summary::eligible",
        "report::summary::metrics",
    }
    assert {e["column"] for e in impact["derived"]} >= {"net_amount", "net_revenue", "net_share"}
    assert "period" in {e["node"] for e in impact["unaffected"]}
    assert impact["exports"]
    assert not impact["manual"], impact["manual"]
    before = projects.snapshot(worktree)
    head = projects.git(before["worktree"]["path"], "rev-parse", "HEAD")
    plan, _ = inspect(engine, worktree, "dev", "net", "result", "net_amount", new_name="net_value")
    assert not plan["manual"], plan["manual"]
    assert not plan["source"]
    assert plan["changes"]
    result = rename(
        engine, worktree, "dev", "net", "result", "net_amount", "net_value", plan["revision"], plan["token"]
    )
    after = projects.snapshot(worktree)
    path = after["worktree"]["path"]
    assert projects.git(path, "rev-list", "--count", head + "..HEAD") == "1"
    assert set(projects.git(path, "diff", "--name-only", head, "HEAD").splitlines()) == {
        c["file"] for c in plan["changes"]
    }
    assert result["revision"] != before["revision"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success", run
    output = engine.column_lineage.describe(worktree, "dev", "net", "result")
    assert "net_value" in {c["name"] for c in output["outputs"][0]["columns"]}
    assert "net_amount" not in {c["name"] for c in output["outputs"][0]["columns"]}
    projects.revert(worktree, after["commit"], relock=False)
    assert projects.snapshot(worktree)["files"] == before["files"]


def literal_project(projects):
    def edge(source, target):
        return {
            "id": source + target,
            "source": source,
            "sourceHandle": "result",
            "target": target,
            "targetHandle": "source",
        }

    return projects.create(
        "Independent branches",
        {
            "flow": {
                "nodes": [
                    {"id": "a"},
                    {"id": "b"},
                    {"id": "left", "component": "shared"},
                    {"id": "right", "component": "shared"},
                ],
                "edges": [edge("a", "left"), edge("b", "right")],
            },
            "components": {
                "shared": {
                    "id": "shared",
                    "name": "Shared",
                    "nodes": [{"id": "inner", "template": "calc"}],
                    "edges": [],
                    "inputs": {"source": {"node": "inner", "port": "source"}},
                    "outputs": {"result": {"node": "inner", "port": "result"}},
                }
            },
            "templates": {
                "calc": "-- @input source\n-- @output result\n-- amount stays in this comment\nSELECT amount, amount * 2 AS total FROM {{ source }};\n"
            },
            "node_sql": {
                "nodes/a.sql": "-- @output result\nSELECT 2 AS amount;",
                "nodes/b.sql": "-- @output result\nSELECT 5 AS amount;",
            },
            "documentation": {"columns": {"a:result": {"amount": "Gross amount"}}},
            "views": {
                "left:result": [{"name": "Review", "filter": "amount > 0", "order": [["amount", "desc"]]}]
            },
            "variables": {"selected": {"type": "number", "from": {"node": "a", "column": "amount"}}},
        },
    )["id"]


def test_shared_definitions_keep_other_branches_and_metadata(services, monkeypatch):
    store, projects, _, engine = services
    worktree = literal_project(projects)
    # Static analysis describes empty schemas only: no execution or external reads.
    monkeypatch.setattr(engine, "launch", lambda *args: pytest.fail("Unexpected run"))
    plan, updated = inspect(engine, worktree, "dev", "a", "result", "amount", new_name="value")
    assert not plan["source"] and not plan["manual"]
    assert not store.all("run")
    assert updated["templates"]["calc"].count("amount") == 3
    assert updated["flow"]["nodes"][3]["component"] == "shared"
    assert updated["flow"]["nodes"][2]["component"] != "shared"
    variant = updated["flow"]["nodes"][2]["component"]
    assert "SELECT value, value * 2 AS total" in updated["node_sql"][f"components/{variant}/inner.sql"]
    assert updated["variables"]["selected"]["from"]["column"] == "value"
    assert updated["views"]["left:result"][0]["filter"] == "value > 0"
    assert updated["documentation"]["columns"]["a:result"] == {"value": "Gross amount"}
    before = projects.snapshot(worktree)
    with pytest.raises(Problem, match="schemas changed"):
        rename(engine, worktree, "dev", "a", "result", "amount", "value", plan["revision"], "wrong")
    assert projects.snapshot(worktree)["revision"] == before["revision"]
    rename(engine, worktree, "dev", "a", "result", "amount", "value", plan["revision"], plan["token"])
    with pytest.raises(Problem, match="project changed"):
        rename(engine, worktree, "dev", "a", "result", "amount", "value", plan["revision"], plan["token"])
    left = engine.column_lineage.describe(worktree, "dev", "left", "result")
    right = engine.column_lineage.describe(worktree, "dev", "right", "result")
    assert {c["name"] for c in left["outputs"][0]["columns"]} == {"value", "total"}
    assert {c["name"] for c in right["outputs"][0]["columns"]} == {"amount", "total"}


def test_unsupported_sql_is_reported_and_not_rewritten(services):
    _, projects, _, engine = services
    worktree = literal_project(projects)
    snapshot = projects.snapshot(worktree)
    sql = "-- @input source\n-- @output result\nSELECT COLUMNS('amount') FROM {{ source }};"
    snapshot["bundle"]["templates"]["calc"] = sql
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    plan, updated = inspect(engine, worktree, "dev", "a", "result", "amount", new_name="value")
    assert any(e["node"] == "left::inner" for e in plan["manual"])
    assert updated["templates"]["calc"] == sql


@pytest.mark.parametrize("projection", ["amount", "*"])
def test_carried_output_rename_introduces_a_local_alias(services, projection):
    store, projects, _, engine = services
    worktree = literal_project(projects)
    snapshot = projects.snapshot(worktree)
    snapshot["bundle"]["templates"]["calc"] = (
        f"-- @input source\n-- @output result\nSELECT {projection} FROM {{{{ source }}}};"
    )
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    plan, _ = inspect(engine, worktree, "dev", "left", "result", "amount", new_name="value")
    assert not plan["manual"], plan["manual"]
    rename(engine, worktree, "dev", "left", "result", "amount", "value", plan["revision"], plan["token"])
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    result = engine.column_lineage.describe(worktree, "dev", "left", "result")
    assert [c["name"] for c in result["outputs"][0]["columns"]] == ["value"]
    assert "AS amount" in projects.snapshot(worktree)["files"]["nodes/a.sql"]


def test_saved_fields_partition_keys_and_source_formatting(services):
    _, projects, _, engine = services
    worktree = literal_project(projects)
    snapshot = projects.snapshot(worktree)
    bundle = snapshot["bundle"]
    bundle["charts"] = {
        "a:result": [
            {
                "name": "Amount",
                "spec": {
                    "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
                    "data": {"name": "data"},
                    "mark": "bar",
                    "encoding": {"x": {"field": "amount", "type": "quantitative"}},
                },
            }
        ]
    }
    bundle["flow"]["partitions"] = {"batch": {"type": "number", "values": {"node": "b", "column": "amount"}}}
    bundle["flow"]["nodes"][0]["outputs"] = {"result": {"partition": {"by": "batch", "column": "amount"}}}
    proposal = bundle_to_files(bundle)
    # An independent document with hand-authored JSON formatting must stay byte-identical.
    proposal["variables.json"] = '{"selected": {"type":"number", "default":2}}\n'
    projects.write(worktree, snapshot["revision"], proposal)
    before = projects.snapshot(worktree)
    plan, updated = inspect(engine, worktree, "dev", "a", "result", "amount", new_name="value")
    assert not plan["manual"], plan["manual"]
    assert updated["flow"]["nodes"][0]["outputs"]["result"]["partition"]["column"] == "value"
    assert updated["charts"]["a:result"][0]["spec"]["encoding"]["x"]["field"] == "value"
    rename(engine, worktree, "dev", "a", "result", "amount", "value", plan["revision"], plan["token"])
    assert projects.snapshot(worktree)["files"]["variables.json"] == before["files"]["variables.json"]


def test_python_is_manual_and_keeps_its_code(services):
    from test_python_nodes import flow

    store, projects, _, engine = services
    worktree = flow(services)["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    source = engine.column_lineage.describe(worktree, "dev", "source", "result")
    column = source["outputs"][0]["columns"][0]["name"]
    before = projects.snapshot(worktree)
    plan, updated = inspect(engine, worktree, "dev", "source", "result", column, new_name="renamed")
    assert any(entry["reason"] == "python" for entry in plan["manual"])
    assert {p: s for p, s in updated["node_sql"].items() if p.endswith(".py")} == {
        p: s for p, s in before["bundle"]["node_sql"].items() if p.endswith(".py")
    }


def test_expression_lists_keep_formatting_and_unrelated_instance(services):
    _, projects, _, engine = services
    worktree = literal_project(projects)
    snapshot = projects.snapshot(worktree)
    bundle = snapshot["bundle"]
    bundle["templates"]["calc"] = (
        "-- @input source\n-- @param columns: expressions\n-- @output result\nSELECT {{ columns }} FROM {{ source }};"
    )
    bundle["components"]["shared"]["nodes"][0]["params"] = {"columns": ["AMOUNT", "amount *  2 AS total"]}
    projects.write(worktree, snapshot["revision"], bundle_to_files(bundle))
    plan, updated = inspect(engine, worktree, "dev", "a", "result", "amount", new_name="value")
    assert not plan["manual"], plan["manual"]
    left = updated["flow"]["nodes"][2]["component"]
    assert updated["components"][left]["nodes"][0]["params"]["columns"] == ["value", "value *  2 AS total"]
    assert updated["components"]["shared"]["nodes"][0]["params"]["columns"] == [
        "AMOUNT",
        "amount *  2 AS total",
    ]


@pytest.mark.parametrize("name", ["has spaces", "1bad", "__dp_private", "amount"])
def test_rejected_rename_writes_nothing(services, name):
    store, projects, catalog, engine = services
    worktree = create_example(projects, catalog)["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    before = projects.snapshot(worktree)
    with pytest.raises(Problem):
        inspect(engine, worktree, "dev", "net", "result", "net_amount", new_name=name)
    assert projects.snapshot(worktree)["revision"] == before["revision"]


def chain(projects, nodes, edges):
    """Literal nodes keyed by name; an edge is (source, target, input)."""
    return projects.create(
        "Rename",
        {
            "flow": {
                "nodes": [{"id": name} for name in nodes],
                "edges": [
                    {
                        "id": f"{source}-{target}-{handle}",
                        "source": source,
                        "sourceHandle": "result",
                        "target": target,
                        "targetHandle": handle,
                    }
                    for source, target, handle in edges
                ],
            },
            "templates": {},
            "components": {},
            "node_sql": {f"nodes/{name}.sql": text for name, text in nodes.items()},
        },
    )["id"]


ORDERS = (
    "-- @output result\nSELECT * FROM (VALUES (1, 10, 'N'), (2, 3, 'S'), (3, 8, 'S')) t(id, amount, region);"
)
FEES = "-- @output result\nSELECT * FROM (VALUES (1, 2), (2, 5), (3, 7)) t(id, rate);"
ONE_INPUT = "-- @input source\n-- @output result\n"


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        (
            "SELECT amount * 2 AS total, total + 1 AS more FROM {{ source }};",
            "SELECT amount * 2 AS gross, gross + 1 AS more FROM {{ source }};",
        ),
        (
            "SELECT amount * 2 AS total FROM {{ source }} WHERE total > 5;",
            "SELECT amount * 2 AS gross FROM {{ source }} WHERE gross > 5;",
        ),
        (
            "SELECT region, sum(amount) AS total FROM {{ source }} GROUP BY region HAVING total > 5 ORDER BY total;",
            "SELECT region, sum(amount) AS gross FROM {{ source }} GROUP BY region HAVING gross > 5 ORDER BY gross;",
        ),
        (
            "WITH c AS (SELECT id, amount * 2 AS total FROM {{ source }}) SELECT id, total FROM c;",
            'WITH c AS (SELECT id, amount * 2 AS total FROM {{ source }}) SELECT id, total AS "gross" FROM c;',
        ),
        (
            "SELECT id, total FROM (SELECT id, amount * 2 AS total FROM {{ source }}) q;",
            'SELECT id, total AS "gross" FROM (SELECT id, amount * 2 AS total FROM {{ source }}) q;',
        ),
    ],
)
def test_renaming_an_output_follows_every_way_its_node_names_it(services, query, expected):
    store, projects, _, engine = services
    worktree = chain(
        projects,
        {
            "orders": ORDERS,
            "n": ONE_INPUT + query,
            "d": ONE_INPUT + "SELECT total + 1 AS next FROM {{ source }};",
        },
        [("orders", "n", "source"), ("n", "d", "source")],
    )
    plan, _ = inspect(engine, worktree, "dev", "n", "result", "total", new_name="gross")
    assert not plan["manual"], plan["manual"]
    rename(engine, worktree, "dev", "n", "result", "total", "gross", plan["revision"], plan["token"])
    files = projects.snapshot(worktree)["files"]
    assert files["nodes/n.sql"] == ONE_INPUT + expected
    assert files["nodes/d.sql"] == ONE_INPUT + "SELECT gross + 1 AS next FROM {{ source }};"
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"


@pytest.mark.parametrize(
    ("nodes", "edges", "target"),
    [
        # The filter would silently read the fee rate instead of the renamed amount.
        (
            {
                "orders": ORDERS,
                "fees": FEES,
                "j": "-- @input orders\n-- @input fees\n-- @output result\n"
                "SELECT o.id, region FROM {{ orders }} o JOIN {{ fees }} f ON o.id = f.id WHERE amount > 5;",
            },
            [("orders", "j", "orders"), ("fees", "j", "fees")],
            ("orders", "amount"),
        ),
        # A set operation takes its names from its first branch: only consumers would change.
        (
            {
                "orders": ORDERS,
                "fees": FEES,
                "u": "-- @input a\n-- @input b\n-- @output result\n"
                "SELECT amount AS rate FROM {{ a }} UNION ALL SELECT rate FROM {{ b }};",
                "d": ONE_INPUT + "SELECT rate + 1 AS next FROM {{ source }};",
            },
            [("orders", "u", "a"), ("fees", "u", "b"), ("u", "d", "source")],
            ("u", "rate"),
        ),
    ],
)
def test_a_rename_that_would_change_what_a_node_reads_is_refused(services, nodes, edges, target):
    store, projects, _, engine = services
    worktree = chain(projects, nodes, edges)
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    before = projects.snapshot(worktree)
    new_name = "rate" if target[1] == "amount" else "percent"
    with pytest.raises(Problem, match="cannot be applied automatically") as refusal:
        inspect(engine, worktree, "dev", target[0], "result", target[1], new_name=new_name)
    assert refusal.value.status == 409
    assert projects.snapshot(worktree)["revision"] == before["revision"]


def test_mixed_case_columns_follow_carry_and_collide_like_any_other(services):
    store, projects, _, engine = services
    worktree = chain(
        projects,
        {
            "orders": "-- @output result\nSELECT 1 AS id, 10 AS \"Amount\", 'N' AS Region;",
            "star": ONE_INPUT + "SELECT * FROM {{ source }};",
            "calc": ONE_INPUT + "SELECT id, Amount * 2 AS Net FROM {{ source }};",
            "total": ONE_INPUT + 'SELECT *, "Amount" * 2 AS total FROM {{ source }};',
        },
        [("orders", "star", "source"), ("orders", "calc", "source"), ("orders", "total", "source")],
    )
    for _ in range(2):
        # The written case of a name is kept before and after a run.
        impact, _ = inspect(engine, worktree, "dev", "orders", "result", "Amount")
        assert not impact["manual"], impact["manual"]
        assert ("star", "Amount") in {(e["node"], e["column"]) for e in impact["follows"]}
        assert ("calc", "Net") in {(e["node"], e["column"]) for e in impact["derived"]}
        assert not impact["unaffected"]
        with pytest.raises(Problem, match="already exists"):
            inspect(engine, worktree, "dev", "orders", "result", "Amount", new_name="total")
        assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    plan, _ = inspect(engine, worktree, "dev", "orders", "result", "Amount", new_name="Gross")
    rename(engine, worktree, "dev", "orders", "result", "Amount", "Gross", plan["revision"], plan["token"])
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    assert 'SELECT *, "Gross" * 2 AS total' in projects.snapshot(worktree)["files"]["nodes/total.sql"]


def test_impact_follows_a_rename_before_the_next_run(services):
    store, projects, catalog, engine = services
    worktree = create_example(projects, catalog)["id"]
    assert join_run(store, engine.launch(worktree, "dev")["id"])["status"] == "success"
    plan, _ = inspect(engine, worktree, "dev", "net", "result", "net_amount", new_name="net_value")
    rename(
        engine, worktree, "dev", "net", "result", "net_amount", "net_value", plan["revision"], plan["token"]
    )
    # The retained results still hold the old name: the saved code is the reference.
    impact, _ = inspect(engine, worktree, "dev", "net", "result", "net_value")
    assert not impact["manual"], impact["manual"]
    assert {e["column"] for e in impact["derived"]} >= {"net_revenue", "net_share"}
    origin = engine.column_lineage.describe(worktree, "dev", "report", "report", "net_share")
    assert origin["complete"], origin
    assert "net/result/net_value" in {step["id"] for step in origin["steps"]}
