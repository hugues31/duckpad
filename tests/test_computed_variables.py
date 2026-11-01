"""Computed values are immutable run inputs, extracted from complete published outputs."""

import copy
import datetime
import json
import threading
from decimal import Decimal

import duckdb
import pytest
from helpers import wait_run

from duckpad import value_sources, variables
from duckpad.bundle import bundle_to_files
from duckpad.components import expand, group
from duckpad.merge import merge_files
from duckpad.templates import compile_template, parse_template
from duckpad.util import Problem


def bundle(sql="SELECT 4 AS amount, '2026-06-30' AS day"):
    return {
        "flow": {
            "name": "Control values",
            "nodes": [
                {"id": "control", "template": "control", "params": {}},
                {"id": "consumer", "template": "consumer", "params": {"amount": {"$var": "amount"}}},
                {"id": "independent", "template": "independent", "params": {}},
            ],
            "edges": [],
        },
        "templates": {
            "control": "-- @kind source\n-- @output result\n" + sql + ";",
            "consumer": "-- @kind source\n-- @param amount: number\n-- @output result\nSELECT {{ amount }} AS amount;",
            "independent": "-- @kind source\n-- @output result\nSELECT 1 AS independent;",
        },
        "components": {},
        "documentation": {},
        "variables": {
            "amount": {"type": "number", "from": {"node": "control", "column": "amount"}},
            "report_date": {"type": "date", "from": {"node": "control", "column": "day"}},
        },
    }


def change(projects, worktree, update):
    snapshot = projects.snapshot(worktree)
    update(snapshot["bundle"])
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))


@pytest.mark.parametrize(
    ("kind", "sql_type", "cell", "expected"),
    [
        ("number", "BIGINT", 2**60 + 1, 2**60 + 1),
        ("number", "DECIMAL(10,2)", "1234.56", 1234.56),
        ("number", "DECIMAL(10,2)", Decimal("1234.56"), 1234.56),
        ("date", "DATE", datetime.date(2026, 6, 30), "2026-06-30"),
        ("date", "VARCHAR", "2026-06-30", "2026-06-30"),
        ("boolean", "BOOLEAN", True, True),
        ("list<number>", "DECIMAL(10,2)[]", ["1.25", "2.50"], [1.25, 2.5]),
    ],
)
def test_lossless_conversions(kind, sql_type, cell, expected):
    assert value_sources.convert(kind, sql_type, cell) == expected
    assert json.loads(json.dumps(expected)) == expected


@pytest.mark.parametrize(
    ("kind", "sql_type", "cell"),
    [
        ("text", "DATE", "2026-06-30"),
        ("date", "TIMESTAMP", "2026-06-30 00:00:00"),
        ("boolean", "INTEGER", 1),
        ("boolean", "VARCHAR", "true"),
        ("number", "VARCHAR", "1.25"),
        ("number", "DOUBLE", float("nan")),
        ("number", "DECIMAL(38,20)", "0.12345678901234567890"),
        ("list<number>", "INTEGER[]", [1, None]),
        ("date", "VARCHAR", "2026-02-30"),
        ("text", "VARCHAR", None),
    ],
)
def test_unsafe_conversions_are_rejected(kind, sql_type, cell):
    with pytest.raises(Problem):
        value_sources.convert(kind, sql_type, cell)


@pytest.mark.parametrize(
    ("field", "value"), [("default", None), ("default", 0), ("environments", {}), ("environments", None)]
)
def test_computed_declarations_forbid_fallback_fields(field, value):
    project = bundle()
    project["variables"]["amount"][field] = value
    nodes, _, boundaries = expand(project)
    assert value_sources.sources(project, nodes, boundaries)["amount"]["code"] == "invalid_value_source"


