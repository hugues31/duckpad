"""Project variables: declarations, binding, resolution, invalidation, history, files and API."""

import copy
import io
import json
import threading
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import wait_run

from duckpad import variables
from duckpad.app import create_app
from duckpad.bundle import bundle_to_files, files_to_bundle, validate
from duckpad.comparison import commit_message, compare_files
from duckpad.components import group
from duckpad.merge import merge_files
from duckpad.templates import compile_template, parse_template
from duckpad.util import Problem

ORDERS = (
    "SELECT * FROM (VALUES (1, 'paid', 100, DATE '2026-01-05'), (2, 'paid', 500, DATE '2026-03-01'), "
    "(3, 'refunded', 1000, DATE '2026-11-01')) AS orders(id, status, amount, day);"
)
TEMPLATES = {
    "orders": "-- @kind source\n-- @output result\n" + ORDERS,
    "minimum": "-- @input source\n-- @param threshold: number = 0\n-- @output result\n"
    "SELECT * FROM {{ source }} WHERE amount >= {{ threshold }};",
    "status": '-- @input source\n-- @param status: text = "paid"\n-- @output result\n'
    "SELECT * FROM {{ source }} WHERE status = {{ status }};",
    "since": "-- @input source\n-- @param start: date\n-- @output result\n"
    "SELECT * FROM {{ source }} WHERE day >= {{ start }};",
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
    "order_status": {"type": "choice(paid|refunded|pending)", "default": "paid"},
    "report_start": {"type": "date", "default": "2026-02-01", "environments": {"prod": "2026-01-01"}},
}
NODES = ("orders", "large", "total", "paid", "recent")
COMPONENT = {
    "id": "large_orders",
    "name": "Large orders",
    "nodes": [
        {"id": "filter", "template": "minimum", "params": {}},
        {"id": "sum", "template": "total", "params": {}},
    ],
    "edges": [
        {
            "id": "inner",
            "source": "filter",
            "sourceHandle": "result",
            "target": "sum",
            "targetHandle": "source",
        }
    ],
    "inputs": {"orders": {"node": "filter", "port": "source"}},
    "outputs": {"summary": {"node": "sum", "port": "result"}},
    "parameters": {
        "minimum": {"type": "number", "default": 0, "targets": [{"node": "filter", "param": "threshold"}]}
    },
}


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
            "name": "Variables",
            "nodes": [
                {"id": "orders", "template": "orders", "label": "Orders", "params": {}},
                {
                    "id": "large",
                    "template": "minimum",
                    "label": "Large orders",
                    "params": {"threshold": {"$var": "threshold"}},
                },
                {"id": "total", "template": "total", "label": "Total", "params": {}},
                {
                    "id": "paid",
                    "template": "status",
                    "label": "Paid",
                    "params": {"status": {"$var": "order_status"}},
                },
                {
                    "id": "recent",
                    "template": "since",
                    "label": "Recent",
                    "params": {"start": {"$var": "report_start"}},
                },
            ],
            "edges": [
                edge("orders", "large"),
                edge("large", "total"),
                edge("orders", "paid"),
                edge("orders", "recent"),
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


def ids(engine, worktree, environment, key, port="result"):
    return sorted(row["values"][0] for row in engine.preview(worktree, environment, key, port)["rows"])


def statuses(engine, worktree, environment, keys=NODES):
    return {key: engine.preview(worktree, environment, key)["status"] for key in keys}


# Declarations


def test_declarations_accept_every_type_and_prefer_environment_values_to_defaults():
    declared, error = variables.declarations(
        {
            "variables": {
                "label": {"type": "text", "default": ""},
                "threshold": {"type": "number", "default": 300, "environments": {"prod": 900.5}},
                "strict": {"type": "boolean", "default": False},
                "start": {"type": "date", "default": "2026-10-01"},
                "status": {"type": " choice( paid | left outer ) ", "default": "left outer"},
                "schema": {"type": "identifier", "environments": {"prod": "SALES"}},
                "regions": {"type": "list < text >", "default": ["North", "South"]},
                "limits": {"type": "list<number>", "default": [1, 2.5]},
            }
        }
    )
    assert error is None
    assert {name: variable["type"] for name, variable in declared.items()} == {
        "label": "text",
        "threshold": "number",
        "strict": "boolean",
        "start": "date",
        "status": "choice(paid|left outer)",
        "schema": "identifier",
        "regions": "list<text>",
        "limits": "list<number>",
    }
    assert not any(variable["errors"] for variable in declared.values())
    assert variables.resolve(declared["threshold"], "prod") == {"value": 900.5, "source": "environment"}
    assert variables.resolve(declared["threshold"], "dev") == {"value": 300, "source": "default"}
    assert variables.resolve(declared["schema"], "dev") == {"error": "no value in dev"}
    assert variables.declarations({"variables": None}) == ({}, None)


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ('{"threshold": ', "variables.json is not valid JSON"),
        ("[]", "must contain a JSON object of variables"),
        ({"High": {"type": "number"}}, "Invalid variable name 'High'"),
        ({"2nd": {"type": "number"}}, "Invalid variable name '2nd'"),
        ({"rate": {"type": "decimal"}}, "unknown type 'decimal'"),
        ({"rate": {"type": "choice()"}}, "unknown type"),
        ({"rate": {"type": "list<boolean>"}}, "unknown type"),
        ({"rate": {"type": "number", "enviroments": {"prod": 1}}}, "unknown fields: enviroments"),
        ({"rate": 3}, "must be an object with a type"),
        ({"rate": {"type": "number", "environments": [1]}}, "environments must be an object"),
        ({"rate": {"type": "number", "description": 1}}, "description must be text"),
    ],
)
def test_malformed_files_names_and_types_are_one_file_error(content, message):
    bundle = {"variables": variables.read(content) if isinstance(content, str) else content}
    declared, error = variables.declarations(bundle)
    assert declared == {}
    assert message in error
    assert variables.problems(bundle) == [{"file": "variables.json", "message": error}]


