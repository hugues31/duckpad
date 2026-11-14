"""A reproducible, fully local example spanning the major pipeline features."""

import csv
import shutil

import duckdb

from .builtin_templates import BUILTINS
from .node_code import code_path
from .types import Record
from .util import literal, uid

README = """# Northstar · Revenue operations

A complete example of a documented, tested and reusable sales pipeline.

1. Read orders and channel fees from CSV and customers from Parquet.
2. Join customers, keep paid orders and compute two ordered outputs.
3. Deduct each channel's fee in Net amounts, then reuse one nested report component
   for all orders and high-value orders.
4. Follow net_share through the report's ranking, Regional summary's net_revenue
   aggregate and Net amounts, branching to Orders.amount and Channel fees.fee_rate.
   Also explain distinct customers, extrema, windows and set operations.
5. Export both reports as CSV, named after the reporting month.

## Checks

- Data tests guard both joins, order identifiers, amounts, the reporting period and
  each export before it writes. Orders above `review_threshold` raise a warning
  without failing the run: open **Tests** on Paid orders to see the failing rows,
  or the shared **Orders to review** view.
- Execution messages report the orders kept by Paid orders and the leading region
  of each report in the **Log**.
- Select Regional revenue or Export revenue and open **Chart** to see revenue by
  region, then what channel fees cost each region. Both are declared in `charts.json`.

## Variables

- `high_value_threshold` and `review_threshold` take larger values in prod, where
  source amounts are three times higher, so both environments select the same orders.
- Channel fees are the same in both environments: Web 3%, Retail 0%, Partner 15%.
- `report_month` is computed from Reporting period at each run, then names the
  exported files, such as `regional-revenue-2026-10.csv`.

Create a branch to experiment; no computation starts automatically.
"""


