"""Project variables referenced inside expression parameters as `{{ var.name }}`."""

import copy
import json

import pytest
from fastapi.testclient import TestClient
from helpers import wait_run

from duckpad import variables
from duckpad.app import create_app
from duckpad.bundle import bundle_to_files, files_to_bundle, validate
from duckpad.comparison import compare_files
from duckpad.components import expand_for, group
from duckpad.lineage import Lineage
from duckpad.templates import compile_template, parse_template
from duckpad.util import Problem

ORDERS = (
    "SELECT * FROM (VALUES (1, 'paid', 100, DATE '2026-01-05', true), (2, 'paid', 500, DATE '2026-03-01', false), "
    "(3, 'refunded', 1000, DATE '2026-11-01', true)) AS orders(id, status, amount, day, online);"
)
TEMPLATES = {
    "orders": "-- @kind source\n-- @output result\n" + ORDERS,
    "filter": '-- @input source\n-- @param condition: expression(source) = "amount > 0"\n-- @output result\n'
    "SELECT * FROM {{ source }} WHERE {{ condition }};",
    "aggregate": '-- @input source\n-- @param groups: expressions = "status"\n'
    '-- @param measures: expressions = "SUM(amount) AS revenue"\n-- @output result\n'
    "SELECT {{ groups }}, {{ measures }} FROM {{ source }} GROUP BY {{ groups }};",
    "label": '-- @input source\n-- @param title: text = "Orders"\n-- @output result\n'
    "SELECT *, {{ title }} AS title FROM {{ source }};",
    "total": "-- @input source\n-- @output result\n"
    "SELECT COUNT(*) AS orders, SUM(amount) AS revenue FROM {{ source }};",
}
VARIABLES = {
    "threshold": {
        "type": "number",
        "description": "Minimum order amount kept by the report.",
        "default": 300,
        "environments": {"prod": 900},
    },
    "report_start": {"type": "date", "default": "2026-02-01", "environments": {"prod": "2026-01-01"}},
    "order_status": {"type": "choice(paid|refunded|pending)", "default": "paid"},
    "online_only": {"type": "boolean", "default": False, "environments": {"prod": True}},
    "rate": {"type": "number", "default": 2},
    "segment": {"type": "text", "default": "paid"},
    "sort_column": {"type": "identifier", "default": "amount"},
    "ids": {"type": "list<number>", "default": [1, 2]},
}
NODES = ("orders", "large", "total", "recent", "paid", "weighted")


def edge(source, target, port="source"):
    return {
        "id": f"{source}-{target}",
        "source": source,
        "sourceHandle": "result",
        "target": target,
        "targetHandle": port,
    }


def project_bundle():
    return {
        "flow": {
            "name": "Expressions",
            "nodes": [
                {"id": "orders", "template": "orders", "label": "Orders", "params": {}},
                {
                    "id": "large",
                    "template": "filter",
                    "label": "Large orders",
                    "params": {"condition": "amount >= {{ var.threshold }}"},
                },
                {"id": "total", "template": "total", "label": "Total", "params": {}},
                {
                    "id": "recent",
                    "template": "filter",
                    "label": "Recent",
                    "params": {
                        "condition": "day >= {{var.report_start}} AND (online OR NOT {{ var.online_only }})"
                    },
                },
                {
                    "id": "paid",
                    "template": "filter",
                    "label": "Paid",
                    "params": {"condition": "status = {{ var.order_status }}"},
                },
                {
                    "id": "weighted",
                    "template": "aggregate",
                    "label": "Weighted",
                    "params": {"measures": "SUM(amount) * {{ var.rate }} AS weighted"},
                },
            ],
            "edges": [
                edge("orders", "large"),
                edge("large", "total"),
                edge("orders", "recent"),
                edge("orders", "paid"),
                edge("orders", "weighted"),
            ],
        },
        "templates": dict(TEMPLATES),
        "components": {},
        "documentation": {},
        "variables": copy.deepcopy(VARIABLES),
    }