def test_values_that_do_not_match_their_type_are_errors_on_the_variable_and_environment():
    bundle = {
        "variables": {
            "threshold": {"type": "number", "default": "many", "environments": {"prod": 5, "test": True}},
            "start": {"type": "date", "default": "2026-02-30"},
            "status": {"type": "choice(paid|refunded)", "default": "pending"},
            "regions": {"type": "list<text>", "default": ["North", 3]},
            "schema": {"type": "identifier", "default": " "},
        }
    }
    declared, error = variables.declarations(bundle)
    assert error is None
    threshold = declared["threshold"]
    assert variables.resolve(threshold, "prod") == {"value": 5, "source": "environment"}
    assert variables.resolve(threshold, "dev") == {
        "error": 'invalid default value, expected a finite number, got "many"'
    }
    assert variables.resolve(threshold, "test") == {
        "error": "invalid value for test, expected a finite number, got true"
    }
    problems = variables.problems(bundle)
    assert [p["variable"] for p in problems] == [
        "regions",
        "schema",
        "start",
        "status",
        "threshold",
        "threshold",
    ]
    assert {
        "file": "variables.json",
        "variable": "start",
        "message": (
            'Variable start: invalid default value, expected a date written YYYY-MM-DD, got "2026-02-30"'
        ),
    } in problems
    assert any(p["message"].endswith('expected one of paid, refunded, got "pending"') for p in problems)


def test_unknown_environments_and_credential_names_are_warnings_that_block_nothing():
    bundle = project_bundle()
    bundle["variables"]["api_token"] = {
        "type": "text",
        "default": "visible",
        "environments": {"staging": "x"},
    }
    assert [w["message"] for w in variables.warnings(bundle, ["dev", "prod"])] == [
        "Variable api_token has a value for staging, which is not an environment of this instance",
        "Variable api_token looks like a credential. Variables are visible in Git, compiled SQL and run "
        "history; keep secrets in a connection.",
    ]
    # Validation diagnostics gate merges, so warnings stay out of them.
    assert validate(bundle) == []


@pytest.mark.parametrize(
    ("variable", "parameter", "allowed"),
    [
        ("text", "text", True),
        ("text", "file(connection)", True),
        ("text", "destination(connection)", True),
        ("text", "number", False),
        ("text", "identifier", False),
        ("text", "connection", False),
        ("text", "secret(connection)", False),
        ("text", "expression(source)", False),
        ("text", "schema", False),
        ("number", "number", True),
        ("number", "text", False),
        ("boolean", "boolean", True),
        ("boolean", "text", False),
        ("date", "date", True),
        ("date", "text", False),
        ("choice(paid|refunded)", "text", True),
        ("choice(paid|refunded)", "choice(paid|refunded|pending)", True),
        ("choice(paid|refunded)", "choice(paid|pending)", False),
        ("choice(inner|left)", "keyword(inner|left|right|full)", True),
        ("choice(inner|cross)", "keyword(inner|left|right|full)", False),
        ("choice(paid|refunded)", "number", False),
        ("identifier", "identifier", True),
        ("identifier", "column(source)", True),
        ("identifier", "text", False),
        ("list<text>", "list<text>", True),
        ("list<text>", "list<number>", False),
        ("list<number>", "list<number>", True),
        ("list<number>", "number", False),
    ],
)
def test_variable_types_bind_only_to_compatible_parameters(variable, parameter, allowed):
    assert variables.compatible(variable, parameter) is allowed


