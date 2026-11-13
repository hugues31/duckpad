"""Static table dependencies include component boundaries and computed variables."""

from duckpad.example import create_example
from duckpad.table_lineage import describe


def test_northstar_table_lineage_without_any_run(services):
    _store, projects, catalog, _engine = services
    tree = create_example(projects, catalog)
    bundle = projects.snapshot(tree["id"])["bundle"]
    origin = describe(bundle, "report", "report")
    assert origin["seeds"] == ["report::rank"]
    assert {key for key, value in origin["nodes"].items() if value["source"]} == {
        "orders",
        "customers",
        "fees",
    }
    assert "report::summary::metrics" in origin["nodes"]
    assert "report::summary::eligible" in origin["nodes"]
    internal = describe(bundle, "report::summary::metrics")
    assert "orders" in internal["nodes"]
    export = describe(bundle, "export")
    assert any(
        v["name"] == "report_month" and v["node"] == "period" for v in export["nodes"]["export"]["variables"]
    )
    # A component output impacts what reads it, not the inner nodes feeding it.
    assert set(describe(bundle, "report", "report", "impact")["nodes"]) == {"report::rank", "export"}
    impact = describe(bundle, "period", direction="impact")
    assert impact["nodes"]["export"]["export"]
    assert "orders" not in impact["nodes"]
