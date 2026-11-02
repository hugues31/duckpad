"""Partition declarations preserve native SQL and expanded component boundaries."""

import copy

import duckdb
import pytest

from duckpad import partitions, variables
from duckpad.bundle import bundle_to_files, files_to_bundle, validate
from duckpad.components import expand, expand_for, group
from duckpad.merge import merge_files
from duckpad.templates import compile_template
from duckpad.util import Problem


def bundle():
    return {
        "flow": {
            "partitions": {
                "batch": {
                    "type": "text",
                    "values": {"node": "keys", "column": "batch"},
                    "attributes": ["task"],
                }
            },
            "nodes": [
                {"id": "keys", "template": "keys"},
                {
                    "id": "source",
                    "template": "source",
                    "outputs": {"result": {"partition": {"by": "batch", "column": "batch"}}},
                },
                {"id": "lookup", "template": "lookup"},
                {"id": "transform", "template": "transform", "params": {"value": "{{ partition.task }}"}},
                {"id": "collect", "template": "collect", "partitions": "all"},
            ],
            "edges": [
                {
                    "id": "a",
                    "source": "source",
                    "sourceHandle": "result",
                    "target": "transform",
                    "targetHandle": "data",
                },
                {
                    "id": "b",
                    "source": "lookup",
                    "sourceHandle": "result",
                    "target": "transform",
                    "targetHandle": "lookup",
                },
                {
                    "id": "c",
                    "source": "transform",
                    "sourceHandle": "result",
                    "target": "collect",
                    "targetHandle": "data",
                },
            ],
        },
        "templates": {
            "keys": "-- @kind source\n-- @output result\nSELECT 'a' AS batch, 'one' AS task UNION ALL SELECT 'b', 'two';",
            "source": "-- @kind source\n-- @output result\nSELECT * FROM (VALUES ('a', 1), ('a', 1), ('b', 2)) t(batch, amount);",
            "lookup": "-- @kind source\n-- @output result\nSELECT 10 AS rate;",
            "transform": "-- @input data\n-- @input lookup\n-- @param value: expression\n-- @output result\nSELECT d.amount * l.rate AS amount, {{ value }} AS task FROM {{ data }} d CROSS JOIN {{ lookup }} l;",
            "collect": "-- @input data\n-- @output result\nSELECT * FROM {{ data }};",
        },
        "components": {},
        "documentation": {},
    }


def entry(key="a", task="one"):
    return {"key": {"type": "text", "value": key}, "attributes": {"task": {"type": "text", "value": task}}}


def planned(project):
    nodes, edges, boundaries = expand(project)
    return nodes, partitions.plan(project, nodes, edges, boundaries)


def test_same_key_propagation_stops_at_collector_and_leaves_lookup_shared():
    nodes, plan = planned(bundle())
    assert not plan["errors"]
    assert plan["value_phase"] == {"keys"}
    assert {k for k, n in nodes.items() if n["partitioned"]} == {"source", "transform"}
    assert nodes["collect"]["partition_collect_inputs"] == ["data"]
    assert nodes["transform"]["partition_filters"] == {}


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("execution", {"parallelism": True}),
        ("execution", {"parallelism": 0}),
        ("execution", {"on_error": "ignore"}),
        ("preview", {"keep": "all", "count": 2}),
        ("preview", {"max_bytes": 0}),
        ("preview", {"unknown": 1}),
        ("type", "list<text>"),
        ("attributes", ["task", "task"]),
        ("attributes", ["batch"]),
    ],
)
def test_invalid_definitions_block_partition_consumers_only(field, value):
    project = bundle()
    project["flow"]["partitions"]["batch"][field] = value
    nodes, plan = planned(project)
    assert plan["errors"]
    assert nodes["source"]["partition_error"] == "partition_definition"
    assert "error" not in nodes["lookup"]


def test_invalid_reference_scope_and_type_are_explicit():
    project = bundle()
    project["flow"]["nodes"][3]["params"]["value"] = "{{ partition.unknown }}"
    assert any(e["code"] == "partition_reference" for e in validate(project))
    project["flow"]["nodes"][3]["params"]["value"] = {"$partition": True, "$var": "other"}
    assert any(e["code"] == "partition_reference" for e in validate(project))