def test_date_parameters_bind_iso_dates_that_compare_as_dates():
    template = parse_template(
        '-- @input source\n-- @param start: date = "2026-01-01"\n-- @output result\n'
        "SELECT * FROM {{ source }} WHERE day >= {{ start }};"
    )
    assert template["parameters"] == [{"name": "start", "type": "date", "default": "2026-01-01"}]

    def compile_with(params):
        return compile_template(template, params, {"source": '"input"'}, {"result": "output"}, {}, Path())

    [statement] = compile_with({"start": "2026-02-01"})
    assert statement["query"] == 'SELECT * FROM "input" WHERE day >= CAST($start AS DATE)'
    assert statement["bindings"] == {"start": "2026-02-01"}
    for invalid in ("2026-02-30", "01/02/2026", 20260201):
        with pytest.raises(Problem, match="start requires a date written YYYY-MM-DD"):
            compile_with({"start": invalid})


# Resolution and execution


def test_runs_bind_the_selected_environment_and_record_values_and_sources(services):
    store, projects, _, engine = services
    worktree = projects.create("Variables", project_bundle())["id"]
    assert projects.snapshot(worktree)["diagnostics"] == []
    dev = wait_run(store, engine.launch(worktree, "dev"))
    prod = wait_run(store, engine.launch(worktree, "prod"))
    assert dev["status"] == prod["status"] == "success"
    assert engine.preview(worktree, "dev", "total")["rows"][0]["values"] == [2, 1500]
    assert engine.preview(worktree, "prod", "total")["rows"][0]["values"] == [1, 1000]
    assert ids(engine, worktree, "dev", "recent") == [2, 3]
    assert ids(engine, worktree, "prod", "recent") == [1, 2, 3]
    assert ids(engine, worktree, "prod", "paid") == [1, 2]
    assert prod["variables"] == {
        "order_status": {"type": "choice(paid|refunded|pending)", "value": "paid", "source": "default"},
        "report_start": {"type": "date", "value": "2026-01-01", "source": "environment"},
        "threshold": {"type": "number", "value": 900, "source": "environment"},
    }
    assert prod["variable_declarations"] == VARIABLES
    large = prod["nodes"]["large"]
    assert large["variables"] == {"threshold": "threshold"}
    assert large["parameters"] == {"threshold": 900}
    assert large["statements"][0]["bindings"] == {"threshold": 900}
    assert large["statements"][0]["variables"] == [
        {
            "parameter": "threshold",
            "name": "threshold",
            "type": "number",
            "value": 900,
            "source": "environment",
        }
    ]
    assert "variables" not in prod["nodes"]["orders"]
    # A node run records only the variables of its scope.
    scoped = wait_run(store, engine.launch(worktree, "prod", "total"))
    assert scoped["variables"] == {"threshold": {"type": "number", "value": 900, "source": "environment"}}


def test_a_variable_without_value_blocks_only_its_nodes_in_that_environment(services):
    store, projects, _, engine = services
    bundle = project_bundle()
    bundle["variables"]["order_status"] = {"type": "text", "environments": {"prod": "refunded"}}
    bundle["flow"]["nodes"].append({"id": "paid_total", "template": "total", "params": {}})
    bundle["flow"]["edges"].append(edge("paid", "paid_total"))
    worktree = projects.create("Variables", bundle)["id"]
    assert projects.snapshot(worktree)["diagnostics"] == []
    dev = wait_run(store, engine.launch(worktree, "dev"))
    assert dev["status"] == "partial_failure"
    assert dev["nodes"]["paid"]["status"] == "blocked"
    assert dev["nodes"]["paid"]["error"] == "Variable order_status: no value in dev"
    assert dev["nodes"]["paid_total"]["error"] == "Blocked by paid"
    assert {dev["nodes"][key]["status"] for key in ("orders", "large", "total", "recent")} == {"success"}
    assert dev["variables"]["order_status"] == {"type": "text", "error": "no value in dev"}
    prod = wait_run(store, engine.launch(worktree, "prod"))
    assert prod["status"] == "success"
    assert ids(engine, worktree, "prod", "paid") == [3]
    with pytest.raises(Problem, match="Variable order_status: no value in dev"):
        engine.launch(worktree, "dev", "paid")
    with pytest.raises(Problem, match="Variable order_status: no value in dev"):
        engine.compile(worktree, "dev", "paid")
    assert engine.compile(worktree, "prod", "paid")[0]["bindings"] == {"status": "refunded"}


