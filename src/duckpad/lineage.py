"""On-demand relational witnesses over immutable, materialized execution data.

DuckDB executes value queries unchanged. Explanations are separate SQL queries:
they never reopen a source resource or change result values or cardinalities.
"""

import json
import threading

from .trace import Coverage, TraceQuery
from .util import Problem, clean, qi, uid

PAGE_SIZE = 5
INTERRUPTED = "Lineage interrupted by recalculation. Select a cell in the new result."


def incomplete(response, warning):
    """An explanation that states its limitation instead of presenting partial results as complete."""
    response.update(
        complete=False, warnings=[warning], contributions=[], total=0, context=[], context_total=0
    )
    return response


class Lineage:
    def __init__(self, engine):
        self.engine = engine

    def explain(
        self, worktree, environment, dataset_id, row, column, offset=0, group=None, context_values=False
    ):
        context = self.engine.context(worktree, environment)
        dataset = context.datasets.get(dataset_id)
        if not dataset or dataset.status != "valid":
            raise Problem(
                "This result generation is unavailable or stale. Recompute and select a new cell.", 409
            )
        columns = [c["name"] for c in dataset.columns]
        if column not in columns:
            raise Problem("Unknown column", 404)
        dependencies, visited = set(), set()

        def visit(data):
            if data.id in visited:
                return
            visited.add(data.id)
            dependencies.add(data.node)
            if data.status != "valid":
                raise Problem("A lineage dependency is stale", 409)
            for dependency in data.dependencies.values():
                if dependency not in context.datasets:
                    raise Problem("A lineage dependency was replaced", 409)
                visit(context.datasets[dependency])

        visit(dataset)
        cursor = context.db.cursor()
        request_id = uid("lineage_")
        canceled = threading.Event()
        with context.lock:
            if dataset.status != "valid":
                cursor.close()
                raise Problem("Lineage interrupted by recalculation", 409)
            context.lineage[request_id] = {"cursor": cursor, "canceled": canceled, "nodes": dependencies}
        response = {
            "request": request_id,
            "dataset": dataset_id,
            "execution": dataset.run,
            "node": dataset.node,
            "port": dataset.port,
            "row": row,
            "column": column,
            "complete": True,
            "warnings": [],
            "offset": offset,
            "page_size": PAGE_SIZE,
        }
        try:
            projection = ", ".join(qi(dataset.stored(c)) for c in columns)
            record = cursor.execute(
                f"SELECT {projection} FROM {qi(dataset.relation)} WHERE rowid=?", [row]
            ).fetchone()
            if record is None:
                raise Problem("Row not found", 404)
            response["value"] = clean(record[columns.index(column)])
            response["sql"] = dataset.query
            if dataset.source:
                response.update(
                    kind="source",
                    expression=column,
                    total=1,
                    contributions=[
                        {
                            "dataset": dataset.id,
                            "node": dataset.node,
                            "port": dataset.port,
                            "row": row,
                            "column": column,
                            "value": response["value"],
                            "source": True,
                        }
                    ],
                    context_total=0,
                    context=[],
                )
            else:
                tracer = TraceQuery(context, cursor, dataset, row)
                tree = tracer.normalize(dataset)
                contribution_sql, selection_sql, distinct = tracer.trace(
                    tree, columns.index(column), context_values
                )
                response["expression"] = tracer.expression
                response["kind"] = tracer.kind
                if distinct and not context_values:
                    base, value_expression = distinct
                    if group is None:
                        groups_query = f"SELECT to_json(v) AS value, COUNT(*) AS rows FROM (SELECT {value_expression} AS v {base}) q WHERE v IS NOT NULL GROUP BY v"
                        total = cursor.execute(f"SELECT count(*) FROM ({groups_query})").fetchone()[0]
                        rows = cursor.execute(
                            groups_query + f" ORDER BY value LIMIT {PAGE_SIZE} OFFSET ?", [offset]
                        ).fetchall()
                        response.update(
                            kind="distinct_groups",
                            total=total,
                            groups=[{"value": json.loads(v), "rows": count, "key": v} for v, count in rows],
                            contributions=[],
                        )
                    else:
                        contribution_sql, selection_sql, _ = tracer.trace(
                            tree, columns.index(column), False, json.loads(group)
                        )
                        response.update(self.page(cursor, contribution_sql, offset))
                        response["group"] = json.loads(group)
                else:
                    response.update(self.page(cursor, contribution_sql, offset))
                selection = (
                    self.page(cursor, selection_sql, 0)
                    if selection_sql
                    else {"total": 0, "contributions": []}
                )
                response.update(
                    context_total=selection["total"],
                    context=selection["contributions"],
                    tables=[
                        {"dataset": data.id, "node": data.node, "port": data.port, "columns": data.columns}
                        for data in tracer.sources.values()
                    ],
                )
                if not context_values:
                    response["calculation"] = tracer.describe(response)
            if (
                canceled.is_set()
                or dataset.status != "valid"
                or context.datasets.get(dataset_id) is not dataset
            ):
                raise Problem(INTERRUPTED, 409)
            return response
        except Coverage as error:
            if canceled.is_set() or dataset.status != "valid":
                raise Problem(INTERRUPTED, 409) from error
            return incomplete(response, str(error))
        except Exception as error:
            if canceled.is_set():
                raise Problem(INTERRUPTED, 409) from error
            if isinstance(error, Problem):
                raise
            return incomplete(response, f"This SQL step could not be explained: {error}")
        finally:
            cursor.close()
            with context.lock:
                context.lineage.pop(request_id, None)

    @staticmethod
    def page(cursor, query, offset):
        if not query:
            return {"total": 0, "contributions": []}
        query = f"SELECT DISTINCT * FROM ({query}) contributions"
        total = cursor.execute(f"SELECT COUNT(*) FROM ({query}) counted").fetchone()[0]
        rows = cursor.execute(
            query + f" ORDER BY dataset, row_id, column_name LIMIT {PAGE_SIZE} OFFSET ?", [max(0, offset)]
        ).fetchall()
        return {
            "total": total,
            "contributions": [
                {
                    "dataset": r[0],
                    "node": r[1],
                    "port": r[2],
                    "row": r[3],
                    "column": r[4],
                    "value": json.loads(r[5]) if r[5] is not None else None,
                    "source": r[6],
                }
                for r in rows
            ],
        }