def test_group_preserves_source_boundary_value_source_and_exposed_reference():
    project, instance = group(bundle(), ["keys", "source", "lookup", "transform"], "Batch processing")
    nodes, plan = planned(project)
    assert not plan["errors"]
    assert plan["source"]["node"] == instance + "::keys"
    assert nodes[instance + "::source"]["partitioned"]
    assert not nodes[instance + "::lookup"]["partitioned"]
    assert nodes[instance + "::transform"]["partitioned"]
    assert project["flow"]["nodes"][-1]["params"] == {"value": "{{ partition.task }}"}
    assert not validate(project)
    assert files_to_bundle(bundle_to_files(project))["flow"] == project["flow"]


def test_group_cannot_hide_collector():
    with pytest.raises(Problem, match="all-partitions boundary"):
        group(bundle(), ["transform", "collect"], "Hidden boundary")


def test_component_collector_leaves_internal_independent_inputs_shared():
    project, instance = group(bundle(), ["transform", "lookup"], "Processing")
    root = project["flow"]["nodes"][-1]
    root["partitions"] = "all"
    root["params"] = {"value": "'shared'"}
    project["flow"]["nodes"][2].pop("partitions")
    nodes, plan = planned(project)
    assert not plan["errors"]
    assert not nodes[instance + "::transform"]["partitioned"]
    assert nodes[instance + "::transform"]["partition_collect_inputs"] == ["data"]
    assert not nodes[instance + "::lookup"]["partitioned"]


def test_filter_keeps_duplicate_rows_and_binds_injection_as_data(tmp_path):
    project = bundle()
    nodes, _, _ = expand_for(project, "dev", partition=entry())
    node = nodes["source"]
    statements = compile_template(
        node["parsed"], {}, {}, {"result": "output"}, {}, {"file": tmp_path, "destination": tmp_path}
    )
    with duckdb.connect() as db:
        partitions.filter_statements(statements, node, entry(), db)
        assert db.execute(statements[0]["sql"], statements[0]["bindings"]).fetchall() == [("a", 1), ("a", 1)]
    malicious = "a' OR TRUE --"
    statements = compile_template(
        node["parsed"], {}, {}, {"result": "output"}, {}, {"file": tmp_path, "destination": tmp_path}
    )
    partitions.filter_statements(statements, node, entry(malicious))
    assert malicious not in statements[0]["sql"]
    with duckdb.connect() as db:
        assert db.execute(statements[0]["sql"], statements[0]["bindings"]).fetchall() == []


def test_expression_reference_uses_typed_binding_without_value_substitution():
    nodes, _, _ = expand_for(bundle(), "dev", partition=entry(task="x' OR TRUE --"))
    node = nodes["transform"]
    assert node["params"]["value"] == "{{ var.dp_partition_task }}"
    assert variables.expression_values(node) == {
        "dp_partition_task": {"type": "text", "value": "x' OR TRUE --"}
    }


def test_merge_keeps_value_source_atomic_and_conflicts_on_collector_mode():
    project = bundle()
    left, right = copy.deepcopy(project), copy.deepcopy(project)
    left["flow"]["partitions"]["batch"]["values"]["column"] = "other"
    right["flow"]["partitions"]["batch"]["values"]["node"] = "other"
    _, conflicts = merge_files(*[bundle_to_files(p) for p in (project, left, right)])
    assert conflicts == ["flow.json/partitions/batch/values"]
    left, right = copy.deepcopy(project), copy.deepcopy(project)
    left["flow"]["nodes"][1]["outputs"]["result"]["partition"]["column"] = "other"
    right["flow"]["nodes"][1].pop("outputs")
    right["flow"]["nodes"][1]["partitions"] = "all"
    _, conflicts = merge_files(*[bundle_to_files(p) for p in (project, left, right)])
    assert conflicts == ["flow.json/nodes/source"]


