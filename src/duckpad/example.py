"""A reproducible, fully local example spanning the major pipeline features."""

import csv

import duckdb

from .builtin_templates import BUILTINS
from .util import literal


def create_example(projects, catalog, private=False, name=None):
    worktree = projects.create(name or "Northstar analytics") if private else None
    connection_id = "sample_" + worktree["project"] if worktree else "northstar"
    root = projects.store.home / "examples" / "northstar"
    if worktree:
        root = projects.store.home / "resources" / worktree["project"] / "sample"
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
    catalog.save(
        "connection",
        {
            "id": connection_id,
            "name": "Northstar sample data",
            "connector": "local",
            "environments": {env: {"root": str(root / env)} for env in ("dev", "prod")},
        },
    )
    templates = BUILTINS.copy()
    templates["validated_orders"] = """-- @label Validated orders
-- @description Keep paid orders and publish a summary from the same execution.
-- @input source
-- @param status: text = "paid"
-- @output orders
SELECT * FROM {{ source }} WHERE status = {{ status }};
-- @output overview
SELECT COUNT(*) AS order_count, SUM(amount) AS revenue, COUNT(DISTINCT customer_id) AS customers FROM {{ orders }};
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
        node("validated", "validated_orders", "Paid orders", 530, 160, status="paid"),
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
            "params": {"condition": "amount >= 300"},
            "position": {"x": 790, "y": 290},
        },
        node("reach", "channel_sets", "Customer reach", 790, 540),
        node(
            "export",
            "export_csv",
            "Export revenue",
            1050,
            40,
            connection="local",
            destination="regional-revenue.csv",
        ),
        node(
            "export_premium",
            "export_csv",
            "Export high-value",
            1050,
            290,
            connection="local",
            destination="high-value-orders.csv",
        ),
    ]
    edges = [
        edge("orders", "enriched", input_name="left"),
        edge("customers", "enriched", input_name="right"),
        edge("enriched", "validated"),
        edge("validated", "report", "orders", "orders"),
        edge("validated", "premium", "orders", "orders"),
        edge("validated", "reach", "orders"),
        edge("report", "export", "report"),
        edge("premium", "export_premium", "report"),
    ]
    documentation = {
        "project": "# Northstar · Revenue operations\n\nA complete example of a documented, reusable sales pipeline.\n\n1. Read orders from CSV and customers from Parquet.\n2. Join customers, keep paid orders and compute two ordered outputs.\n3. Reuse one nested report component for all orders and high-value orders.\n4. Explain aggregates, distinct customers, extrema, windows and set operations.\n5. Export both reports as CSV. Run again to replace the same files.\n\nSwitch to prod for larger source amounts. Create a branch to experiment; no computation starts automatically.",
        "nodes": {
            "orders": "120 synthetic orders; refunds are excluded downstream.",
            "validated": "Only paid orders contribute to revenue. The overview reads the newly computed orders output.",
            "report": "Business definition: gross revenue from paid orders, grouped by customer region.",
        },
        "datasets": {"orders:result": "Synthetic transaction ledger; each row represents one order."},
        "columns": {
            "orders:result": {
                "amount": "Gross order amount in EUR before refunds.",
                "order_id": "Unique order identifier.",
            },
            "report:report": {
                "revenue": "Sum of qualifying order amounts, in EUR.",
                "customers": "Distinct customers with at least one qualifying order.",
            },
        },
    }
    bundle = {
        "flow": {
            "name": name or "Northstar",
            "description": "From raw orders to explainable revenue",
            "nodes": nodes,
            "edges": edges,
        },
        "templates": templates,
        "components": {"regional_summary": metrics, "regional_report": report},
        "documentation": documentation,
    }
    if worktree:
        from .projects import bundle_to_files

        bundle["flow"]["id"] = worktree["project"]
        snapshot = projects.snapshot(worktree["id"])
        projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
        return worktree
    return projects.create(name or "Northstar · Revenue operations", bundle)
