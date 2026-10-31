"""Samples and failing rows of the results panel.

None of them changes a result: they read the retained datasets on bounded cursors.
"""

import pytest
from helpers import join_run

from duckpad.bundle import bundle_to_files
from duckpad.execution import samples
from duckpad.execution.samples import Sample
from duckpad.util import Problem

ORDERS = "id,channel,amount,note\n" + "".join(
    f"{i},{['Web', 'Retail', 'Partner'][i % 3]},{i * 10},{'' if i % 4 == 0 else 'n' + str(i % 5)}\n"
    for i in range(1, 31)
)
CODE = """-- @input source
-- @output result
SELECT * FROM {{ source }};
-- @test large_amount: warning
SELECT * FROM {{ result }} WHERE amount > 250;
-- @test positive: error
SELECT * FROM {{ result }} WHERE amount <= 0;
"""


def bundle(path, code=CODE, variables=None):
    path.write_text(ORDERS)
    value = {
        "flow": {
            "name": "Results",
            "nodes": [
                {"id": "source", "template": "source", "params": {"file": str(path)}},
                {"id": "checked", "params": {}},
            ],
            "edges": [
                {
                    "id": "edge",
                    "source": "source",
                    "sourceHandle": "result",
                    "target": "checked",
                    "targetHandle": "source",
                }
            ],
        },
        "templates": {
            "source": "-- @kind source\n-- @param file: file\n-- @output result\nSELECT * FROM read_csv({{ file }});",
        },
        "node_sql": {"nodes/checked.sql": code},
        "components": {},
        "documentation": {},
    }
    if variables is not None:
        value["variables"] = variables
    return value


@pytest.fixture
def project(services, tmp_path):
    store, projects, _, engine = services
    worktree = projects.create(
        "Results",
        bundle(
            tmp_path / "orders.csv",
            variables={"threshold": {"type": "number", "default": 100, "environments": {"prod": 200}}},
        ),
    )["id"]
    run = join_run(store, engine.launch(worktree, "dev")["id"])
    assert run["status"] == "success", run
    return worktree


def ids(page):
    return [row["values"][0] for row in page["rows"]]


def test_sample_filters_sorts_and_searches_without_changing_the_result(services, project):
    engine = services[3]
    page = engine.preview(
        project,
        "dev",
        "checked",
        sample=Sample(filter="channel = 'Partner' AND amount > 100", order=[["amount", "desc"]]),
    )
    assert ids(page) == [29, 26, 23, 20, 17, 14, 11]
    assert page["matched_count"] == page["filtered_count"] == 7
    assert page["count"] == 30
    # Rows keep their identity in the retained result, so lineage explains them.
    assert [row["id"] for row in page["rows"]][:2] == [28, 25]
    first = engine.preview(project, "dev", "checked", sample=Sample(rows=5, order=[["amount", "desc"]]))
    assert ids(first) == [30, 29, 28, 27, 26]
    assert (first["filtered_count"], first["matched_count"]) == (5, 30)
    paged = engine.preview(project, "dev", "checked", limit=2, offset=2, sample=Sample(rows=5))
    assert ids(paged) == [3, 4]
    search = engine.preview(project, "dev", "checked", sample=Sample(search="RETAIL"))
    assert search["matched_count"] == 10
    multi = engine.preview(
        project, "dev", "checked", sample=Sample(order=[["channel", "asc"], ["amount", "desc"]])
    )
    assert ids(multi)[:3] == [29, 26, 23]
    # The former one-column filter and sort keep working.
    legacy = engine.preview(
        project, "dev", "checked", sort="amount", descending=True, filters={"channel": "web"}
    )
    assert ids(legacy)[:2] == [30, 27]


def test_random_samples_are_reproducible_with_their_seed(services, project):
    engine = services[3]

    def draw(seed):
        page = engine.preview(project, "dev", "checked", sample=Sample(method="random", rows=8, seed=seed))
        assert page["filtered_count"] == 8
        return sorted(ids(page))

    assert draw(7) == draw(7)
    assert any(draw(seed) != draw(7) for seed in (1, 2, 3))
    filtered = engine.preview(
        project, "dev", "checked", sample=Sample(method="random", rows=100, seed=3, filter="amount > 200")
    )
    assert filtered["filtered_count"] == filtered["matched_count"] == 10