def write_samples(root):
    """Synthetic orders, customers and channel fees; prod order amounts are larger."""
    for environment, multiplier in (("dev", 1), ("prod", 3)):
        folder = root / environment
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / "channel_fees.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            writer.writerows([("channel", "fee_rate"), ("Web", 0.03), ("Retail", 0.0), ("Partner", 0.15)])
        with (folder / "orders.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            writer.writerow(["order_id", "customer_id", "order_date", "amount", "status", "channel"])
            for index in range(1, 121):
                writer.writerow(
                    [
                        index,
                        (index - 1) % 12 + 1,
                        f"2026-10-{(index - 1) % 24 + 1:02d}",
                        round((25 + (index * 37) % 475) * multiplier, 2),
                        "refunded" if index % 9 == 0 else "paid",
                        ["Web", "Retail", "Partner"][index % 3],
                    ]
                )
        db = duckdb.connect()
        try:
            db.execute(
                "CREATE TABLE customers (customer_id INTEGER, customer_name VARCHAR, region VARCHAR, segment VARCHAR)"
            )
            db.executemany(
                "INSERT INTO customers VALUES (?,?,?,?)",
                [
                    (
                        i,
                        name,
                        ["North", "South", "East", "West"][(i - 1) % 4],
                        "Business" if i % 3 == 0 else "Consumer",
                    )
                    for i, name in enumerate(
                        [
                            "Juniper Studio",
                            "Atlas Bikes",
                            "Cedar & Co",
                            "Northwind Labs",
                            "Lumen Books",
                            "Harbor Supply",
                            "Willow Market",
                            "Fieldwork",
                            "Paper Plane",
                            "Summit Goods",
                            "Olive Workshop",
                            "Bluebird Design",
                        ],
                        1,
                    )
                ],
            )
            db.execute(f"COPY customers TO {literal(str(folder / 'customers.parquet'))} (FORMAT PARQUET)")
        finally:
            db.close()


def create_example(projects, catalog, name=None, record=None):
    """Create a project with its own sample data and connection; record joins its transaction."""
    project_id = uid("project_")
    connection_id = "sample_" + project_id
    root = projects.store.paths.resources(project_id) / "sample"
    connection = catalog.check(
        "connection",
        {
            "id": connection_id,
            "name": "Northstar sample data",
            "connector": "folder",
            "environments": {env: {"root": str(root / env)} for env in ("dev", "prod")},
        },
        create=True,
    )
    templates = BUILTINS.copy()
    templates["validated_orders"] = """-- @label Validated orders
-- @description Keep paid orders, check them and publish a summary from the same execution.
-- @input source
-- @param status: text = "paid"
-- @param review_threshold: number = 450
-- @output orders
SELECT * FROM {{ source }} WHERE status = {{ status }};
-- @output overview
SELECT COUNT(*) AS order_count, SUM(amount) AS revenue, COUNT(DISTINCT customer_id) AS customers FROM {{ orders }};
-- @test order_id_unique
SELECT order_id FROM {{ orders }} GROUP BY order_id HAVING COUNT(*) > 1;
-- @test amount_positive
SELECT * FROM {{ orders }} WHERE amount IS NULL OR amount <= 0;
-- @test large_order_review: warning
SELECT * FROM {{ orders }} WHERE amount > {{ review_threshold }};
-- @message
SELECT 'info' AS level,
       COUNT(*) || ' ' || {{ status }} || ' orders kept, ' || ((SELECT COUNT(*) FROM {{ source }}) - COUNT(*)) || ' excluded' AS message
FROM {{ orders }};
"""
    templates["reporting_period"] = """-- @label Reporting period
-- @description The month covered by the orders. The report_month variable reads it to name the exported reports.
-- @input source
-- @output result
SELECT strftime(MIN(order_date), '%Y-%m') AS month, MIN(order_date) AS first_order,
       MAX(order_date) AS last_order, COUNT(*) AS orders
FROM {{ source }};
-- @test single_month
SELECT * FROM {{ result }} WHERE strftime(last_order, '%Y-%m') <> month;
"""
    templates["net_amounts"] = """-- @label Net amounts
-- @description Deduct the sales channel fee from each order.
-- @input orders
-- @input fees
-- @output result
SELECT o.*, ROUND(o.amount * (1 - f.fee_rate), 2) AS net_amount
FROM {{ orders }} AS o JOIN {{ fees }} AS f ON o.channel = f.channel;
-- @test every_order_matched
SELECT o.* FROM {{ orders }} AS o ANTI JOIN {{ fees }} AS f ON o.channel = f.channel;
"""
    templates["regional_metrics"] = """-- @label Regional metrics
-- @input source
-- @output result
SELECT region, SUM(amount) AS revenue, AVG(amount) AS average_order,
       MIN(amount) AS smallest_order, MAX(amount) AS largest_order,
       COUNT(*) AS orders, COUNT(DISTINCT customer_id) AS customers,
       SUM(net_amount) AS net_revenue
FROM {{ source }} GROUP BY region;
"""
    templates["rank_regions"] = """-- @label Rank regions
-- @input source
-- @output result
SELECT *, DENSE_RANK() OVER (ORDER BY revenue DESC) AS revenue_rank,
       SUM(revenue) OVER (ORDER BY revenue DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_revenue,
       ROUND(100 * net_revenue / SUM(net_revenue) OVER (), 1) AS net_share
FROM {{ source }} ORDER BY revenue DESC;
-- @message
SELECT 'info' AS level,
       region || ' leads with ' || ROUND(100 * revenue / (SELECT SUM(revenue) FROM {{ result }}), 1) || '% of revenue' AS message
FROM {{ result }} WHERE revenue_rank = 1;
"""
    templates["channel_sets"] = """-- @label Customer reach
-- @description Distinct customer coverage, overlap and exclusive channels.
-- @input source
-- @output web
SELECT DISTINCT customer_id FROM {{ source }} WHERE channel = 'Web';
-- @output all_customers
SELECT customer_id FROM {{ source }} WHERE channel = 'Web'
UNION SELECT customer_id FROM {{ source }} WHERE channel = 'Retail';
-- @output shared_customers
SELECT customer_id FROM {{ source }} WHERE channel = 'Web'
INTERSECT SELECT customer_id FROM {{ source }} WHERE amount > 200;
-- @output exclusive_customers
SELECT customer_id FROM {{ source }} WHERE channel = 'Web'
EXCEPT SELECT customer_id FROM {{ source }} WHERE amount > 400;
"""
    templates["export_report"] = """-- @label Export report
-- @description Write a report as CSV, after checking that it has rows.
-- @input source
-- @param connection: connection = ""
-- @param destination: destination(connection) = "report.csv"
COPY {{ source }} TO {{ destination }} (FORMAT CSV, HEADER TRUE);
-- @test report_not_empty
SELECT 'The report has no rows' AS problem FROM {{ source }} HAVING COUNT(*) = 0;
"""

    def node(key, template, label, x, y, **params):
        return {
            "id": key,
            "template": template,
            "label": label,
            "position": {"x": x, "y": y},
            "params": params,
        }

    def edge(source, target, output="result", input_name="source"):
        return {
            "id": f"{source}_{output}_{target}_{input_name}",
            "source": source,
            "target": target,
            "sourceHandle": output,
            "targetHandle": input_name,
        }

    metrics = {
        "id": "regional_summary",
        "name": "Regional summary",
        "description": "Apply a minimum order value and summarize every region. Shared by all local instances.",
        "nodes": [
            node("eligible", "filter", "Eligible orders", 100, 120, condition="amount >= 0"),
            node("metrics", "regional_metrics", "Revenue by region", 400, 120),
        ],
        "edges": [edge("eligible", "metrics")],
        "inputs": {"orders": {"node": "eligible", "port": "source"}},
        "outputs": {
            "summary": {"node": "metrics", "port": "result"},
            "orders": {"node": "eligible", "port": "result"},
        },
        "parameters": {
            "condition": {
                "type": "expression",
                "default": "amount >= 0",
                "targets": [{"node": "eligible", "param": "condition"}],
            }
        },
    }
    report = {
        "id": "regional_report",
        "name": "Regional report",
        "description": "A nested component: regional summary followed by ranking and a running total.",
        "nodes": [
            {
                "id": "summary",
                "component": "regional_summary",
                "label": "Regional summary",
                "params": {},
                "position": {"x": 100, "y": 120},
            },
            node("rank", "rank_regions", "Rank regions", 400, 120),
        ],
        "edges": [edge("summary", "rank", "summary")],
        "inputs": {"orders": {"node": "summary", "port": "orders"}},
        "outputs": {
            "report": {"node": "rank", "port": "result"},
            "orders": {"node": "summary", "port": "orders"},
        },
        "parameters": {
            "condition": {
                "type": "expression",
                "default": "amount >= 0",
                "targets": [{"node": "summary", "param": "condition"}],
            }
        },
    }
    # Start with the positions produced by the canvas's automatic layout.
    nodes = [
        node("orders", "load_csv", "Orders", 0, 67, connection=connection_id, file="orders.csv"),
        node("fees", "load_csv", "Channel fees", 0, 527, connection=connection_id, file="channel_fees.csv"),
        node(
            "customers",
            "load_parquet",
            "Customers",
            0,
            297,
            connection=connection_id,
            file="customers.parquet",
        ),
        node(
            "enriched",
            "join",
            "Enrich orders",
            260,
            215,
            condition="l.customer_id = r.customer_id",
            columns="l.*, r.customer_name, r.region, r.segment",
        ),
        node("period", "reporting_period", "Reporting period", 260, 0),
        node(
            "validated",
            "validated_orders",
            "Paid orders",
            520,
            215,
            status="paid",
            review_threshold={"$var": "review_threshold"},
        ),
        node("net", "net_amounts", "Net amounts", 780, 509),
        {
            "id": "report",
            "component": "regional_report",
            "label": "Regional revenue",
            "params": {"condition": "amount >= 0"},
            "position": {"x": 1040, "y": 401},
        },
        {
            "id": "premium",
            "component": "regional_report",
            "label": "High-value orders",
            "params": {"condition": "amount >= {{ var.high_value_threshold }}"},
            "position": {"x": 1040, "y": 616},
        },
        node("reach", "channel_sets", "Customer reach", 780, 203),
        node(
            "export",
            "export_report",
            "Export revenue",
            1300,
            406,
            destination="regional-revenue-{{ var.report_month }}.csv",
        ),
        node(
            "export_premium",
            "export_report",
            "Export high-value",
            1300,
            636,
            destination="high-value-orders-{{ var.report_month }}.csv",
        ),
    ]
    edges = [
        edge("orders", "enriched", input_name="left"),
        edge("customers", "enriched", input_name="right"),
        edge("orders", "period"),
        edge("enriched", "validated"),
        edge("validated", "net", "orders", "orders"),
        edge("fees", "net", input_name="fees"),
        edge("net", "report", input_name="orders"),
        edge("net", "premium", input_name="orders"),
        edge("validated", "reach", "orders"),
        edge("report", "export", "report"),
        edge("premium", "export_premium", "report"),
    ]
    documentation = {
        "project": README,
        "nodes": {
            "orders": "120 synthetic orders; refunds are excluded downstream.",
            "fees": "Sales channel fee rates, identical in dev and prod: Web 3%, Retail 0%, Partner 15%.",
            "net": "Deducts the channel fee from each paid order, rounded to cents. "
            "A data test fails the join if an order has no matching channel fee.",
            "period": "Computes the report_month variable before the rest of the pipeline runs.",
            "enriched": "A data test fails the join if an order has no matching customer.",
            "validated": "Only paid orders contribute to revenue. The overview reads the newly computed orders output. "
            "Tests guard identifiers and amounts; orders above review_threshold raise a warning.",
            "report": "Gross and net revenue from paid orders, grouped by customer region, "
            "with each region's percentage of total net revenue.",
            "premium": "Keeps orders of at least high_value_threshold, set per environment.",
        },
        "datasets": {
            "orders:result": "Synthetic transaction ledger; each row represents one order.",
            "fees:result": "One fee rate per sales channel.",
            "net:result": "Paid orders with net amounts after channel fees; gross amounts are preserved.",
            "period:result": "One row describing the month covered by the orders.",
        },
        "columns": {
            "orders:result": {
                "amount": "Gross order amount in EUR before refunds.",
                "order_id": "Unique order identifier.",
            },
            "period:result": {"month": "Reporting month, as YYYY-MM; names the exported files."},
            "fees:result": {
                "channel": "Sales channel matching Orders.channel.",
                "fee_rate": "Fraction of the gross amount charged as a channel fee (0.03 means 3%).",
            },
            "net:result": {
                "net_amount": "Gross order amount multiplied by (1 - fee_rate), rounded to cents, in EUR.",
            },
            "report:report": {
                "revenue": "Sum of qualifying order amounts, in EUR.",
                "customers": "Distinct customers with at least one qualifying order.",
                "net_revenue": "Sum of qualifying net order amounts after channel fees, in EUR.",
                "net_share": "Percentage of total net revenue for this region, rounded to one decimal place.",
            },
        },
    }
    for instance in ("report", "premium"):
        documentation["columns"][f"{instance}::summary::metrics:result"] = {
            "net_revenue": documentation["columns"]["report:report"]["net_revenue"],
        }
        documentation["columns"][f"{instance}::rank:result"] = {
            key: documentation["columns"]["report:report"][key] for key in ("net_revenue", "net_share")
        }
    documentation["columns"]["premium:report"] = documentation["columns"]["report:report"].copy()
    bundle: Record = {
        "flow": {
            "name": name or "Northstar analytics",
            "description": "From raw orders to explainable revenue",
            "nodes": nodes,
            "edges": edges,
        },
        "templates": templates,
        "components": {"regional_summary": metrics, "regional_report": report},
        "documentation": documentation,
        "variables": {
            "high_value_threshold": {
                "type": "number",
                "description": "Minimum order amount kept by the High-value orders report.",
                "default": 300,
                "environments": {"prod": 900},
            },
            "review_threshold": {
                "type": "number",
                "description": "Paid orders above this amount raise a review warning.",
                "default": 450,
                "environments": {"prod": 1350},
            },
            "report_month": {
                "type": "text",
                "description": "Month covered by the orders, used to name the exported reports.",
                "from": {"node": "period", "column": "month"},
            },
        },
        "views": {
            "validated:orders": [
                {
                    "name": "Orders to review",
                    "method": "first",
                    "filter": "amount > {{ var.review_threshold }}",
                    "order": [["amount", "desc"]],
                }
            ]
        },
        # Charts are keyed by the output that stores the rows: Rank regions inside Regional revenue.
        "charts": {
            "report::rank:result": [
                {
                    "name": "Revenue by region",
                    # Points on an axis that does not start at 0: regional revenues differ by a few percent.
                    "spec": {
                        "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
                        "mark": {"type": "circle", "size": 200, "tooltip": True},
                        "height": 200,
                        "encoding": {
                            "x": {
                                "field": "revenue",
                                "type": "quantitative",
                                "title": "Revenue",
                                "format": ",",
                                "scale": {"zero": False},
                            },
                            "y": {"field": "region", "type": "nominal", "sort": "-x", "title": "Region"},
                            "color": {
                                "field": "region",
                                "type": "nominal",
                                "title": "Region",
                                "legend": None,
                            },
                        },
                    },
                },
                {
                    "name": "Net and gross revenue",
                    # A bar from the net revenue, marked by a point, to the gross one: its length is
                    # what channel fees cost a region. Net revenue ranks the regions differently.
                    "spec": {
                        "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
                        "height": 200,
                        "encoding": {
                            "y": {"field": "region", "type": "nominal", "sort": "-x", "title": "Region"},
                            "color": {
                                "field": "region",
                                "type": "nominal",
                                "title": "Region",
                                "legend": None,
                            },
                            "tooltip": [
                                {"field": "region", "type": "nominal", "title": "Region"},
                                {
                                    "field": "net_revenue",
                                    "type": "quantitative",
                                    "title": "Net revenue",
                                    "format": ",",
                                },
                                {
                                    "field": "revenue",
                                    "type": "quantitative",
                                    "title": "Gross revenue",
                                    "format": ",",
                                },
                            ],
                        },
                        "layer": [
                            {
                                "mark": {"type": "bar", "size": 8, "opacity": 0.4, "cornerRadius": 4},
                                "encoding": {
                                    "x": {
                                        "field": "net_revenue",
                                        "type": "quantitative",
                                        "title": "Net revenue (point) to gross revenue",
                                        "format": ",",
                                        "scale": {"zero": False},
                                    },
                                    "x2": {
                                        "field": "revenue",
                                        "title": "Net revenue (point) to gross revenue",
                                    },
                                },
                            },
                            {
                                "mark": {"type": "circle", "size": 200},
                                # Vega-Lite joins the distinct titles of an axis: every layer states the same one.
                                "encoding": {
                                    "x": {
                                        "field": "net_revenue",
                                        "type": "quantitative",
                                        "title": "Net revenue (point) to gross revenue",
                                    }
                                },
                            },
                        ],
                    },
                },
            ]
        },
    }

    # Demonstrate both local SQL and linked definitions, including code inside a component.
    graphs: list[tuple[Record, str | None, str]] = [
        (bundle["flow"], None, "enriched"),
        (bundle["flow"], None, "period"),
        (bundle["flow"], None, "reach"),
        (bundle["components"]["regional_report"], "regional_report", "rank"),
    ]
    for graph, parent, identity in graphs:
        owned = next(node for node in graph["nodes"] if node["id"] == identity)
        owned["origin"] = owned.pop("template")
        bundle.setdefault("node_sql", {})[code_path(identity, parent)] = templates[owned["origin"]]
    # Node code can add checks to the definition it was copied from.
    bundle["node_sql"][code_path("enriched")] += """-- @test every_order_matched
SELECT l.* FROM {{ left }} AS l ANTI JOIN {{ right }} AS r ON {{ condition }};
"""

    def register(worktree):
        projects.store.put("connection", connection_id, connection)
        if record is not None:
            record(worktree)

    try:
        write_samples(root)
        return projects.create(bundle["flow"]["name"], bundle, project_id=project_id, record=register)
    except Exception:
        # An example that could not be created leaves no sample data behind.
        shutil.rmtree(root.parent, ignore_errors=True)
        raise