def node(bundle, key):
    return next(n for n in bundle["flow"]["nodes"] if n["id"] == key)


def save(projects, worktree, change):
    snapshot = projects.snapshot(worktree)
    change(snapshot["bundle"])
    return projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))


def ids(engine, worktree, environment, key):
    return sorted(row["values"][0] for row in engine.preview(worktree, environment, key)["rows"])


def statuses(engine, worktree, environment, keys=NODES):
    return {key: engine.preview(worktree, environment, key)["status"] for key in keys}


def compile_filter(condition, variables, template=TEMPLATES["filter"]):
    [statement] = compile_template(
        parse_template(template),
        {"condition": condition},
        {"source": '"input"'},
        {},
        {},
        ".",
        None,
        variables,
    )
    return statement


# Compilation


def test_references_compile_to_named_parameters_bound_with_their_type():
    statement = compile_filter(
        "amount >= {{ var.threshold }} AND day >= {{var.report_start}} AND status = {{ var.order_status }} "
        "AND online = {{ var.online_only }} AND status <> {{ var.segment }} AND amount > {{ var.threshold }} / 2",
        {
            "threshold": {"type": "number", "value": 900},
            "report_start": {"type": "date", "value": "2026-01-01"},
            "order_status": {"type": "choice(paid|refunded)", "value": "paid"},
            "online_only": {"type": "boolean", "value": True},
            "segment": {"type": "text", "value": "refunded"},
        },
    )
    assert statement["query"] == (
        'SELECT * FROM "input" WHERE amount >= $var_threshold AND day >= CAST($var_report_start AS DATE) '
        "AND status = $var_order_status AND online = $var_online_only AND status <> $var_segment "
        "AND amount > $var_threshold / 2"
    )
    assert statement["bindings"] == {
        "var_threshold": 900,
        "var_report_start": "2026-01-01",
        "var_order_status": "paid",
        "var_online_only": True,
        "var_segment": "refunded",
    }
    assert statement["variable_bindings"] == {
        "var_online_only": "online_only",
        "var_order_status": "order_status",
        "var_report_start": "report_start",
        "var_segment": "segment",
        "var_threshold": "threshold",
    }
    [measures] = compile_template(
        parse_template(TEMPLATES["aggregate"]),
        {"measures": "SUM(amount) * {{ var.rate }} AS weighted, COUNT(*) AS orders"},
        {"source": '"input"'},
        {},
        {},
        ".",
        None,
        {"rate": {"type": "number", "value": 1.5}},
    )
    assert measures["query"] == (
        'SELECT status, SUM(amount) * $var_rate AS weighted, COUNT(*) AS orders FROM "input" GROUP BY status'
    )
    assert measures["bindings"] == {"var_rate": 1.5}


def test_placeholders_never_collide_with_template_parameters():
    template = (
        "-- @input source\n-- @param var_threshold: number = 1\n-- @param condition: expression\n"
        "-- @output result\nSELECT *, {{ var_threshold }} AS one FROM {{ source }} WHERE {{ condition }};"
    )
    statement = compile_filter(
        "amount >= {{ var.threshold }}", {"threshold": {"type": "number", "value": 900}}, template
    )
    assert (
        statement["query"] == 'SELECT *, $var_threshold AS one FROM "input" WHERE amount >= $var_threshold_2'
    )
    assert statement["bindings"] == {"var_threshold": 1, "var_threshold_2": 900}
    assert statement["variable_bindings"] == {"var_threshold_2": "threshold"}


