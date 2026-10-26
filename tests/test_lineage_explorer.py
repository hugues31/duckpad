"""Contribution topology is independent of record pages and keeps role identity."""

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from test_lineage import pipeline

from duckpad.app import create_app
from duckpad.lineage_explorer import LineageExplorer
from duckpad.lineage_models import CancelRequest, Cell, RecordsRequest, StageRequest
from duckpad.util import Problem


def investigate(services, tmp_path, query, column="total", row=0):
    worktree, preview, _ = pipeline(services, tmp_path, query)
    cell = Cell(dataset=preview["id"], execution=preview["run"], row=row, column=column)
    request = StageRequest(root=cell, cell=cell, request_id="test")
    explorer = LineageExplorer(services[3])
    stage = explorer.stage(worktree, request)
    return explorer, worktree, request, stage


def records(explorer, worktree, request, role, **kwargs):
    return explorer.records(worktree, RecordsRequest(**request.model_dump(), role=role.id, **kwargs))


def test_topology_totals_and_records_do_not_depend_on_page(services, tmp_path):
    explorer, worktree, request, stage = investigate(
        services, tmp_path, "SELECT SUM(value) AS total FROM {{ source }}"
    )
    role = next(r for r in stage.roles if r.kind == "value")
    assert role.occurrences == role.participations == 9
    assert stage.evidence["examined_rows"] == stage.evidence["retained_rows"] == 9
    assert stage.coverage.step == "step_explained"
    assert stage.coverage.upstream == "sources_reached"
    first = records(explorer, worktree, request, role, limit=5)
    second = records(explorer, worktree, request, role, limit=5, offset=5)
    assert first.total == second.total == 9
    assert len(first.records) == 5 and len(second.records) == 4
    assert first.records[1].value == first.records[2].value == 20
    assert first.records[1].cell.row != first.records[2].cell.row
    assert first.records[1].values == [2, "A", 20, "X"]
    assert explorer.stage(worktree, request) == stage


def test_self_join_roles_and_repeated_participation(services, tmp_path):
    explorer, worktree, request, stage = investigate(
        services,
        tmp_path,
        "SELECT SUM(a.value + b.value) AS total FROM {{ source }} a JOIN {{ source }} b ON a.grp=b.grp WHERE a.grp='A'",
    )
    roles = [r for r in stage.roles if r.kind == "value"]
    assert [r.alias for r in roles] == ["a", "b"]
    assert [r.side for r in roles] == ["left", "right"]
    assert roles[0].dataset == roles[1].dataset and roles[0].id != roles[1].id
    assert all(r.occurrences == 3 and r.participations == 9 for r in roles)
    assert all(r.participations == 3 for r in records(explorer, worktree, request, roles[0]).records)


def test_unmatched_join_and_existence_are_not_value_terms(services, tmp_path):
    _, _, _, stage = investigate(
        services,
        tmp_path,
        "SELECT a.id, b.value AS total FROM {{ source }} a LEFT JOIN {{ source }} b ON a.id=b.id+100 ORDER BY a.id",
    )
    assert stage.value is None
    value = next(r for r in stage.roles if r.kind == "value")
    assert value.alias == "b" and value.coverage == "no_matching_row"
    assert any(r.alias == "a" and r.kind == "existence" and r.occurrences == 1 for r in stage.roles)
    assert any(r.kind == "condition" for r in stage.roles)


def test_scalar_calculations_and_unselected_branch(services, tmp_path):
    _, _, _, stage = investigate(
        services,
        tmp_path,
        "SELECT CASE WHEN id=1 THEN value*2 ELSE id+3 END AS total FROM {{ source }} ORDER BY id",
    )
    assert stage.value == 20
    assert any(e["value"] == 20 and "*" in e["expression"] for e in stage.evidence["calculations"])
    assert (
        next(r for r in stage.roles if r.kind == "value" and r.column == "id").coverage
        == "branch_not_selected"
    )
    assert next(r for r in stage.roles if r.kind == "condition" and r.column == "id").occurrences == 1