def test_undeclared_and_incompatible_references_block_the_node_and_its_descendants(services):
    store, projects, _, engine = services
    bundle = project_bundle()
    node(bundle, "large")["params"]["threshold"] = {"$var": "missing"}
    node(bundle, "paid")["params"]["status"] = {"$var": "threshold"}
    worktree = projects.create("Variables", bundle)["id"]
    assert projects.snapshot(worktree)["diagnostics"] == [
        {
            "file": "flow.json",
            "node": "large",
            "message": "Parameter threshold references undeclared variable missing",
        },
        {
            "file": "flow.json",
            "node": "paid",
            "message": "Variable threshold (number) cannot be bound to parameter status (text)",
        },
    ]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["nodes"]["large"]["status"] == "blocked"
    assert run["nodes"]["large"]["error"] == "Parameter threshold references undeclared variable missing"
    assert run["nodes"]["total"]["error"] == "Blocked by large"
    assert run["nodes"]["paid"]["status"] == "blocked"
    assert {run["nodes"][key]["status"] for key in ("orders", "recent")} == {"success"}
    assert run["variables"]["missing"] == {"type": None, "error": "undeclared variable"}


def test_unused_variables_never_block_anything_even_when_invalid(services):
    store, projects, _, engine = services
    bundle = project_bundle()
    bundle["variables"]["unused"] = {"type": "number", "default": "many"}
    bundle["variables"]["later"] = {"type": "date"}
    worktree = projects.create("Variables", bundle)["id"]
    assert projects.snapshot(worktree)["diagnostics"] == [
        {
            "file": "variables.json",
            "variable": "unused",
            "message": 'Variable unused: invalid default value, expected a finite number, got "many"',
        }
    ]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["status"] == "success"
    assert set(run["variables"]) == {"threshold", "order_status", "report_start"}


def test_a_malformed_file_is_saved_as_is_and_blocks_only_nodes_with_references(services):
    store, projects, _, engine = services
    worktree = projects.create("Variables", project_bundle())["id"]
    snapshot = projects.snapshot(worktree)
    saved = projects.write(
        worktree, snapshot["revision"], {**snapshot["files"], "variables.json": '{"threshold": '}
    )
    assert saved["files"]["variables.json"] == saved["bundle"]["variables"] == '{"threshold": '
    [diagnostic] = saved["diagnostics"]
    assert diagnostic["file"] == "variables.json"
    assert diagnostic["message"].startswith("variables.json is not valid JSON")
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["nodes"]["orders"]["status"] == "success"
    assert {run["nodes"][key]["status"] for key in ("large", "paid", "recent", "total")} == {"blocked"}
    assert "variables.json is not valid JSON" in run["nodes"]["large"]["error"]
    # A bundle save that does not touch the file keeps its text.
    save(projects, worktree, lambda bundle: node(bundle, "orders").update(label="All orders"))
    assert projects.snapshot(worktree)["files"]["variables.json"] == '{"threshold": '


# Fingerprints and capture


def test_changing_a_production_value_invalidates_only_production_results_that_use_it(services):
    store, projects, _, engine = services
    worktree = projects.create("Variables", project_bundle())["id"]
    for environment in ("dev", "prod"):
        assert wait_run(store, engine.launch(worktree, environment))["status"] == "success"
    save(projects, worktree, lambda bundle: bundle["variables"]["threshold"]["environments"].update(prod=950))
    assert statuses(engine, worktree, "prod") == {
        "orders": "valid",
        "large": "stale",
        "total": "stale",
        "paid": "valid",
        "recent": "valid",
    }
    assert set(statuses(engine, worktree, "dev").values()) == {"valid"}


def test_renames_descriptions_and_promoted_literals_keep_results_valid(services):
    store, projects, _, engine = services
    bundle = project_bundle()
    node(bundle, "paid")["params"]["status"] = "paid"
    del bundle["variables"]["order_status"]
    worktree = projects.create("Variables", bundle)["id"]
    for environment in ("dev", "prod"):
        assert wait_run(store, engine.launch(worktree, environment))["status"] == "success"

    def promote(bundle):
        bundle["variables"]["order_status"] = {"type": "choice(paid|refunded)", "default": "paid"}
        node(bundle, "paid")["params"]["status"] = {"$var": "order_status"}

    save(projects, worktree, promote)
    save(
        projects, worktree, lambda bundle: bundle["variables"]["threshold"].update(description="New wording")
    )
    snapshot = projects.snapshot(worktree)
    renamed = variables.rename(snapshot["bundle"], "threshold", "minimum_amount")
    projects.write(worktree, snapshot["revision"], bundle_to_files(renamed))
    current = projects.snapshot(worktree)["bundle"]
    assert node(current, "large")["params"]["threshold"] == {"$var": "minimum_amount"}
    assert "threshold" not in current["variables"]
    for environment in ("dev", "prod"):
        assert set(statuses(engine, worktree, environment).values()) == {"valid"}