def test_case_insensitive_placeholder_collisions_preserve_values_in_runs(services):
    store, projects, _, engine = services
    bundle = project_bundle()
    bundle["templates"]["values"] = (
        "-- @kind source\n-- @param VAR_THRESHOLD: number = 1\n"
        "-- @param Var_Threshold_2: number = 2\n-- @param projection: expressions\n-- @output result\n"
        "SELECT {{ VAR_THRESHOLD }} AS configured, {{ Var_Threshold_2 }} AS reserved, {{ projection }};"
    )
    bundle["variables"]["threshold_3"] = {"type": "number", "default": 3}
    bundle["flow"]["nodes"] = [
        {
            "id": "values",
            "template": "values",
            "params": {"projection": "{{ var.threshold }} AS value, {{ var.threshold_3 }} AS other"},
        }
    ]
    bundle["flow"]["edges"] = []
    worktree = projects.create("Case collisions", bundle)["id"]
    assert projects.snapshot(worktree)["diagnostics"] == []
    run = wait_run(store, engine.launch(worktree, "prod"))
    assert run["status"] == "success", run
    assert run["variables"]["threshold"]["value"] == 900
    assert [row["values"] for row in engine.preview(worktree, "prod", "values")["rows"]] == [[1, 2, 900, 3]]
    assert run["nodes"]["values"]["statements"][0]["bindings"] == {
        "VAR_THRESHOLD": 1,
        "Var_Threshold_2": 2,
        "var_threshold_3": 3,
        "var_threshold_4": 900,
    }


@pytest.mark.parametrize(
    "condition",
    [
        "status = '{{ var.segment }}'",
        'status = "{{ var.segment }}"',
        "status = 'x' /* {{ var.segment }} */",
        "{{ var.segment }} = '{{ var.segment }}'",
        "'{{ var.segment }}' = {{ var.segment }}",
        '{{ var.segment }} = "{{ var.segment }}"',
        "{{ var.segment }} = 'paid' /* {{ var.segment }} */",
        "{{ var.segment }} = 'paid' -- {{ var.segment }}",
        "/* outer /* {{ var.segment }} */ comment */ {{ var.segment }} = 'paid'",
        "{{ var.segment }} = $$ {{ var.segment }} $$",
        "{{ var.segment }} = $label${{ var.segment }}$label$",
        "{{ var.segment }} = 'it''s {{ var.segment }}'",
        "{{ var.segment }} = '{{ var.segment }}' OR $var_segment = 'paid'",
    ],
)
def test_references_inside_quotes_or_comments_are_rejected(condition):
    with pytest.raises(Problem, match=r"condition: write \{\{ var\.segment \}\} as a value, outside quotes"):
        compile_filter(condition, {"segment": {"type": "text", "value": "paid"}})


@pytest.mark.parametrize(
    "projection",
    [
        "{{ var.segment }} AS first, '{{ var.segment }}' AS second",
        ["{{ var.segment }} AS first", "'{{ var.segment }}' AS second"],
    ],
)
def test_each_reference_in_an_expression_list_is_checked(projection):
    template = parse_template(
        "-- @kind source\n-- @param projection: expressions\n-- @output result\nSELECT {{ projection }};"
    )
    with pytest.raises(Problem, match=r"projection: write .* outside quotes and comments"):
        compile_template(
            template,
            {"projection": projection},
            {},
            {},
            {},
            ".",
            variables={"segment": {"type": "text", "value": "paid"}},
        )


def test_a_reference_without_a_bound_value_never_compiles():
    with pytest.raises(Problem, match="condition references variable threshold, which has no value here"):
        compile_filter("amount >= {{ var.threshold }}", {})


def test_text_values_are_bound_and_never_inserted_into_sql(services):
    store, projects, _, engine = services
    bundle = project_bundle()
    injection = "paid' OR 1 = 1; DROP TABLE orders; --"
    bundle["variables"]["segment"]["default"] = injection
    node(bundle, "paid")["params"]["condition"] = "status = {{ var.segment }}"
    worktree = projects.create("Expressions", bundle)["id"]
    assert projects.snapshot(worktree)["diagnostics"] == []
    run = wait_run(store, engine.launch(worktree, "dev", "paid"))
    assert run["status"] == "success", run
    assert ids(engine, worktree, "dev", "paid") == []
    [statement] = run["nodes"]["paid"]["statements"]
    assert statement["sql"].endswith("WHERE status = $var_segment")
    assert injection not in statement["sql"] and injection not in "".join(statement["materialization_sql"])
    assert statement["bindings"] == {"var_segment": injection}
    assert ids(engine, worktree, "dev", "orders") == [1, 2, 3]