def test_run_records_extractions_without_consumers_and_never_edits_declarations(services):
    store, projects, _, engine = services
    worktree = projects.create("Computed", bundle())["id"]
    before = projects.snapshot(worktree)["bundle"]["variables"]
    pending = engine.scope_variables(worktree, "dev")
    assert pending["amount"]["state"] == "pending"
    assert engine.pool.find(worktree, "dev") is None
    with pytest.raises(Problem, match="not calculated"):
        engine.compile(worktree, "dev", "consumer")
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["status"] == "success", run
    assert run["variables"]["amount"]["value"] == 4
    assert run["variables"]["report_date"]["value"] == "2026-06-30"
    assert run["variables"]["amount"]["from"]["port"] == "result"
    assert run["variables"]["amount"]["producer_run"] == run["id"]
    assert projects.snapshot(worktree)["bundle"]["variables"] == before
    assert engine.compile(worktree, "dev", "consumer")[0]["variables"][0]["value"] == 4


def test_targeted_run_retains_values_and_refresh_failure_does_not_fall_back(services):
    store, projects, _, engine = services
    worktree = projects.create("Computed", bundle())["id"]
    missing = wait_run(store, engine.launch(worktree, "dev", "consumer"))
    assert missing["status"] == "failed"
    assert missing["variables"]["amount"]["code"] == "value_not_calculated"
    first = wait_run(store, engine.launch(worktree, "dev"))
    change(
        projects,
        worktree,
        lambda b: b["templates"].update(control="-- @kind source\n-- @output result\nSELECT missing;"),
    )
    retained = wait_run(store, engine.launch(worktree, "dev", "consumer"))
    assert retained["status"] == "success"
    assert set(retained["nodes"]) == {"consumer"}
    assert retained["variables"]["amount"]["resolution"] == "retained"
    assert retained["variables"]["amount"]["producer_run"] == first["id"]
    failed = wait_run(store, engine.launch(worktree, "dev"))
    assert failed["status"] == "partial_failure"
    assert failed["variables"]["amount"]["code"] == "value_source_failed"
    assert "value" not in failed["variables"]["amount"]
    later = wait_run(store, engine.launch(worktree, "dev", "consumer"))
    assert later["variables"]["amount"]["value"] == 4


