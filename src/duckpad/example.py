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

1. Read orders from CSV and customers from Parquet.
2. Join customers, keep paid orders and compute two ordered outputs.
3. Reuse one nested report component for all orders and high-value orders.
4. Explain aggregates, distinct customers, extrema, windows and set operations.
5. Export both reports as CSV, named after the reporting month.

## Checks

- Data tests guard the join, order identifiers, amounts, the reporting period and
  each export before it writes. Orders above `review_threshold` raise a warning
  without failing the run: open **Tests** on Paid orders to see the failing rows,
  or the shared **Orders to review** view.
- Execution messages report the orders kept by Paid orders and the leading region
  of each report in the **Log**.
- Select Regional revenue and open **Chart** to see revenue by region, declared
  in `charts.json`.

## Variables

- `high_value_threshold` and `review_threshold` take larger values in prod, where
  source amounts are three times higher, so both environments select the same orders.
- `report_month` is computed from Reporting period at each run, then names the
  exported files, such as `regional-revenue-2026-10.csv`.

Create a branch to experiment; no computation starts automatically.
"""


def write_samples(root):
    """Synthetic orders and customers for each environment; prod amounts are larger."""
    for environment, multiplier in (("dev", 1), ("prod", 3)):
        folder = root / environment
        folder.mkdir(parents=True, exist_ok=True)
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
    templates["regional_metrics"] = """-- @label Regional metrics
-- @input source
-- @output result
SELECT region, SUM(amount) AS revenue, AVG(amount) AS average_order,
       MIN(amount) AS smallest_order, MAX(amount) AS largest_order,
       COUNT(*) AS orders, COUNT(DISTINCT customer_id) AS customers
FROM {{ source }} GROUP BY region;
"""
    templates["rank_regions"] = """-- @label Rank regions
-- @input source
-- @output result
SELECT *, DENSE_RANK() OVER (ORDER BY revenue DESC) AS revenue_rank,
       SUM(revenue) OVER (ORDER BY revenue DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_revenue
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
    nodes = [
        node("orders", "load_csv", "Orders", 30, 80, connection=connection_id, file="orders.csv"),
        node(
            "customers",
            "load_parquet",
            "Customers",
            30,
            290,
            connection=connection_id,
            file="customers.parquet",
        ),
        node(
            "enriched",
            "join",
            "Enrich orders",
            280,
            160,
            condition="l.customer_id = r.customer_id",
            columns="l.*, r.customer_name, r.region, r.segment",
        ),
        node("period", "reporting_period", "Reporting period", 280, 400),
        node(
            "validated",
            "validated_orders",
            "Paid orders",
            530,
            160,
            status="paid",
            review_threshold={"$var": "review_threshold"},
        ),
        {
            "id": "report",
            "component": "regional_report",
            "label": "Regional revenue",
            "params": {"condition": "amount >= 0"},
            "position": {"x": 790, "y": 40},
        },
        {
            "id": "premium",
            "component": "regional_report",
            "label": "High-value orders",
            "params": {"condition": "amount >= {{ var.high_value_threshold }}"},
            "position": {"x": 790, "y": 290},
        },
        node("reach", "channel_sets", "Customer reach", 790, 540),
        node(
            "export",
            "export_report",
            "Export revenue",
            1050,
            40,
            destination="regional-revenue-{{ var.report_month }}.csv",
        ),
        node(
            "export_premium",
            "export_report",
            "Export high-value",
            1050,
            290,
            destination="high-value-orders-{{ var.report_month }}.csv",
        ),
    ]
    edges = [
        edge("orders", "enriched", input_name="left"),
        edge("customers", "enriched", input_name="right"),
        edge("orders", "period"),
        edge("enriched", "validated"),
        edge("validated", "report", "orders", "orders"),
        edge("validated", "premium", "orders", "orders"),
        edge("validated", "reach", "orders"),
        edge("report", "export", "report"),
        edge("premium", "export_premium", "report"),
    ]
    documentation = {
        "project": README,
        "nodes": {
            "orders": "120 synthetic orders; refunds are excluded downstream.",
            "period": "Computes the report_month variable before the rest of the pipeline runs.",
            "enriched": "A data test fails the join if an order has no matching customer.",
            "validated": "Only paid orders contribute to revenue. The overview reads the newly computed orders output. "
            "Tests guard identifiers and amounts; orders above review_threshold raise a warning.",
            "report": "Business definition: gross revenue from paid orders, grouped by customer region.",
            "premium": "Keeps orders of at least high_value_threshold, set per environment.",
        },
        "datasets": {
            "orders:result": "Synthetic transaction ledger; each row represents one order.",
            "period:result": "One row describing the month covered by the orders.",
        },
        "columns": {
            "orders:result": {
                "amount": "Gross order amount in EUR before refunds.",
                "order_id": "Unique order identifier.",
            },
            "period:result": {"month": "Reporting month, as YYYY-MM; names the exported files."},
            "report:report": {
                "revenue": "Sum of qualifying order amounts, in EUR.",
                "customers": "Distinct customers with at least one qualifying order.",
            },
        },
    }
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
                }
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