def test_a_launch_uses_the_values_of_its_captured_commit(services):
    store, projects, catalog, engine = services
    bundle = project_bundle()
    bundle["templates"]["orders"] = (
        '-- @kind source\n-- @param connection: connection = "local"\n-- @output result\n' + ORDERS
    )
    worktree = projects.create("Variables", bundle)["id"]
    entered, release = threading.Event(), threading.Event()
    prepare = catalog.prepare

    def pause(db, captured):
        entered.set()
        release.wait(5)
        prepare(db, captured)

    catalog.prepare = pause
    run = engine.launch(worktree, "prod")
    assert entered.wait(2)
    save(projects, worktree, lambda bundle: bundle["variables"]["threshold"]["environments"].update(prod=950))
    release.set()
    result = wait_run(store, run)
    assert result["status"] == "success"
    assert result["variables"]["threshold"]["value"] == 900
    assert result["nodes"]["large"]["parameters"] == {"threshold": 900}
    assert result["commit"] != projects.snapshot(worktree)["commit"]
    assert engine.preview(worktree, "prod", "large")["status"] == "stale"
    assert engine.preview(worktree, "prod", "paid")["status"] == "valid"


# Components


def test_exposed_component_parameters_bind_variables_on_the_instance(services):
    store, projects, _, engine = services
    bundle = project_bundle()
    bundle["components"]["large_orders"] = copy.deepcopy(COMPONENT)
    bundle["flow"]["nodes"].append(
        {
            "id": "summary",
            "component": "large_orders",
            "label": "Summary",
            "params": {"minimum": {"$var": "threshold"}},
        }
    )
    bundle["flow"]["edges"].append(edge("orders", "summary", "orders"))
    worktree = projects.create("Variables", bundle)["id"]
    assert projects.snapshot(worktree)["diagnostics"] == []
    for environment in ("dev", "prod"):
        assert wait_run(store, engine.launch(worktree, environment))["status"] == "success"
    assert engine.preview(worktree, "dev", "summary", "summary")["rows"][0]["values"] == [2, 1500]
    prod = engine.preview(worktree, "prod", "summary", "summary")
    assert prod["rows"][0]["values"] == [1, 1000]
    assert store.get("run", prod["run"])["nodes"]["summary::filter"]["variables"] == {
        "threshold": "threshold"
    }
    assert variables.usages(projects.snapshot(worktree)["bundle"])["threshold"] == [
        {"node": "large", "label": "Large orders", "param": "threshold"},
        {"node": "summary", "label": "Summary", "param": "minimum"},
    ]
    save(projects, worktree, lambda bundle: bundle["variables"]["threshold"]["environments"].update(prod=950))
    assert engine.preview(worktree, "prod", "summary", "summary")["status"] == "stale"
    assert engine.preview(worktree, "dev", "summary", "summary")["status"] == "valid"


def test_templates_and_components_cannot_reference_variables(services):
    store, projects, _, engine = services
    bundle = project_bundle()
    bundle["templates"]["fixed"] = (
        '-- @input source\n-- @param status: text = {"$var": "order_status"}\n-- @output result\n'
        "SELECT * FROM {{ source }} WHERE status = {{ status }};"
    )
    bundle["templates"]["inline"] = (
        "-- @input source\n-- @output result\nSELECT * FROM {{ source }} WHERE amount >= {{ var.threshold }};"
    )
    component = copy.deepcopy(COMPONENT)
    component["nodes"][0]["params"] = {"threshold": {"$var": "threshold"}}
    bundle["components"]["large_orders"] = component
    bundle["flow"]["nodes"] += [
        {"id": "fixed", "template": "fixed", "params": {}},
        {"id": "inline", "template": "inline", "params": {}},
        {"id": "summary", "component": "large_orders", "params": {}},
    ]
    bundle["flow"]["edges"] += [
        edge("orders", "fixed"),
        edge("orders", "inline"),
        edge("orders", "summary", "orders"),
    ]
    worktree = projects.create("Variables", bundle)["id"]
    diagnostics = {d["file"]: d["message"] for d in projects.snapshot(worktree)["diagnostics"]}
    assert diagnostics == {
        "templates/fixed.sql": "Templates cannot reference project variables (default of status). "
        "Declare a parameter, then bind it to the variable on the node in the flow.",
        "templates/inline.sql": "Templates cannot reference project variables ({{ var.threshold }}). "
        "Declare a parameter, then bind it to the variable on the node in the flow.",
        "components/large_orders.json": "Component definitions cannot reference project variables "
        "(filter.threshold). Expose the parameter, then bind it to the variable on the component instance.",
    }
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["nodes"]["fixed"]["status"] == run["nodes"]["inline"]["status"] == "blocked"
    assert run["nodes"]["inline"]["error"].startswith("Template inline references project variables")
    # Every node of such a definition is blocked, whether or not it is bound itself.
    for key in ("summary::filter", "summary::sum"):
        assert run["nodes"][key]["error"].startswith("Component large_orders references project variables")
    assert {run["nodes"][key]["status"] for key in NODES} == {"success"}