# Diagnostics


def test_identifier_list_undeclared_and_misplaced_references_are_errors_on_the_node(services):
    store, projects, _, engine = services
    bundle = project_bundle()
    node(bundle, "large")["params"]["condition"] = "{{ var.sort_column }} > 0 AND id IN {{ var.ids }}"
    node(bundle, "paid")["params"]["condition"] = "status = {{ var.missing }}"
    bundle["flow"]["nodes"].append(
        {"id": "titled", "template": "label", "params": {"title": "Orders since {{ var.report_start }}"}}
    )
    bundle["flow"]["edges"].append(edge("orders", "titled"))
    worktree = projects.create("Expressions", bundle)["id"]
    identifier = (
        "Variable sort_column (identifier) cannot be used inside expression condition. Bind it to a column "
        "or identifier parameter instead."
    )
    listed = (
        "Variable ids (list<number>) cannot be used inside expression condition. Bind it to a parameter of "
        "the same list type instead."
    )
    misplaced = (
        "Parameter title (text) cannot reference variable report_start inside its text: only expression and path "
        "parameters can. Bind the whole parameter to the variable instead."
    )
    assert projects.snapshot(worktree)["diagnostics"] == [
        {"file": "flow.json", "node": "large", "message": identifier},
        {"file": "flow.json", "node": "large", "message": listed},
        {
            "file": "flow.json",
            "node": "paid",
            "message": "Parameter condition references undeclared variable missing",
        },
        {"file": "flow.json", "node": "titled", "message": misplaced},
    ]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["nodes"]["large"]["status"] == "blocked"
    assert run["nodes"]["large"]["error"] == f"{identifier}; {listed}"
    assert run["nodes"]["total"]["error"] == "Blocked by large"
    assert run["nodes"]["paid"]["error"] == "Parameter condition references undeclared variable missing"
    assert run["nodes"]["titled"]["error"] == misplaced
    assert {run["nodes"][key]["status"] for key in ("orders", "recent", "weighted")} == {"success"}
    assert run["variables"]["missing"] == {"type": None, "error": "undeclared variable"}


def test_a_variable_without_value_blocks_its_expressions_in_that_environment_only(services):
    store, projects, _, engine = services
    bundle = project_bundle()
    bundle["variables"]["threshold"] = {"type": "number", "environments": {"prod": 900}}
    worktree = projects.create("Expressions", bundle)["id"]
    assert projects.snapshot(worktree)["diagnostics"] == []
    dev = wait_run(store, engine.launch(worktree, "dev"))
    assert dev["nodes"]["large"]["error"] == "Variable threshold: no value in dev"
    assert dev["nodes"]["total"]["error"] == "Blocked by large"
    assert dev["nodes"]["recent"]["status"] == "success"
    assert wait_run(store, engine.launch(worktree, "prod"))["status"] == "success"
    assert ids(engine, worktree, "prod", "large") == [3]


