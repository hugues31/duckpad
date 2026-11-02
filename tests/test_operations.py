"""SQL operations, rather than node categories, determine access and execution."""

from pathlib import Path

import pytest
from helpers import join_run

from duckpad.bundle import bundle_to_files
from duckpad.lineage import Lineage
from duckpad.templates import compile_template, parse_template
from duckpad.util import Problem

FILES = {"file": Path("/resources"), "destination": Path("/exports")}


def compile_sql(sql, connections=None):
    template = parse_template(sql)
    return compile_template(
        template,
        {},
        {name: '"input_' + name + '"' for name in template["inputs"]},
        {name: "output_" + name for name in template["outputs"]},
        connections or {},
        FILES,
    )


@pytest.mark.parametrize("kind", ["source", "transform", "export"])
def test_removed_kind_directive_is_rejected(kind):
    with pytest.raises(Problem, match="Unknown template directive: @kind"):
        parse_template(f"-- @kind {kind}\n-- @output result\nSELECT 1;")


def test_queries_can_combine_declared_inputs_and_external_resources():
    statements = compile_sql("""-- @input rows
-- @param file: file = "orders.csv"
-- @output enriched
SELECT * FROM {{ rows }} JOIN read_csv({{ file }}) USING (id);
-- @output total
SELECT count(*) FROM {{ enriched }};
""")
    assert statements[0]["reads_external"]
    assert not statements[1]["reads_external"]
    assert not any(s["writes_external"] for s in statements)


def test_capabilities_are_checked_for_each_read_and_write_connection():
    sql = """-- @param reader: connection = "read_db"
-- @param writer: connection = "write_db"
INSERT INTO {{ writer }}.totals SELECT * FROM {{ reader }}.orders;
"""
    connections = {
        "read_db": {"alias": "read_alias", "definition": {"capabilities": ["read"]}},
        "write_db": {"alias": "write_alias", "definition": {"capabilities": ["write"]}},
    }
    assert compile_sql(sql, connections)[0]["writes_external"]
    connections["read_db"]["definition"]["capabilities"] = ["write"]
    with pytest.raises(Problem, match="Connection read_db does not support read"):
        compile_sql(sql, connections)
    connections["read_db"]["definition"]["capabilities"] = ["read"]
    connections["write_db"]["definition"]["capabilities"] = ["read"]
    with pytest.raises(Problem, match="Connection write_db does not support write"):
        compile_sql(sql, connections)


def test_file_capabilities_follow_actual_resource_usage():
    connections = {
        "files": {
            "alias": "files",
            "definition": {"family": "storage", "capabilities": ["write"]},
            "values": {"root": "/data"},
        }
    }
    declarations = (
        '-- @param connection: connection = "files"\n-- @param path: destination(connection) = "out.csv"\n'
    )
    compile_sql(declarations + "COPY (SELECT 1) TO {{ path }} (FORMAT CSV);", connections)
    with pytest.raises(Problem, match="Connection files does not support read"):
        compile_sql(declarations + "-- @output data\nSELECT * FROM read_csv({{ path }});", connections)


@pytest.mark.parametrize(
    "sql",
    [
        "-- @output result\nSELECT * FROM other_node_connection.orders;",
        "-- @input rows\n-- @output result\nSELECT * FROM other_node_connection.input_rows;",
        "-- @input rows\nINSERT INTO {{ rows }} SELECT 1;",
        "COPY (SELECT 1) TO '/undeclared.csv';",
        "-- @input rows\nCOPY {{ rows }} FROM '/undeclared.csv';",
        "-- @output result\nCOPY (SELECT 1) TO '/undeclared.csv';",
        "-- @test check\nDELETE FROM data;",
        "-- @message\nINSERT INTO data SELECT 1;",
        "SELECT 1;",
    ],
)
def test_operations_cannot_bypass_declarations_or_mutate_outputs(sql):
    with pytest.raises(Problem):
        compile_sql(
            sql,
            {"other": {"alias": "other_node_connection", "definition": {"capabilities": ["read", "write"]}}},
        )


def test_terminal_controls_are_not_external_writes():
    sql = "-- @test valid\nSELECT 1 WHERE false;\n-- @message\nSELECT 'info' AS level, 'OK' AS message;"
    template = parse_template(sql)
    assert "kind" not in template
    assert not template["writes_external"]
    assert template["outputs"] == []
    assert not any(s["writes_external"] for s in compile_sql(sql))


MIXED = """-- @param file: file
-- @param destination: destination = "totals.csv"
COPY {{ total }} TO {{ destination }} (FORMAT CSV, HEADER);
-- @output rows
SELECT * FROM read_csv({{ file }});
-- @output total
SELECT sum(amount) AS amount FROM {{ rows }};
-- @test positive
SELECT * FROM {{ total }} WHERE amount < 0;
-- @message
SELECT 'info' AS level, 'Calculated' AS message;
"""


