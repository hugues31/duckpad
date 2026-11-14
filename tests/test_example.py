"""Northstar's chained calculations preserve gross results and trace both sources."""

import pytest
from helpers import wait_run

from duckpad.example import create_example
from duckpad.lineage import Lineage


@pytest.mark.parametrize(("environment", "multiplier"), [("dev", 1), ("prod", 3)])
def test_net_reports_preserve_gross_revenue_and_trace_both_sources(services, environment, multiplier):
    store, projects, catalog, engine = services
    worktree = create_example(projects, catalog)["id"]
    run = wait_run(store, engine.launch(worktree, environment))
    assert run["status"] == "success", run
    assert run["warning_count"] == 1
    warning = next(item for item in run["nodes"]["validated"]["results"] if item.get("status") == "warning")
    assert warning["origin"]["name"] == "large_order_review"
    assert warning["observed"] == 10

    preview = engine.preview(worktree, environment, "report", "report")
    columns = [column["name"] for column in preview["columns"]]
    rows = [dict(zip(columns, row["values"], strict=True)) for row in preview["rows"]]
    assert [row["region"] for row in rows] == ["South", "North", "West", "East"]
    assert [row["revenue"] for row in rows] == [value * multiplier for value in (7131, 6941, 6878, 6767)]
    assert [row["net_share"] for row in rows] == [25.6, 25.1, 25.2, 24.2]
    assert rows[0]["net_revenue"] == pytest.approx(6643.32 * multiplier)
    assert rows[0]["orders"] == 27
    assert [row["revenue_rank"] for row in rows] == [1, 2, 3, 4]

    # Follow one row per dataset/column through both components and both sides of the join.
    # Pagination and repeated contributions are covered by the lineage engine tests.
    lineage = Lineage(engine)
    pending = [(preview["id"], preview["rows"][0]["id"], "net_share")]
    visited, sources, steps = set(), set(), set()
    while pending:
        cell = pending.pop(0)
        key = (cell[0], cell[2])
        if key in visited:
            continue
        visited.add(key)
        result = lineage.explain(worktree, environment, *cell)
        steps.add((result["node"], result["column"]))
        assert result["complete"] and not result["warnings"], result
        if result["kind"] == "source":
            sources.add((result["node"], result["column"]))
        pending.extend((item["dataset"], item["row"], item["column"]) for item in result["contributions"])
    assert sources == {("orders", "amount"), ("fees", "fee_rate")}
    assert {
        ("report::rank", "net_share"),
        ("report::summary::metrics", "net_revenue"),
        ("report::summary::eligible", "net_amount"),
        ("net", "net_amount"),
        ("validated", "amount"),
        ("enriched", "amount"),
    } <= steps


def test_missing_channel_fee_fails_the_join_before_reports_are_exported(services):
    store, projects, catalog, engine = services
    tree = create_example(projects, catalog)
    folder = store.paths.resources(tree["project"]) / "sample" / "dev"
    fees = folder / "channel_fees.csv"
    fees.write_text("channel,fee_rate\nWeb,0.03\nRetail,0.0\n", encoding="utf-8")
    run = wait_run(store, engine.launch(tree["id"], "dev"))
    assert run["status"] == "partial_failure", run
    check = next(
        item for item in run["nodes"]["net"]["results"] if item["origin"].get("name") == "every_order_matched"
    )
    assert check["status"] == "error", check
    assert check["observed"] == 40
    assert run["nodes"]["net"]["status"] == "failed"
    assert run["nodes"]["reach"]["status"] == "success"
    assert not list(store.paths.exports(tree["id"], "dev").glob("*.csv"))