def test_grouping_turns_bound_parameters_into_exposed_parameters_of_the_instance():
    bundle = project_bundle()
    bundle["flow"]["nodes"].append(
        {"id": "huge", "template": "minimum", "params": {"threshold": {"$var": "threshold"}}}
    )
    bundle["flow"]["edges"].append(edge("orders", "huge"))
    grouped, instance = group(bundle, ["large", "total", "huge"], "Large orders")
    definition = grouped["components"][node(grouped, instance)["component"]]
    assert variables.component_references(definition) == []
    assert definition["parameters"] == {
        "threshold": {"type": "number", "targets": [{"node": "large", "param": "threshold"}]},
        "threshold_2": {"type": "number", "targets": [{"node": "huge", "param": "threshold"}]},
    }
    assert node(grouped, instance)["params"] == {
        "threshold": {"$var": "threshold"},
        "threshold_2": {"$var": "threshold"},
    }
    assert validate(grouped) == []
    # A parameter the request already exposes is bound instead of being exposed twice.
    exposed = {"minimum": {"type": "number", "targets": [{"node": "large", "param": "threshold"}]}}
    reused, instance = group(project_bundle(), ["large"], "Large", exposed)
    assert list(reused["components"][node(reused, instance)["component"]]["parameters"]) == ["minimum"]
    assert node(reused, instance)["params"] == {"minimum": {"$var": "threshold"}}


# Files, merge and comparison


def test_variables_merge_per_variable_and_per_field():
    base = bundle_to_files(project_bundle())

    def edited(change):
        bundle = files_to_bundle(base)
        change(bundle["variables"]["threshold"])
        return bundle_to_files(bundle)

    current = edited(lambda variable: variable["environments"].update(prod=950))
    proposal = edited(lambda variable: variable.update(description="Kept by the high-value report."))
    merged, conflicts = merge_files(base, current, proposal)
    assert conflicts == []
    threshold = json.loads(merged["variables.json"])["threshold"]
    assert threshold["environments"] == {"prod": 950}
    assert threshold["description"] == "Kept by the high-value report."
    other = edited(lambda variable: variable["environments"].update(prod=1000))
    assert merge_files(base, current, other)[1] == ["variables.json/threshold/environments/prod"]


def test_variables_file_follows_external_batching_and_conflict_handling(services):
    _, projects, _, _ = services
    worktree = projects.create("Variables", project_bundle())
    initial = projects.snapshot(worktree["id"])
    path = Path(worktree["path"]) / "variables.json"
    external = json.loads(path.read_text())
    external["threshold"]["environments"]["prod"] = 950
    path.write_text(json.dumps(external))
    flushed = projects.flush(worktree["id"])
    assert flushed["bundle"]["variables"]["threshold"]["environments"]["prod"] == 950
    assert projects.history(worktree["id"])[0]["message"] == "feat(variable): update threshold [external]"
    proposal = copy.deepcopy(initial["bundle"])
    proposal["variables"]["threshold"]["environments"]["prod"] = 1000
    with pytest.raises(Problem, match="Concurrent edits conflict") as conflict:
        projects.write(worktree["id"], initial["revision"], bundle_to_files(proposal))
    assert conflict.value.detail["paths"] == ["variables.json/threshold/environments/prod"]
    # Removing the file is an ordinary save too.
    removed = copy.deepcopy(projects.snapshot(worktree["id"]))
    removed["bundle"]["variables"] = None
    saved = projects.write(worktree["id"], removed["revision"], bundle_to_files(removed["bundle"]))
    assert "variables.json" not in saved["files"]
    assert not path.exists()