def test_sample_filter_variables_are_bound_per_environment(services, project, tmp_path):
    store, _, _, engine = services
    page = engine.preview(project, "dev", "checked", sample=Sample(filter="amount >= {{ var.threshold }}"))
    assert page["matched_count"] == 21
    assert join_run(store, engine.launch(project, "prod")["id"])["status"] == "success"
    page = engine.preview(project, "prod", "checked", sample=Sample(filter="amount >= {{ var.threshold }}"))
    assert page["matched_count"] == 11
    with pytest.raises(Problem, match="not declared"):
        engine.preview(project, "dev", "checked", sample=Sample(filter="amount >= {{ var.missing }}"))
    with pytest.raises(Problem, match="outside quotes"):
        engine.preview(project, "dev", "checked", sample=Sample(filter="note = '{{ var.threshold }}'"))


@pytest.mark.parametrize(
    ("condition", "message"),
    [
        ("SELECT 1", "without a query"),
        ("amount IN (SELECT amount FROM read_csv('/etc/passwd'))", "without a query"),
        ("EXISTS (SELECT 1)", "without a query"),
        ("amount > 1; DROP TABLE x", "one SQL condition"),
        ("missing > 1", "Unknown column"),
        ("t.amount > 1", "Unknown column"),
        ("amount > ?", "without a query"),
        ("amount > $1", "without a query"),
        ("current_setting('threads') > 1", "cannot call"),
        ("amount >", "Invalid sample filter"),
    ],
)
def test_sample_filters_are_one_condition_on_the_dataset(services, project, condition, message):
    with pytest.raises(Problem, match=message):
        services[3].preview(project, "dev", "checked", sample=Sample(filter=condition))


def test_invalid_sample_settings(services, project):
    engine = services[3]
    for sample, message in (
        (Sample(order=[["missing", "asc"]]), "Unknown sort column"),
        (Sample(order=[["amount", "up"]]), "asc or desc"),
        (Sample(order=[["amount", "asc"], ["amount", "desc"]]), "once"),
        (Sample(rows=0), "between 1"),
        (Sample(rows=10_001), "between 1"),
        (Sample(method="last"), "first rows or a random"),
        (Sample(filter="amount > 'x'"), "Cannot read this sample"),
    ):
        with pytest.raises(Problem, match=message):
            engine.preview(project, "dev", "checked", sample=sample)
    # Lambdas and struct fields name their own variables.
    page = engine.preview(
        project, "dev", "checked", sample=Sample(filter="len(list_filter([amount], x -> x > 100)) > 0")
    )
    assert page["matched_count"] == 20


def test_slow_reads_stop_after_the_timeout(services, project, monkeypatch):
    engine = services[3]
    monkeypatch.setattr(samples, "READ_TIMEOUT", 0.2)
    context, dataset = engine.results.find_dataset(project, "dev", "checked")
    with (
        pytest.raises(Problem, match="took more than") as error,
        samples.reading(context, [dataset]) as cursor,
    ):
        cursor.execute(
            "SELECT count(*) FROM range(10000000000) a WHERE a.range % 13 = 99999999999"
        ).fetchall()
    assert error.value.status == 422
    assert not context.lineage
    monkeypatch.undo()
    # The next sample reads normally.
    assert engine.preview(project, "dev", "checked", sample=Sample(rows=1))["filtered_count"] == 1


def test_failing_rows_are_recomputed_from_the_retained_result(services, project):
    store, projects, _, engine = services
    recorded = store.get("run", engine.preview(project, "dev", "checked")["run"])
    rows = engine.test_rows(project, "dev", "checked", "large_amount", limit=3)
    assert rows["filtered_count"] == 5
    assert [row["values"][0] for row in rows["rows"]] == [26, 27, 28]
    assert [c["name"] for c in rows["columns"]] == ["id", "channel", "amount", "note"]
    assert rows["severity"] == "warning"
    assert rows["output"] == "result"
    assert engine.test_rows(project, "dev", "checked", "positive")["filtered_count"] == 0
    assert engine.test_rows(project, "dev", "checked", "large_amount", offset=3)["rows"][0]["values"][0] == 29
    with pytest.raises(Problem, match="did not run"):
        engine.test_rows(project, "dev", "checked", "missing")
    # Rows are never stored with the run.
    assert store.get("run", rows["run"]) == recorded
    snapshot = projects.snapshot(project)
    snapshot["bundle"]["node_sql"]["nodes/checked.sql"] = CODE.replace("250", "260")
    projects.write(project, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    with pytest.raises(Problem, match="stale") as error:
        engine.test_rows(project, "dev", "checked", "large_amount")
    assert error.value.status == 409