@pytest.mark.parametrize(
    "query,expected",
    [
        ("SELECT MAX(value) AS total FROM {{ source }} WHERE grp='A'", 2),
        ("SELECT MAX(value) OVER (PARTITION BY grp) AS total FROM {{ source }} ORDER BY id", 2),
        ("SELECT COUNT(DISTINCT category) AS total FROM {{ source }} WHERE grp='A'", 3),
        ("SELECT COUNT(DISTINCT category) OVER (PARTITION BY grp) AS total FROM {{ source }} ORDER BY id", 3),
    ],
)
def test_extrema_distinct_and_window_evidence(services, tmp_path, query, expected):
    explorer, worktree, request, stage = investigate(services, tmp_path, query)
    role = next(r for r in stage.roles if r.kind == "value")
    assert role.occurrences == expected
    if stage.evidence.get("distinct"):
        groups = records(explorer, worktree, request, role)
        assert groups.total == 2 and groups.groups[0]["rows"] == 2
        originals = records(explorer, worktree, request, role, group=groups.groups[0]["key"])
        assert originals.total == 2
        assert [r.cell.row for r in originals.records] == [0, 1]
    if stage.kind == "window":
        assert stage.evidence["partition"]
        assert "frame" in stage.evidence
    elif not stage.evidence.get("distinct"):
        assert stage.evidence["examined_rows"] == 3 and stage.evidence["retained_rows"] == 2


def test_null_inputs_and_group_keys(services, tmp_path):
    explorer, worktree, request, stage = investigate(
        services,
        tmp_path,
        "WITH adjusted AS (SELECT grp, nullif(value, 20) AS value FROM {{ source }}) SELECT grp, COUNT(value) AS total FROM adjusted GROUP BY grp ORDER BY grp",
    )
    assert stage.value == 1
    assert stage.evidence["group_values"] == ["A"]
    assert stage.evidence["examined_rows"] == 3 and stage.evidence["retained_rows"] == 1
    assert stage.coverage.upstream == "upstream_not_explored"
    role = next(r for r in stage.roles if r.kind == "value")
    row = records(explorer, worktree, request, role).records[0]
    upstream = explorer.stage(worktree, request.model_copy(update={"cell": row.cell}))
    assert upstream.coverage.step == "step_explained"
    # Inspecting one row never upgrades a whole relation's coverage.
    assert explorer.stage(worktree, request).coverage.upstream == "upstream_not_explored"


def test_unsupported_is_not_empty_or_source_termination(services, tmp_path):
    _, _, _, stage = investigate(
        services, tmp_path, "SELECT value AS total FROM {{ source }} UNION ALL SELECT value FROM {{ source }}"
    )
    assert stage.coverage.step == "unsupported_operation"
    assert stage.coverage.upstream == "upstream_not_explored"
    assert stage.coverage.warnings and not stage.roles


def test_cached_plan_revalidates_generation_and_never_reopens_source(services, tmp_path):
    explorer, worktree, request, stage = investigate(
        services, tmp_path, "SELECT SUM(value) AS total FROM {{ source }}"
    )
    (tmp_path / "input.csv").unlink()
    role = next(r for r in stage.roles if r.kind == "value")
    assert len(records(explorer, worktree, request, role).records) == 9
    data = services[3].context(worktree, "dev").datasets[request.cell.dataset]
    data.status = "stale"
    with pytest.raises(Problem, match="recalculation"):
        explorer.stage(worktree, request)
    with pytest.raises(Problem, match="recalculation"):
        records(explorer, worktree, request, role)


def test_cancel_only_the_named_request_and_handle_cancel_before_start(services, tmp_path):
    explorer, worktree, request, _ = investigate(
        services, tmp_path, "SELECT SUM(value) AS total FROM {{ source }}"
    )
    explorer.cancel(worktree, CancelRequest(request_id="cancelled"))
    with pytest.raises(Problem, match="cancelled"):
        explorer.stage(worktree, request.model_copy(update={"request_id": "cancelled"}))
    started, released = threading.Event(), threading.Event()

    def pending():
        with explorer.reader(worktree, request):
            started.set()
            assert released.wait(5)

    with ThreadPoolExecutor() as pool:
        task = pool.submit(pending)
        assert started.wait(5)
        explorer.cancel(worktree, CancelRequest(request_id="test"))
        independent = explorer.stage(worktree, request.model_copy(update={"request_id": "independent"}))
        assert independent.value == 380
        released.set()
        with pytest.raises(Problem, match="cancelled"):
            task.result(5)
    assert services[3].preview(worktree, "dev", "query")["status"] == "valid"