@pytest.mark.parametrize(
    ("sql", "code"),
    [
        ("SELECT 4 AS amount, '2026-06-30' AS day WHERE FALSE", "value_cardinality"),
        ("SELECT i AS amount, '2026-06-30' AS day FROM range(2) t(i)", "value_cardinality"),
        ("SELECT NULL AS amount, '2026-06-30' AS day", "value_null"),
        ("SELECT '4' AS amount, '2026-06-30' AS day", "value_type"),
        ("SELECT 4 AS other, '2026-06-30' AS day", "invalid_value_source"),
    ],
)
def test_bad_cells_block_only_their_consumers(services, sql, code):
    store, projects, _, engine = services
    worktree = projects.create("Computed", bundle(sql))["id"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["variables"]["amount"]["code"] == code
    assert run["nodes"]["consumer"]["status"] == "blocked"
    assert run["nodes"]["independent"]["status"] == "success"
    if code != "value_cardinality":
        assert run["variables"]["report_date"]["state"] == "ready"


def test_identical_refresh_preserves_out_of_scope_result_and_changed_value_invalidates_it(services):
    store, projects, _, engine = services
    worktree = projects.create("Computed", bundle())["id"]
    wait_run(store, engine.launch(worktree, "dev"))
    wait_run(store, engine.launch(worktree, "dev", "control"))
    assert engine.preview(worktree, "dev", "consumer")["status"] == "valid"
    change(
        projects,
        worktree,
        lambda b: b["templates"].update(control=b["templates"]["control"].replace("SELECT 4", "SELECT 5")),
    )
    assert engine.preview(worktree, "dev", "consumer")["status"] == "valid"
    wait_run(store, engine.launch(worktree, "dev", "control"))
    assert engine.preview(worktree, "dev", "consumer")["status"] == "stale"
    assert engine.preview(worktree, "dev", "independent")["status"] == "valid"


def test_targeted_launch_still_rejects_other_binding_errors_of_a_computed_consumer(services):
    store, projects, _, engine = services
    project = bundle()
    project["templates"]["consumer"] = (
        "-- @kind source\n-- @param amount: number\n-- @param label: text\n-- @output result\n"
        "SELECT {{ amount }} AS amount, {{ label }} AS label;"
    )
    project["flow"]["nodes"][1]["params"]["label"] = {"$var": "label"}
    project["variables"]["label"] = {"type": "text", "environments": {"prod": "adjusted"}}
    worktree = projects.create("Computed", project)["id"]
    assert wait_run(store, engine.launch(worktree, "dev"))["variables"]["amount"]["value"] == 4
    with pytest.raises(Problem, match="Variable label: no value in dev"):
        engine.launch(worktree, "dev", "consumer")


def test_value_cycle_is_localized(services):
    store, projects, _, engine = services
    project = bundle()
    project["templates"]["control"] = (
        "-- @kind source\n-- @param amount: number\n-- @output result\nSELECT {{ amount }} AS amount;"
    )
    project["flow"]["nodes"][0]["params"] = {"amount": {"$var": "amount"}}
    worktree = projects.create("Cycle", project)["id"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["variables"]["amount"]["code"] == "value_dependency_cycle"
    assert "control -> var.amount -> control" in run["variables"]["amount"]["error"]
    assert run["nodes"]["independent"]["status"] == "success"


def test_source_descriptors_merge_atomically():
    base = {"variables.json": json.dumps(bundle()["variables"])}
    current, incoming = copy.deepcopy(bundle()["variables"]), copy.deepcopy(bundle()["variables"])
    current["amount"]["from"]["node"] = "another"
    incoming["amount"]["from"]["column"] = "different"
    _, conflicts = merge_files(
        base, {"variables.json": json.dumps(current)}, {"variables.json": json.dumps(incoming)}
    )
    assert conflicts == ["variables.json/amount/from"]


def test_switching_variable_mode_merges_description_but_conflicts_with_old_values():
    def files(value):
        return {"variables.json": json.dumps({"amount": value})}

    ordinary = {"type": "number", "default": 4}
    computed = {"type": "number", "from": {"node": "control", "column": "amount"}}
    merged, conflicts = merge_files(
        files(ordinary), files(computed), files({**ordinary, "description": "A control value"})
    )
    assert not conflicts
    assert json.loads(merged["variables.json"])["amount"] == {**computed, "description": "A control value"}
    _, conflicts = merge_files(files(ordinary), files(computed), files({**ordinary, "default": 5}))
    assert conflicts == ["variables.json/amount"]


def test_path_fragments_are_escaped_and_authorized_after_resolution(tmp_path):
    template = parse_template(
        "-- @kind source\n-- @param file: file\n-- @output result\nSELECT * FROM read_csv({{ file }});"
    )
    values = {"folder": {"type": "text", "value": "O'Brien"}, "day": {"type": "date", "value": "2026-06-30"}}
    compiled = compile_template(
        template,
        {"file": "{{ var.folder }}/{{ var.day }}.csv"},
        {},
        {"result": "out"},
        {},
        {"file": tmp_path},
        variables=values,
    )
    assert "O''Brien/2026-06-30.csv" in compiled[0]["sql"]
    for bad in ("../escape", "/outside", "s3://other-bucket"):
        values["folder"]["value"] = bad
        with pytest.raises(Problem):
            compile_template(
                template,
                {"file": "{{ var.folder }}/file.csv"},
                {},
                {"result": "out"},
                {},
                {"file": tmp_path},
                variables=values,
            )


def test_grouping_preserves_value_source_references():
    grouped, instance = group(bundle(), ["control"], "Control")
    source = grouped["variables"]["amount"]["from"]
    assert source["node"] == instance
    nodes, _, boundaries = expand(grouped)
    resolved = value_sources.sources(grouped, nodes, boundaries)["amount"]
    assert resolved["node"] == instance + "::control"
    assert not variables.component_references(next(iter(grouped["components"].values())))


def test_component_output_executes_once_and_keeps_public_provenance(services):
    store, projects, _, engine = services
    project, instance = group(bundle(), ["control"], "Control")
    worktree = projects.create("Component values", project)["id"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["status"] == "success", run
    assert run["variables"]["amount"]["from"]["node"] == instance
    assert list(run["nodes"]).count(instance + "::control") == 1
    assert run["nodes"]["consumer"]["parameters"]["amount"] == 4


def test_shared_data_ancestor_executes_once_and_consumer_failure_keeps_published_values(
    services, monkeypatch
):
    store, projects, _, engine = services
    project = bundle()
    project["templates"]["control"] = (
        "-- @input source\n-- @output result\nSELECT independent + 3 AS amount, '2026-06-30' AS day FROM {{ source }};"
    )
    project["templates"]["consumer"] = (
        "-- @input source\n-- @param amount: number\n-- @output result\nSELECT error('consumer failed') AS value FROM {{ source }} WHERE independent < {{ amount }};"
    )
    project["flow"]["edges"] = [
        {
            "id": key,
            "source": "independent",
            "sourceHandle": "result",
            "target": key,
            "targetHandle": "source",
        }
        for key in ("control", "consumer")
    ]
    worktree = projects.create("Shared ancestor", project)["id"]
    executed = []
    original = engine.runs._run_node

    def record(execution, key):
        executed.append(key)
        original(execution, key)

    monkeypatch.setattr(engine.runs, "_run_node", record)
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["status"] == "partial_failure", run
    assert executed == ["independent", "control", "consumer"]
    assert engine.pool.computed(worktree, "dev", project)["amount"]["value"] == 4


@pytest.mark.parametrize(
    "source",
    [
        {"node": "missing", "column": "amount"},
        {"node": "control", "port": "missing", "column": "amount"},
        {"node": "control", "column": "amount", "extra": True},
        {"node": "control", "column": ""},
    ],
)
def test_invalid_sources_have_stable_local_diagnostics(source):
    project = bundle()
    project["variables"]["amount"]["from"] = source
    nodes, _, boundaries = expand(project)
    resolved = value_sources.sources(project, nodes, boundaries)
    assert resolved["amount"]["code"] == "invalid_value_source"
    assert "error" not in resolved["report_date"]


def test_failing_source_test_blocks_all_values_after_outputs_are_computed(services):
    store, projects, _, engine = services
    project = bundle()
    project["templates"]["control"] += "\n-- @test rejected: error\nSELECT * FROM {{ result }};"
    worktree = projects.create("Checked source", project)["id"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["nodes"]["control"]["status"] == "failed"
    assert {v["code"] for v in run["variables"].values()} == {"value_source_failed"}
    assert engine.pool.computed(worktree, "dev", project)["amount"]["state"] == "unavailable"


@pytest.mark.parametrize("alias", ["amount", "AMOUNT"])
def test_duplicate_output_column_is_not_silently_the_first_cell(services, alias):
    store, projects, _, engine = services
    worktree = projects.create(
        "Ambiguous column", bundle(f"SELECT 4 AS amount, 5 AS {alias}, '2026-06-30' AS day")
    )["id"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["variables"]["amount"]["code"] == "invalid_value_source"
    assert run["variables"]["report_date"]["state"] == "ready"


def test_case_insensitive_source_records_the_actual_column_for_live_provenance(services):
    from duckpad.lineage import Lineage

    store, projects, _, engine = services
    project = bundle()
    project["variables"]["amount"]["from"]["column"] = "AMOUNT"
    worktree = projects.create("Source column case", project)["id"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    value = run["variables"]["amount"]
    assert value["from"]["column"] == "amount"
    assert (
        Lineage(engine).explain(worktree, "dev", value["source_dataset"], 0, value["from"]["column"])["value"]
        == 4
    )
    assert projects.snapshot(worktree)["bundle"]["variables"]["amount"]["from"]["column"] == "AMOUNT"


def test_value_chains_are_forbidden_without_disabling_independent_nodes(services):
    store, projects, _, engine = services
    project = bundle()
    project["variables"]["second"] = {"type": "number", "from": {"node": "consumer", "column": "amount"}}
    worktree = projects.create("Value chain", project)["id"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["variables"]["amount"]["state"] == "ready"
    assert run["variables"]["second"]["code"] == "value_chain"
    assert run["nodes"]["independent"]["status"] == "success"


def test_retained_cache_is_isolated_and_eviction_does_not_rehydrate_history(services):
    store, projects, _, engine = services
    worktree = projects.create("Isolation", bundle())["id"]
    first = wait_run(store, engine.launch(worktree, "dev"))
    other = projects.create("Other worktree", bundle())["id"]
    for key, environment in ((other, "dev"), (worktree, "prod")):
        run = wait_run(store, engine.launch(key, environment, "consumer"))
        assert run["variables"]["amount"]["code"] == "value_not_calculated"
    engine.discard_worktree(worktree)
    assert store.get("run", first["id"])["variables"]["amount"]["value"] == 4
    run = wait_run(store, engine.launch(worktree, "dev", "consumer"))
    assert run["variables"]["amount"]["code"] == "value_not_calculated"


def test_source_type_changes_drop_association_but_explicit_inferred_port_preserves_it(services):
    store, projects, _, engine = services
    worktree = projects.create("Source changes", bundle())["id"]
    wait_run(store, engine.launch(worktree, "dev"))
    change(projects, worktree, lambda b: b["variables"]["amount"]["from"].update(port="result"))
    assert engine.scope_variables(worktree, "dev", "consumer")["amount"]["value"] == 4
    change(projects, worktree, lambda b: b["variables"]["amount"]["from"].update(column="other"))
    assert engine.scope_variables(worktree, "dev", "consumer")["amount"]["code"] == "value_not_calculated"


def test_new_source_with_same_typed_value_restores_scalar_only_validity(services):
    store, projects, _, engine = services
    project = bundle("SELECT 4 AS amount, 4 AS alternate, '2026-06-30' AS day")
    worktree = projects.create("Equivalent source", project)["id"]
    wait_run(store, engine.launch(worktree, "dev"))
    change(projects, worktree, lambda b: b["variables"]["amount"]["from"].update(column="alternate"))
    assert engine.preview(worktree, "dev", "consumer")["status"] == "stale"
    wait_run(store, engine.launch(worktree, "dev", "control"))
    assert engine.preview(worktree, "dev", "consumer")["status"] == "valid"


def test_cancel_during_value_phase_does_not_publish_partial_values(services, monkeypatch):
    store, projects, _, engine = services
    worktree = projects.create("Canceled values", bundle())["id"]
    entered, release = threading.Event(), threading.Event()
    original = engine.runs._freeze_values

    def paused(execution):
        entered.set()
        assert release.wait(10)
        original(execution)

    monkeypatch.setattr(engine.runs, "_freeze_values", paused)
    run = engine.launch(worktree, "dev")
    try:
        assert entered.wait(10)
        engine.cancel(run["id"])
    finally:
        release.set()
    finished = wait_run(store, run)
    assert finished["status"] == "canceled"
    assert engine.pool.computed(worktree, "dev", bundle())["amount"]["state"] == "unavailable"
    assert all("value" not in v for v in finished["variables"].values())


def test_values_are_frozen_at_admission_despite_edits_during_the_run(services, monkeypatch):
    store, projects, _, engine = services
    worktree = projects.create("Frozen values", bundle())["id"]
    first = wait_run(store, engine.launch(worktree, "dev"))
    entered, release = threading.Event(), threading.Event()
    original = engine.runs._run_node

    def paused(execution, key):
        entered.set()
        assert release.wait(10)
        original(execution, key)

    monkeypatch.setattr(engine.runs, "_run_node", paused)
    run = engine.launch(worktree, "dev", "consumer")
    try:
        assert entered.wait(10)
        change(projects, worktree, lambda b: b["variables"]["amount"]["from"].update(column="other"))
    finally:
        release.set()
    finished = wait_run(store, run)
    assert finished["status"] == "success"
    assert finished["variables"]["amount"]["value"] == 4
    assert finished["variables"]["amount"]["producer_run"] == first["id"]
    assert engine.preview(worktree, "dev", "consumer")["status"] == "stale"


@pytest.mark.parametrize(
    "template", ["{{ var.unknown }}", "{{ partition }}", "{{ var.day() }}", "{{ var.day", "{{ var.day }} }}"]
)
def test_invalid_path_references_are_diagnostics(tmp_path, template):
    from duckpad.templates import render_path

    with pytest.raises(Problem):
        render_path("file", template, {"day": {"type": "date", "value": "2026-06-30"}})


def test_path_symlinks_globs_and_uri_authority_are_checked(tmp_path):
    from duckpad.templates import authorize_path

    root = tmp_path / "allowed"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "escape").symlink_to(outside, target_is_directory=True)
    for path in ("escape/file.csv", "*/file.csv"):
        if path.startswith("*"):
            (outside / "file.csv").write_text("a\n1\n")
        with pytest.raises(Problem):
            authorize_path(path, path, root, "file", {}, None)
    (root / "safe.csv").write_text("a\n1\n")
    assert authorize_path("*.csv", "*.csv", root, "file", {}, None) == str(root / "*.csv")
    assert (
        authorize_path("s3://bucket/{{ var.name }}", "s3://bucket/file.csv", root, "file", {}, None)
        == "s3://bucket/file.csv"
    )
    with pytest.raises(Problem, match="authority"):
        authorize_path("s3://bucket/{{ var.name }}", "s3://other/file.csv", root, "file", {}, None)
    # DuckDB reads settings such as s3_endpoint from the URL query.
    for template, path in (
        ("{{ var.name }}", "s3://bucket/prefix/x.csv?s3_endpoint=evil.example"),
        ("data/{{ var.name }}", "s3://bucket/prefix/data/x#/../../other.csv"),
    ):
        with pytest.raises(Problem, match="query or fragment"):
            authorize_path(template, path, "s3://bucket/prefix", "file", {}, None)
    assert (
        authorize_path("s3://bucket/{{ var.name }}?v=1", "s3://bucket/a.csv?v=1", root, "file", {}, None)
        == "s3://bucket/a.csv?v=1"
    )


def test_whole_path_bindings_are_not_rendered_again_and_computed_ones_are_authorized(tmp_path):
    template = parse_template(
        "-- @kind source\n-- @param file: file\n-- @output result\nSELECT * FROM read_csv({{ file }});"
    )

    def compiled(value, bound=None, values=None):
        statements = compile_template(
            template,
            {"file": value},
            {},
            {"result": "out"},
            {},
            {"file": tmp_path},
            variables=values,
            bound=bound,
        )
        return statements[0]["sql"]

    computed = {"name": "path", "type": "text", "source": "node", "value": "/etc/hostname"}
    with pytest.raises(Problem, match="outside the allowed resource root"):
        compiled(computed["value"], {"file": computed})
    computed["value"] = "day/../report.csv"
    assert f"'{tmp_path.resolve() / 'report.csv'}'" in compiled(computed["value"], {"file": computed})
    ordinary = {"name": "pattern", "type": "text", "source": "default", "value": "{{ var.day }}.csv"}
    day = {"day": {"type": "text", "value": "secret"}}
    assert "secret" not in compiled(ordinary["value"], {"file": ordinary}, day)
    with pytest.raises(Problem, match="NUL"):
        compiled("{{ var.day }}.csv", None, {"day": {"type": "text", "value": "a\x00b"}})


def test_control_csv_binds_parquet_scan_predicate_and_path_without_a_join(services):
    store, projects, _, engine = services
    project = bundle()
    project["variables"] = {
        "report_date": {"type": "date", "from": {"node": "control", "column": "report_date"}},
        "mode": {"type": "choice(standard|adjusted)", "from": {"node": "control", "column": "mode"}},
        "with_adjustments": {"type": "boolean", "from": {"node": "control", "column": "with_adjustments"}},
    }
    project["templates"]["control"] = (
        "-- @kind source\n-- @param file: file\n-- @output result\nSELECT * FROM read_csv({{ file }});"
    )
    project["templates"]["consumer"] = (
        "-- @kind source\n-- @param file: file\n-- @param condition: expression\n-- @output result\nSELECT * FROM read_parquet({{ file }}) WHERE {{ condition }};"
    )
    project["flow"]["nodes"][0]["params"] = {"file": "run_control.csv"}
    project["flow"]["nodes"][1]["params"] = {
        "file": "orders_{{ var.mode }}.parquet",
        "condition": "day >= {{ var.report_date }} AND {{ var.with_adjustments }}",
    }
    tree = projects.create("Control CSV", project)
    directory = store.paths.resources(tree["project"])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "run_control.csv").write_text(
        "report_date;mode;with_adjustments\n2026-06-30;standard;true\n"
    )
    parquet = directory / "orders_standard.parquet"
    with duckdb.connect() as db:
        db.execute(
            "COPY (SELECT i AS id, DATE '2026-01-01' + CAST(i AS INTEGER) AS day FROM range(365) t(i)) TO ? (FORMAT PARQUET)",
            [str(parquet)],
        )
    run = wait_run(store, engine.launch(tree["id"], "dev"))
    assert run["status"] == "success", run
    statement = run["nodes"]["consumer"]["statements"][0]
    assert statement["paths"]["file"]["template"] == "orders_{{ var.mode }}.parquet"
    assert statement["paths"]["file"]["resource"] == str(parquet)
    with duckdb.connect() as db:
        planned = db.execute("EXPLAIN " + statement["query"], statement["bindings"]).fetchall()
        plan = "\n".join(str(row) for row in planned)
        assert "READ_PARQUET" in plan and "Filters:" in plan and "2026-06-30" in plan
        actual = db.execute(statement["query"], statement["bindings"]).fetchall()
        expected = db.execute(
            "SELECT * FROM read_parquet(?) WHERE day >= DATE '2026-06-30'", [str(parquet)]
        ).fetchall()
        assert actual == expected


def test_worker_preserves_decimal_and_rejects_timestamp_as_text(tmp_path):
    from fastapi.testclient import TestClient

    from duckpad.app import create_app

    app = create_app(tmp_path / "isolated", watch=False)
    with TestClient(app):
        services = app.state.services
        project = bundle("SELECT 1234.56::DECIMAL(10,2) AS amount, TIMESTAMP '2026-06-30 00:00:00' AS day")
        tree = services.projects.create("Worker types", project)
        run = wait_run(services.store, services.engine.launch(tree["id"], "dev"))
        assert services.engine.isolated
        assert run["variables"]["amount"]["value"] == 1234.56
        assert run["variables"]["report_date"]["code"] == "value_type"


def test_computed_export_path_is_captured_and_traversal_is_rejected(services):
    store, projects, _, engine = services
    project = bundle()
    project["templates"]["export"] = (
        "-- @kind export\n-- @input source\n-- @param destination: destination\nCOPY (SELECT * FROM {{ source }}) TO {{ destination }} (HEADER, FORMAT CSV);"
    )
    project["flow"]["nodes"].append(
        {"id": "export", "template": "export", "params": {"destination": "report_{{ var.report_date }}.csv"}}
    )
    project["flow"]["edges"].append(
        {
            "id": "export-edge",
            "source": "consumer",
            "sourceHandle": "result",
            "target": "export",
            "targetHandle": "source",
        }
    )
    tree = projects.create("Export values", project)
    run = wait_run(store, engine.launch(tree["id"], "dev"))
    assert run["status"] == "success", run
    result = engine.export_result(tree["id"], "dev", "export")
    assert result["status"] == "available"
    with engine.open_export(tree["id"], "dev", "export", run["id"]) as (stream, metadata):
        assert metadata["filename"] == "report_2026-06-30.csv"
        assert b"amount\n4" in stream.read()

    def unsafe(b):
        b["variables"]["path"] = {"type": "text", "default": "../escape.csv"}
        b["flow"]["nodes"][-1]["params"]["destination"] = "{{ var.path }}"

    change(projects, tree["id"], unsafe)
    failed = wait_run(store, engine.launch(tree["id"], "dev"))
    assert failed["nodes"]["export"]["status"] == "failed"
    assert "outside" in failed["nodes"]["export"]["error"]


def test_path_references_follow_rename_grouping_and_declaration_only_merge():
    project = bundle()
    project["templates"]["consumer"] = (
        "-- @kind source\n-- @param file: file\n-- @output result\nSELECT * FROM read_csv({{ file }});"
    )
    project["flow"]["nodes"][1]["params"] = {"file": "{{ var.report_date }}.csv"}
    renamed = variables.rename(project, "report_date", "day")
    assert variables.usages(renamed)["day"][0]["param"] == "file"
    grouped, instance = group(renamed, ["consumer"], "Reader")
    params = next(n for n in grouped["flow"]["nodes"] if n["id"] == instance)["params"]
    assert "{{ var.day }}.csv" in params.values()
    assert not any(variables.component_references(c) for c in grouped["components"].values())
    files = bundle_to_files(grouped)
    assert json.loads(files["variables.json"]) == grouped["variables"]
    assert "producer_run" not in files["variables.json"]