def test_compare_versions_lists_changed_variables_and_the_nodes_they_affect():
    before = bundle_to_files(project_bundle())

    def changed(report):
        return {c["id"]: c for c in report["entities"] if c["status"] != "unchanged"}

    production = files_to_bundle(before)
    production["variables"]["threshold"]["environments"]["prod"] = 950
    after = bundle_to_files(production)
    report = compare_files(before, after)
    [change] = changed(report).values()
    assert {k: change[k] for k in ("id", "kind", "name", "file", "status", "fields", "categories")} == {
        "id": "variable/threshold",
        "kind": "variable",
        "name": "threshold",
        "file": "variables.json",
        "status": "modified",
        "fields": ["environments/prod"],
        "categories": ["processing"],
    }
    assert change["usages"] == [{"node": "large", "label": "Large orders", "param": "threshold"}]
    assert report["impact"]["direct"] == ["large"]
    assert report["impact"]["downstream"] == ["total"]
    assert commit_message(before, after).startswith("feat(variable): update threshold")

    described = files_to_bundle(before)
    described["variables"]["threshold"]["description"] = "New wording"
    report = compare_files(before, bundle_to_files(described))
    assert changed(report)["variable/threshold"]["categories"] == ["documentation"]
    assert report["impact"]["direct"] == []
    assert commit_message(before, bundle_to_files(described)).startswith("docs(variable): update threshold")

    renamed = bundle_to_files(variables.rename(files_to_bundle(before), "threshold", "minimum_amount"))
    report = compare_files(before, renamed)
    assert set(changed(report)) == {"variable/threshold", "variable/minimum_amount", "node/large"}
    assert report["impact"]["direct"] == []


def test_rename_rejects_unknown_existing_and_invalid_names():
    bundle = project_bundle()
    with pytest.raises(Problem, match="Variable missing not found"):
        variables.rename(bundle, "missing", "other")
    with pytest.raises(Problem, match="already exists"):
        variables.rename(bundle, "threshold", "order_status")
    with pytest.raises(Problem, match="lowercase letters"):
        variables.rename(bundle, "threshold", "Threshold")
    with pytest.raises(Problem, match=r"Correct variables\.json"):
        variables.rename({**bundle, "variables": "{"}, "threshold", "other")
    assert variables.rename(bundle, "threshold", "threshold") == bundle


# HTTP API


@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path / "instance", watch=False)


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        yield client


@pytest.fixture
def path(client):
    worktree = client.post("/api/projects", json={"name": "Variables"}).json()["id"]
    path = f"/api/worktrees/{worktree}"
    snapshot = client.get(path).json()
    bundle = snapshot["bundle"]
    example = project_bundle()
    bundle["templates"].update(example["templates"])
    bundle["flow"].update(nodes=example["flow"]["nodes"], edges=example["flow"]["edges"])
    bundle["variables"] = example["variables"]
    response = client.put(path, json={"revision": snapshot["revision"], "bundle": bundle})
    assert response.status_code == 200, response.text
    return path


def test_api_snapshot_lists_variables_with_values_usages_and_diagnostics(client, path):
    snapshot = client.get(path).json()
    assert snapshot["bundle"]["variables"] == VARIABLES
    assert json.loads(snapshot["files"]["variables.json"]) == VARIABLES
    summary = snapshot["variables"]
    assert summary["file_error"] is None
    assert summary["diagnostics"] == summary["warnings"] == []
    assert summary["undeclared"] == {}
    threshold = summary["declarations"]["threshold"]
    assert threshold["description"] == "Minimum order amount kept by the report."
    assert threshold["values"] == {
        "dev": {"value": 300, "source": "default"},
        "prod": {"value": 900, "source": "environment"},
    }
    assert threshold["usages"] == [{"node": "large", "label": "Large orders", "param": "threshold"}]
    # Raw file saves are diagnosed, not rejected.
    declared = {**VARIABLES, "db_password": {"type": "text", "default": 3, "environments": {"qa": "x"}}}
    files = {**snapshot["files"], "variables.json": json.dumps(declared)}
    response = client.put(path, json={"revision": snapshot["revision"], "files": files})
    assert response.status_code == 200, response.text
    summary = client.get(path).json()["variables"]
    password = summary["declarations"]["db_password"]
    assert password["errors"] == ["invalid default value, expected text, got 3"]
    assert password["values"]["dev"] == {"error": "invalid default value, expected text, got 3"}
    assert len(password["warnings"]) == 2
    assert summary["diagnostics"] == [
        {
            "file": "variables.json",
            "variable": "db_password",
            "message": "Variable db_password: invalid default value, expected text, got 3",
        }
    ]


def test_project_zip_exports_and_imports_variables(client, path):
    archive = client.get(path + "/archive.zip")
    with zipfile.ZipFile(io.BytesIO(archive.content)) as content:
        assert json.loads(content.read("variables.json")) == VARIABLES
    response = client.post(
        "/api/projects/import", files={"file": ("project.zip", archive.content, "application/zip")}
    )
    assert response.status_code == 200, response.text
    imported = client.get(f"/api/worktrees/{response.json()['id']}").json()
    assert imported["bundle"]["variables"] == VARIABLES
    assert imported["diagnostics"] == []