def test_api_auth_validation_and_request_bounds(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert client.post("/api/worktrees/missing/lineage/stage", json={}).status_code == 401
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        cell = dict(dataset="data_example", execution="run_example", row=0, column="amount")
        body = dict(root=cell, cell=cell, request_id="request", role="role", limit=101)
        assert client.post("/api/worktrees/missing/lineage/records", json=body).status_code == 422
        body["limit"] = 25
        assert client.post("/api/worktrees/missing/lineage/records", json=body).status_code == 409


def test_inactive_branch_does_not_evaluate_failing_cast(services, tmp_path):
    _, _, _, stage = investigate(
        services,
        tmp_path,
        "SELECT CASE WHEN id=1 THEN value ELSE CAST(category AS INTEGER) END AS total FROM {{ source }} WHERE id=1",
    )
    assert stage.coverage.step == "step_explained"
    assert stage.value == 10
    assert not any(
        "CAST" in e["expression"] and not e["expression"].startswith("CASE")
        for e in stage.evidence["calculations"]
    )


def test_selected_branch_with_missing_join_input_is_not_inactive(services, tmp_path):
    _, _, _, stage = investigate(
        services,
        tmp_path,
        "SELECT CASE WHEN a.id=1 THEN b.value ELSE a.value END AS total FROM {{ source }} a LEFT JOIN {{ source }} b ON a.id=b.id+100 ORDER BY a.id",
    )
    assert stage.coverage.step == "step_explained"
    assert next(r for r in stage.roles if r.kind == "value" and r.alias == "b").coverage == "no_matching_row"
    assert stage.evidence["join_pairs"]["rows"] == [[0, None]]


@pytest.mark.parametrize(
    "query",
    [
        "SELECT COUNT(*) AS total FROM {{ source }}",
        "SELECT COUNT(*) OVER (PARTITION BY grp) AS total FROM {{ source }} ORDER BY id",
        "SELECT ROW_NUMBER() OVER (PARTITION BY grp ORDER BY id) AS total FROM {{ source }} ORDER BY id",
    ],
)
def test_row_counts_and_ranking_do_not_invent_numeric_operands(services, tmp_path, query):
    _, _, _, stage = investigate(services, tmp_path, query)
    assert stage.coverage.step == "step_explained"
    assert not any(r.kind == "value" for r in stage.roles)
    assert any(r.kind == "existence" for r in stage.roles)


def test_external_relations_inside_intermediates_are_never_reopened(services, tmp_path):
    from duckpad.engine import Dataset
    from duckpad.lineage import Coverage, TraceQuery

    engine = services[3]
    context = engine.context("test", "dev")
    source = tmp_path / "external.csv"
    source.write_text("id\n1\n")
    dataset = Dataset(
        "example",
        "query",
        "result",
        "example",
        [],
        1,
        "execution",
        f"WITH external AS (SELECT * FROM read_csv('{source}')) SELECT * FROM external",
        {},
        {},
        "fingerprint",
    )
    source.unlink()
    cursor = context.db.cursor()
    try:
        with pytest.raises(Coverage, match="never reopened"):
            TraceQuery(context, cursor, dataset, 0, detailed=True).normalize(dataset)
    finally:
        cursor.close()


def test_request_budget_interrupts_sql_without_invalidating_preview(services, tmp_path, monkeypatch):
    import time

    import duckpad.lineage_explorer as module

    explorer, worktree, request, _ = investigate(
        services, tmp_path, "SELECT SUM(value) AS total FROM {{ source }}"
    )
    monkeypatch.setattr(module, "TIMEOUT", 0.05)
    started = time.monotonic()
    with pytest.raises(Problem) as error, explorer.reader(worktree, request) as (_, cursor, _):
        cursor.execute("SELECT SUM(i) FROM range(10000000000) input(i)").fetchone()
    assert error.value.status == 408
    assert time.monotonic() - started < 3
    assert services[3].preview(worktree, "dev", "query")["status"] == "valid"


def test_cancelled_discovery_does_not_cache_an_unsupported_boundary(services, tmp_path, monkeypatch):
    import duckdb

    from duckpad.lineage import TraceQuery

    explorer, worktree, request, _ = investigate(
        services, tmp_path, "SELECT SUM(value) AS total FROM {{ source }}"
    )
    explorer.cache.clear()
    trace = TraceQuery.trace

    def interrupted(*args, **kwargs):
        explorer.cancel(worktree, CancelRequest(request_id=request.request_id))
        raise duckdb.InterruptException("Interrupted")

    monkeypatch.setattr(TraceQuery, "trace", interrupted)
    with pytest.raises(Problem, match="cancelled"):
        explorer.stage(worktree, request)
    assert not explorer.cache
    monkeypatch.setattr(TraceQuery, "trace", trace)
    retried = explorer.stage(worktree, request.model_copy(update={"request_id": "retry"}))
    assert retried.coverage.step == "step_explained"