def test_numeric_keys_must_survive_the_browser_round_trip():
    with pytest.raises(Problem, match="browser"):
        partitions.canonical("number", "BIGINT", 2**53 + 1)
    assert partitions.identity({"type": "number", "value": 1}) == partitions.identity(
        {"type": "number", "value": 1.0}
    )
    assert partitions.identity({"type": "text", "value": "1"}) != partitions.identity(
        {"type": "number", "value": 1}
    )


def test_parquet_predicate_is_inside_the_native_scan(tmp_path):
    path = tmp_path / "orders.parquet"
    with duckdb.connect() as db:
        db.execute(
            "COPY (SELECT CASE WHEN i % 2 = 0 THEN 'a' ELSE 'b' END batch, i FROM range(10000) t(i)) TO ? (FORMAT PARQUET)",
            [str(path)],
        )
        statement = {
            "output": "result",
            "query": "SELECT * FROM read_parquet($file)",
            "bindings": {"file": str(path)},
        }
        node = {"partition_filters": {"result": {"by": "batch", "column": "batch"}}}
        partitions.filter_statements([statement], node, entry(), db)
        explained = db.execute("EXPLAIN " + statement["query"], statement["bindings"]).fetchone()[1]
        assert "READ_PARQUET" in explained
        assert "Filters:" in explained and "batch='a'" in explained.replace(" ", "")
        assert len(db.execute(statement["query"], statement["bindings"]).fetchall()) == 5000


def test_late_boundary_filters_after_limit_without_changing_its_meaning():
    statement = {
        "output": "result",
        "query": "SELECT * FROM (VALUES ('a'), ('b')) t(batch) ORDER BY batch LIMIT 1",
        "bindings": {},
    }
    node = {"partition_filters": {"result": {"by": "batch", "column": "batch"}}}
    with duckdb.connect() as db:
        partitions.filter_statements([statement], node, entry("b"), db)
        assert db.execute(statement["query"], statement["bindings"]).fetchall() == []


def test_compile_shows_the_bound_source_filter_without_reading_sources(services):
    _, projects, _, engine = services
    worktree = projects.create("Partition compiler", bundle())["id"]
    with pytest.raises(Problem, match="Partition values not calculated"):
        engine.compile(worktree, "dev", "source")
    statements = engine.compile(worktree, "dev", "source", partition=entry())
    assert statements[0]["bindings"] == {"dp_partition_key": "a"}
    assert 'WHERE "batch" = CAST($dp_partition_key AS VARCHAR)' in statements[0]["sql"]
    assert engine.pool.find(worktree, "dev") is None


def test_group_one_collector_preserves_its_component_input_barrier():
    project, instance = group(bundle(), ["collect"], "All batches")
    nodes, plan = planned(project)
    assert not plan["errors"]
    assert nodes[instance + "::collect"]["partition_collect_inputs"] == ["data"]
    assert not nodes[instance + "::collect"]["partitioned"]


def test_one_filtered_port_partitions_the_other_outputs_without_filtering_them():
    project = bundle()
    project["templates"]["source"] += "\n-- @output summary\nSELECT 10 AS total;"
    nodes, plan = planned(project)
    assert not plan["errors"]
    assert nodes["source"]["partitioned"]
    assert set(nodes["source"]["partition_filters"]) == {"result"}


def test_fingerprints_include_the_key_filter_and_only_used_attributes(services):
    _, _, _, engine = services
    project = bundle()
    a = engine.fingerprints.of(project, "dev", partition=entry())
    changed_attribute = engine.fingerprints.of(project, "dev", partition=entry(task="changed"))
    b = engine.fingerprints.of(project, "dev", partition=entry("b"))
    assert a["keys"] == b["keys"] and a["lookup"] == b["lookup"]
    assert a["source"] != b["source"]
    assert a["source"] == changed_attribute["source"]
    assert a["transform"] != changed_attribute["transform"]


def test_partition_value_source_cannot_depend_on_a_partition():
    project = bundle()
    project["flow"]["partitions"]["batch"]["values"] = {"node": "source", "column": "batch"}
    nodes, plan = planned(project)
    assert any(e["code"] == "value_dependency_cycle" for e in plan["errors"])
    assert nodes["source"]["error"]
    assert "error" not in nodes["lookup"]