def test_renaming_a_variable_updates_its_declaration_and_references_in_one_commit(client, path):
    snapshot = client.get(path).json()
    commits = len(client.get(path + "/history").json())
    url = path + "/variables/threshold/rename"
    response = client.post(url, json={"revision": snapshot["revision"], "name": "minimum_amount"})
    assert response.status_code == 200, response.text
    renamed = client.get(path).json()
    assert len(client.get(path + "/history").json()) == commits + 1
    assert set(renamed["bundle"]["variables"]) == {"minimum_amount", "order_status", "report_start"}
    assert renamed["bundle"]["variables"]["minimum_amount"] == VARIABLES["threshold"]
    assert node(renamed["bundle"], "large")["params"]["threshold"] == {"$var": "minimum_amount"}
    assert renamed["variables"]["declarations"]["minimum_amount"]["usages"] == [
        {"node": "large", "label": "Large orders", "param": "threshold"}
    ]
    assert client.post(url, json={"revision": snapshot["revision"], "name": "other"}).status_code == 409
    revision = renamed["revision"]
    for name, body, status in [
        ("missing", "other", 404),
        ("minimum_amount", "order_status", 409),
        ("minimum_amount", "Minimum", 400),
    ]:
        response = client.post(path + f"/variables/{name}/rename", json={"revision": revision, "name": body})
        assert response.status_code == status, response.text


def test_confirmation_scope_compiled_sql_and_run_details_show_the_values_used(app, client, path):
    settings = {"label": "Production", "color": "#aa0000", "confirm_before_run": True}
    assert client.put("/api/environments/prod", json=settings).status_code == 200
    launch = {"environment": "prod", "entry_point": "ui", "node": "total"}
    response = client.post(path + "/runs", json=launch)
    assert response.status_code == 409
    threshold = {"type": "number", "value": 900, "source": "environment"}
    assert response.json()["detail"]["variables"] == {"threshold": threshold}
    scope = client.get(path + "/variables/scope", params={"environment": "prod"})
    assert set(scope.json()) == {"threshold", "order_status", "report_start"}
    assert client.get(path + "/variables/scope", params={"environment": "prod", "node": "total"}).json() == {
        "threshold": threshold
    }
    assert (
        client.get(path + "/variables/scope", params={"environment": "prod", "node": "missing"}).status_code
        == 404
    )
    assert client.get(path + "/variables/scope", params={"environment": "missing"}).status_code == 404
    response = client.post(
        path + "/runs", json={"environment": "prod", "entry_point": "ui", "confirmed": True}
    )
    assert response.status_code == 200, response.text
    run = wait_run(app.state.services.store, response.json())
    assert run["status"] == "success", run
    details = client.get(f"/api/runs/{run['id']}").json()
    assert details["variables"]["threshold"] == threshold
    assert details["variables"]["report_start"] == {
        "type": "date",
        "value": "2026-01-01",
        "source": "environment",
    }
    recent = client.get(path + "/preview/recent", params={"environment": "prod"}).json()
    assert sorted(row["values"][0] for row in recent["rows"]) == [1, 2, 3]
    compiled = client.get(path + "/compile/large", params={"environment": "prod"}).json()
    assert compiled[0]["bindings"] == {"threshold": 900}
    bound = [{"parameter": "threshold", "name": "threshold", **threshold}]
    assert compiled[0]["variables"] == bound
    preview = client.get(path + "/preview/large", params={"environment": "prod"}).json()
    assert preview["executed_sql"][0]["variables"] == bound


def test_grouping_through_the_api_binds_the_new_instance_in_one_save(app, client, path):
    snapshot = client.get(path).json()
    commits = len(client.get(path + "/history").json())
    response = client.post(
        path + "/group",
        json={"revision": snapshot["revision"], "nodes": ["large", "total"], "name": "Large orders"},
    )
    assert response.status_code == 200, response.text
    assert len(client.get(path + "/history").json()) == commits + 1
    grouped = client.get(path).json()
    instance = response.json()["selected"]
    assert node(grouped["bundle"], instance)["params"] == {"threshold": {"$var": "threshold"}}
    assert grouped["diagnostics"] == []
    assert grouped["variables"]["declarations"]["threshold"]["usages"] == [
        {"node": instance, "label": "Large orders", "param": "threshold"}
    ]
    response = client.post(path + "/runs", json={"environment": "prod"})
    assert wait_run(app.state.services.store, response.json())["status"] == "success"
    preview = client.get(path + f"/preview/{instance}", params={"environment": "prod", "port": "output_1"})
    assert preview.json()["rows"][0]["values"] == [1, 1000]