def test_mixed_node_publishes_outputs_download_and_lineage_and_gates_writes(services, tmp_path):
    store, projects, _, engine = services
    file = tmp_path / "input.csv"
    file.write_text("amount\n2\n3\n")
    worktree = projects.create(
        "Mixed operations",
        {
            "flow": {
                "nodes": [{"id": "mixed", "template": "mixed", "params": {"file": str(file)}}],
                "edges": [],
            },
            "templates": {"mixed": MIXED},
            "components": {},
            "documentation": {},
        },
    )["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success", run
    state = run["nodes"]["mixed"]
    assert "kind" not in state
    assert state["writes_external"] and state["external_outcome"] == "completed"
    assert set(state["outputs"]) == {"rows", "total"}
    assert engine.exports.result(worktree, "dev", "mixed")["status"] == "available"
    preview = engine.preview(worktree, "dev", "mixed", "total")
    assert preview["rows"][0]["values"] == [5]
    lineage = Lineage(engine).explain(worktree, "dev", preview["id"], 0, "amount")
    assert lineage["complete"] and lineage["total"] == 2
    assert {c["port"] for c in lineage["contributions"]} == {"rows"}
    output = store.paths.exports(worktree, "dev") / "totals.csv"
    assert output.read_text() == "amount\n5\n"

    snapshot = projects.snapshot(worktree)
    snapshot["bundle"]["templates"]["mixed"] = MIXED.replace("amount < 0", "amount > 0")
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    failed = join_run(store, engine.launch(worktree, "dev")["id"])
    assert failed["status"] == "failed"
    assert not failed["nodes"]["mixed"].get("external_started")
    assert failed["nodes"]["mixed"]["external_outcome"] == "failed"
    assert output.read_text() == "amount\n5\n"
    assert engine.preview(worktree, "dev", "mixed", "total")["status"] == "stale"


@pytest.mark.parametrize("empty", [False, True])
def test_partitioned_node_can_publish_and_write_without_losing_collector_outputs(services, empty):
    from test_partitions import bundle

    store, projects, _, engine = services
    project = bundle()
    project["templates"]["transform"] = (
        "-- @param destination: destination\n"
        "COPY {{ result }} TO {{ destination }} (FORMAT CSV, HEADER);\n" + project["templates"]["transform"]
    )
    project["flow"]["nodes"][3]["params"]["destination"] = "{{ partition }}.csv"
    if empty:
        project["templates"]["keys"] = "-- @output result\nSELECT 'a' batch, 'one' task WHERE false;"
    worktree = projects.create("Mixed partition operations", project)["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success", run
    result = engine.preview(worktree, "dev", "collect")
    assert result["count"] == (0 if empty else 3)
    files = list(store.paths.exports(worktree, "dev").glob("*.csv"))
    assert {p.name for p in files} == (set() if empty else {"a.csv", "b.csv"})


def test_partition_retry_recomputes_outputs_without_repeating_a_successful_write(services, monkeypatch):
    from test_partitions import bundle

    store, projects, _, engine = services
    project = bundle()
    project["flow"]["partitions"]["batch"]["execution"] = {"on_error": "continue"}
    project["templates"]["transform"] = (
        "-- @param destination: destination\nCOPY {{ result }} TO {{ destination }} (FORMAT CSV, HEADER);\n"
        + project["templates"]["transform"]
    )
    project["flow"]["nodes"][3]["params"]["destination"] = "{{ partition }}.csv"
    project["templates"]["check"] = "-- @input data\n-- @test valid\nSELECT * FROM {{ data }} WHERE false;"
    project["flow"]["nodes"].append({"id": "check", "template": "check"})
    project["flow"]["edges"].append(
        {
            "id": "d",
            "source": "transform",
            "sourceHandle": "result",
            "target": "check",
            "targetHandle": "data",
        }
    )
    worktree = projects.create("Retry mixed operations", project)["id"]
    compute = engine.runs._compute

    def fail(execution, key, tables):
        if key == "check" and execution.partition["key"]["value"] == "a":
            raise Problem("Downstream check failed")
        return compute(execution, key, tables)

    with monkeypatch.context() as patch:
        patch.setattr(engine.runs, "_compute", fail)
        first = join_run(store, engine.launch(worktree, "dev")["id"])
    assert first["status"] == "partial_failure", first
    destination = store.paths.exports(worktree, "dev") / "a.csv"
    destination.write_text("Do not replace a completed write\n")
    retry = join_run(store, engine.launch(worktree, "dev", partition_selection={"mode": "failed"})["id"])
    assert retry["status"] == "success", retry
    assert destination.read_text() == "Do not replace a completed write\n"
    assert engine.preview(worktree, "dev", "collect")["count"] == 3