def test_a_malformed_variables_file_blocks_expressions_that_reference_variables(services):
    store, projects, _, engine = services
    worktree = projects.create("Expressions", project_bundle())["id"]
    snapshot = projects.snapshot(worktree)
    saved = projects.write(worktree, snapshot["revision"], {**snapshot["files"], "variables.json": "{"})
    assert [d["file"] for d in saved["diagnostics"]] == ["variables.json"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["nodes"]["orders"]["status"] == "success"
    assert run["nodes"]["large"]["status"] == "blocked"
    assert "variables.json is not valid JSON" in run["nodes"]["large"]["error"]


def test_templates_and_component_definitions_cannot_reference_variables_in_expressions():
    bundle = project_bundle()
    bundle["components"]["large_orders"] = {
        "nodes": [
            {"id": "filter", "template": "filter", "params": {"condition": "amount > {{ var.threshold }}"}}
        ],
        "edges": [],
        "inputs": {"orders": {"node": "filter", "port": "source"}},
        "outputs": {"result": {"node": "filter", "port": "result"}},
        "parameters": {},
    }
    bundle["components"]["recent_orders"] = {
        "nodes": [{"id": "filter", "template": "filter", "params": {}}],
        "edges": [],
        "inputs": {"orders": {"node": "filter", "port": "source"}},
        "outputs": {"result": {"node": "filter", "port": "result"}},
        "parameters": {
            "since": {
                "type": "expression",
                "default": "day >= {{ var.report_start }}",
                "targets": [{"node": "filter", "param": "condition"}],
            }
        },
    }
    bundle["templates"]["preset"] = (
        '-- @input source\n-- @param condition: expression = "amount > {{ var.threshold }}"\n'
        "-- @output result\nSELECT * FROM {{ source }} WHERE {{ condition }};"
    )
    bundle["flow"]["nodes"] += [
        {"id": "summary", "component": "large_orders", "params": {}},
        {"id": "since", "component": "recent_orders", "params": {}},
        {"id": "preset", "template": "preset", "params": {}},
    ]
    bundle["flow"]["edges"] += [
        edge("orders", "summary", "orders"),
        edge("orders", "since", "orders"),
        edge("orders", "preset"),
    ]
    assert {d["file"]: d["message"] for d in validate(bundle)} == {
        "templates/preset.sql": "Templates cannot reference project variables ({{ var.threshold }}). "
        "Declare a parameter, then bind it to the variable on the node in the flow.",
        "components/large_orders.json": "Component definitions cannot reference project variables "
        "(filter.condition). Expose the parameter, then bind it to the variable on the component instance.",
        "components/recent_orders.json": "Component definitions cannot reference project variables "
        "(default of since). Expose the parameter, then bind it to the variable on the component instance.",
    }
    nodes, _, _ = expand_for(bundle, "dev")
    assert nodes["summary::filter"]["error"].startswith("Component large_orders references project variables")
    assert nodes["since::filter"]["error"].startswith("Component recent_orders references project variables")
    assert nodes["preset"]["error"].startswith("Template preset references project variables")


# Execution, fingerprints and history


def test_runs_bind_each_environment_and_record_the_variables_of_expressions(services):
    store, projects, _, engine = services
    worktree = projects.create("Expressions", project_bundle())["id"]
    assert projects.snapshot(worktree)["diagnostics"] == []
    dev = wait_run(store, engine.launch(worktree, "dev"))
    prod = wait_run(store, engine.launch(worktree, "prod"))
    assert dev["status"] == prod["status"] == "success", (dev, prod)
    assert ids(engine, worktree, "dev", "large") == [2, 3]
    assert ids(engine, worktree, "prod", "large") == [3]
    assert ids(engine, worktree, "dev", "recent") == [2, 3]
    assert ids(engine, worktree, "prod", "recent") == [1, 3]
    assert ids(engine, worktree, "dev", "paid") == [1, 2]
    weighted = engine.preview(worktree, "dev", "weighted")["rows"]
    assert sorted(row["values"] for row in weighted) == [["paid", 1200], ["refunded", 2000]]
    assert prod["variables"] == {
        "online_only": {"type": "boolean", "value": True, "source": "environment"},
        "order_status": {"type": "choice(paid|refunded|pending)", "value": "paid", "source": "default"},
        "rate": {"type": "number", "value": 2, "source": "default"},
        "report_start": {"type": "date", "value": "2026-01-01", "source": "environment"},
        "threshold": {"type": "number", "value": 900, "source": "environment"},
    }
    recent = prod["nodes"]["recent"]
    assert recent["references"] == {"condition": ["report_start", "online_only"]}
    assert "variables" not in recent
    [statement] = recent["statements"]
    assert statement["bindings"] == {"var_report_start": "2026-01-01", "var_online_only": True}
    assert statement["variables"] == [
        {
            "parameter": "condition",
            "name": "report_start",
            "type": "date",
            "value": "2026-01-01",
            "source": "environment",
            "binding": "var_report_start",
        },
        {
            "parameter": "condition",
            "name": "online_only",
            "type": "boolean",
            "value": True,
            "source": "environment",
            "binding": "var_online_only",
        },
    ]
    # A launch scope records only the variables its nodes use.
    scoped = wait_run(store, engine.launch(worktree, "prod", "total"))
    assert scoped["variables"] == {"threshold": {"type": "number", "value": 900, "source": "environment"}}
    assert engine.compile(worktree, "dev", "large")[0]["bindings"] == {"var_threshold": 300}


def test_changing_a_value_invalidates_only_expressions_using_it_in_that_environment(services):
    store, projects, _, engine = services
    worktree = projects.create("Expressions", project_bundle())["id"]
    for environment in ("dev", "prod"):
        assert wait_run(store, engine.launch(worktree, environment))["status"] == "success"
    save(projects, worktree, lambda bundle: bundle["variables"]["threshold"]["environments"].update(prod=950))
    assert statuses(engine, worktree, "prod") == {
        "orders": "valid",
        "large": "stale",
        "total": "stale",
        "recent": "valid",
        "paid": "valid",
        "weighted": "valid",
    }
    assert set(statuses(engine, worktree, "dev").values()) == {"valid"}
    save(projects, worktree, lambda bundle: bundle["variables"]["report_start"].update(default="2026-03-01"))
    assert statuses(engine, worktree, "dev")["recent"] == "stale"
    assert statuses(engine, worktree, "prod")["recent"] == "valid"


def test_renames_and_descriptions_keep_expression_results_valid(services):
    store, projects, _, engine = services
    worktree = projects.create("Expressions", project_bundle())["id"]
    for environment in ("dev", "prod"):
        assert wait_run(store, engine.launch(worktree, environment))["status"] == "success"
    save(
        projects, worktree, lambda bundle: bundle["variables"]["threshold"].update(description="New wording")
    )
    snapshot = projects.snapshot(worktree)
    renamed = variables.rename(snapshot["bundle"], "threshold", "minimum_amount")
    renamed = variables.rename(renamed, "report_start", "first_day")
    projects.write(worktree, snapshot["revision"], bundle_to_files(renamed))
    current = projects.snapshot(worktree)
    assert current["diagnostics"] == []
    assert node(current["bundle"], "large")["params"]["condition"] == "amount >= {{ var.minimum_amount }}"
    assert node(current["bundle"], "recent")["params"]["condition"] == (
        "day >= {{ var.first_day }} AND (online OR NOT {{ var.online_only }})"
    )
    for environment in ("dev", "prod"):
        assert set(statuses(engine, worktree, environment).values()) == {"valid"}
    # The renamed parameter is what a new run binds.
    assert engine.compile(worktree, "prod", "large")[0]["bindings"] == {"var_minimum_amount": 900}


def test_usages_list_expression_references_and_comparisons_follow_their_values():
    bundle = project_bundle()
    node(bundle, "paid")["params"]["condition"] = (
        "amount >= {{ var.threshold }} AND status = {{ var.order_status }}"
    )
    found = variables.usages(bundle)
    assert found["threshold"] == [
        {"node": "large", "label": "Large orders", "param": "condition", "expression": True},
        {"node": "paid", "label": "Paid", "param": "condition", "expression": True},
    ]
    assert found["online_only"] == [
        {"node": "recent", "label": "Recent", "param": "condition", "expression": True}
    ]
    assert "segment" not in found
    before = bundle_to_files(bundle)
    production = files_to_bundle(before)
    production["variables"]["threshold"]["environments"]["prod"] = 950
    report = compare_files(before, bundle_to_files(production))
    assert report["impact"]["direct"] == ["large", "paid"]
    assert report["impact"]["downstream"] == ["total"]
    renamed = bundle_to_files(variables.rename(files_to_bundle(before), "threshold", "minimum_amount"))
    assert compare_files(before, renamed)["impact"]["direct"] == []


def test_grouping_exposes_expressions_that_reference_variables():
    bundle = project_bundle()
    grouped, instance = group(bundle, ["large", "total"], "Large orders")
    definition = grouped["components"][node(grouped, instance)["component"]]
    assert variables.component_references(definition) == []
    assert definition["parameters"] == {
        "condition": {"type": "expression(source)", "targets": [{"node": "large", "param": "condition"}]}
    }
    assert node(grouped, instance)["params"] == {"condition": "amount >= {{ var.threshold }}"}
    assert validate(grouped) == []
    nodes, _, _ = expand_for(grouped, "prod")
    [binding] = nodes[f"{instance}::large"]["references"]["condition"]
    assert binding == {"name": "threshold", "type": "number", "value": 900, "source": "environment"}


# Lineage


def test_lineage_explanations_label_values_with_their_variables(services):
    store, projects, _, engine = services
    worktree = projects.create("Expressions", project_bundle())["id"]
    assert wait_run(store, engine.launch(worktree, "prod"))["status"] == "success"
    lineage = Lineage(engine)
    large = engine.preview(worktree, "prod", "large")
    result = lineage.explain(worktree, "prod", large["id"], 0, "amount")
    assert result["complete"], result
    assert result["calculation"]["selection"] == ["amount >= 900 (threshold)"]
    assert result["sql"].endswith("WHERE amount >= $var_threshold")
    recent = engine.preview(worktree, "prod", "recent")
    result = lineage.explain(worktree, "prod", recent["id"], 0, "id")
    assert result["complete"], result
    assert result["calculation"]["selection"] == [
        "day >= CAST('2026-01-01' AS DATE) (report_start) AND (online OR NOT TRUE (online_only))"
    ]
    weighted = engine.preview(worktree, "prod", "weighted")
    row = next(i for i, r in enumerate(weighted["rows"]) if r["values"][0] == "refunded")
    result = lineage.explain(worktree, "prod", weighted["id"], weighted["rows"][row]["id"], "weighted")
    assert result["complete"], result
    assert result["calculation"]["formula"] == "SUM(amount) * 2 (rate)"


# API


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        yield client


def test_api_renames_references_and_lists_usages_and_values(client):
    worktree = client.post("/api/projects", json={"name": "Expressions"}).json()["id"]
    path = f"/api/worktrees/{worktree}"
    snapshot = client.get(path).json()
    bundle = snapshot["bundle"]
    example = project_bundle()
    bundle["templates"].update(example["templates"])
    bundle["flow"].update(nodes=example["flow"]["nodes"], edges=example["flow"]["edges"])
    bundle["variables"] = example["variables"]
    response = client.put(path, json={"revision": snapshot["revision"], "bundle": bundle})
    assert response.status_code == 200, response.text
    summary = client.get(path).json()["variables"]
    assert summary["declarations"]["threshold"]["usages"] == [
        {"node": "large", "label": "Large orders", "param": "condition", "expression": True}
    ]
    revision = client.get(path).json()["revision"]
    response = client.post(
        path + "/variables/threshold/rename", json={"revision": revision, "name": "minimum"}
    )
    assert response.status_code == 200, response.text
    renamed = client.get(path).json()
    assert node(renamed["bundle"], "large")["params"]["condition"] == "amount >= {{ var.minimum }}"
    assert renamed["variables"]["declarations"]["minimum"]["usages"] == [
        {"node": "large", "label": "Large orders", "param": "condition", "expression": True}
    ]
    compiled = client.get(path + "/compile/large", params={"environment": "prod"}).json()
    assert compiled[0]["sql"].endswith("WHERE amount >= $var_minimum")
    assert compiled[0]["variables"] == [
        {
            "parameter": "condition",
            "name": "minimum",
            "type": "number",
            "value": 900,
            "source": "environment",
            "binding": "var_minimum",
        }
    ]
    scope = client.get(path + "/variables/scope", params={"environment": "prod", "node": "total"}).json()
    assert scope == {"minimum": {"type": "number", "value": 900, "source": "environment"}}
    assert json.loads(client.get(path).json()["files"]["flow.json"])["nodes"][1]["params"] == {
        "condition": "amount >= {{ var.minimum }}"
    }
