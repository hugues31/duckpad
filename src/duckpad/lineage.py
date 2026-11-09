"""On-demand relational witnesses over immutable, materialized execution data.

DuckDB executes value queries unchanged. Explanations are separate SQL queries:
they never reopen a source resource or change result values or cardinalities.
"""

import json
import threading

from .partition_lineage import PartitionLineage
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
        self.partitions = PartitionLineage(engine)

    def explain(
        self,
        worktree,
        environment,
        dataset_id,
        row,
        column,
        offset=0,
        group=None,
        context_values=False,
        *,
        page_size=PAGE_SIZE,
        partition_context=None,
    ):
        page_size = max(1, min(PAGE_SIZE, page_size))
        context = self.engine.context(worktree, environment)
        dataset = context.datasets.get(dataset_id)
        if not dataset or (dataset.status != "valid" and not (dataset.historical or dataset.opaque_python)):
            raise Problem(
                "This result generation is unavailable or stale. Recompute and select a new cell.", 409
            )
        columns = [c["name"] for c in dataset.columns]
        if column not in columns:
            raise Problem("Unknown column", 404)
        if dataset.partition or dataset.partition_context:
            _, manifest, entry = self.engine.partitions.selected(worktree, environment, partition_context)
            if dataset.partition and (not entry or entry["key_hash"] != dataset.partition["key_hash"]):
                raise Problem("Partition context does not match this result generation", 409)
            if dataset.partition_context and manifest["id"] != dataset.partition_context["manifest"]:
                raise Problem("Partition manifest does not match this result generation", 409)
        elif partition_context:
            self.engine.partitions.selected(worktree, environment, partition_context)
        self.engine.partitions.authorize(worktree, dataset.node)
        dependencies, visited = set(), set()

        def visit(data):
            if data.id in visited:
                return
            visited.add(data.id)
            dependencies.add(data.node)
            if data.status != "valid" and not (data.historical or data.opaque_python):
                raise Problem("A lineage dependency is stale", 409)
            if data.origins:
                return
            for dependency in data.dependencies.values():
                if dependency not in context.datasets:
                    if data.partition:
                        continue
                    raise Problem("A lineage dependency was replaced", 409)
                visit(context.datasets[dependency])

        database = context.db
        cursor = database.cursor()
        request_id = uid("lineage_")
        canceled = threading.Event()
        with context.lock:
            if (
                dataset.status != "valid" and not (dataset.historical or dataset.opaque_python)
            ) or context.db is not database:
                cursor.close()
                raise Problem("Lineage interrupted by recalculation", 409)
            context.lineage[request_id] = {"cursor": cursor, "canceled": canceled, "nodes": dependencies}
        evidence = self.engine.store.get("run", dataset.run) or {}
        state = evidence.get("nodes", {}).get(dataset.node, {})
        names = set(state.get("variables", {}).values())
        names.update(name for refs in state.get("references", {}).values() for name in refs)
        resolved = {name: value for name, value in evidence.get("variables", {}).items() if name in names}
        response = {
            "variables": resolved,
            "environment": environment,
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
            "page_size": page_size,
        }
        try:
            with context.lock:
                self.partitions.restore_inputs(context, cursor, dataset)
                visit(dataset)
            projection = ", ".join(qi(dataset.stored(c)) for c in columns)
            record = cursor.execute(
                f"SELECT {projection} FROM {qi(dataset.relation)} WHERE rowid=?", [row]
            ).fetchone()
            if record is None:
                raise Problem("Row not found", 404)
            response["value"] = clean(record[columns.index(column)])
            response["sql"] = dataset.query
            response["partition_context"] = partition_context
            origin = self.partitions.origin_response(context, cursor, dataset, row, column, response)
            if origin is not None:
                return origin
            if dataset.opaque_python:
                parents = []
                for identity in dataset.dependencies.values():
                    parent = context.datasets[identity]
                    projection = ", ".join(qi(parent.stored(c["name"])) for c in parent.columns)
                    rows = cursor.execute(
                        f"SELECT rowid, {projection} FROM {qi(parent.relation)} ORDER BY rowid LIMIT ? OFFSET ?",
                        [page_size, offset],
                    ).fetchall()
                    parents.append(
                        {
                            "dataset": parent.id,
                            "node": parent.node,
                            "port": parent.port,
                            "run": parent.run,
                            "count": parent.count,
                            "columns": parent.columns,
                            "rows": [{"row": record[0], "values": clean(record[1:])} for record in rows],
                        }
                    )
                response.update(
                    kind="python",
                    expression="Opaque Python operation",
                    complete=False,
                    warnings=[
                        "Python does not provide an input-cell mapping. Select a cell from the captured parent results to resume SQL lineage."
                    ],
                    parents=parents,
                    total=0,
                    contributions=[],
                    context_total=0,
                    context=[],
                )
                return response
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
                            groups_query + f" ORDER BY value LIMIT {page_size} OFFSET ?", [offset]
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
                        response.update(self.page(cursor, contribution_sql, offset, page_size))
                        response["group"] = json.loads(group)
                else:
                    response.update(self.page(cursor, contribution_sql, offset, page_size))
                selection = (
                    self.page(cursor, selection_sql, 0, page_size)
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
                response["partition_groups"] = self.partitions.groups(
                    context, cursor, contribution_sql, tracer.sources
                )
            self.partitions.annotate(context, response)
            if (
                canceled.is_set()
                or (dataset.status != "valid" and not (dataset.historical or dataset.opaque_python))
                or context.datasets.get(dataset_id) is not dataset
            ):
                raise Problem(INTERRUPTED, 409)
            return response
        except Coverage as error:
            if canceled.is_set() or (
                dataset.status != "valid" and not (dataset.historical or dataset.opaque_python)
            ):
                raise Problem(INTERRUPTED, 409) from error
            return incomplete(response, str(error))
        except Exception as error:
            if canceled.is_set():
                raise Problem(INTERRUPTED, 409) from error
            if isinstance(error, Problem):
                raise
            return incomplete(response, f"This SQL step could not be explained: {error}")
        finally:
            # Unregister first: a recalculation interrupts only registered, still open cursors.
            with context.lock:
                context.lineage.pop(request_id, None)
            cursor.close()

    @staticmethod
    def page(cursor, query, offset, page_size=PAGE_SIZE):
        if not query:
            return {"total": 0, "contributions": []}
        query = f"SELECT DISTINCT * FROM ({query}) contributions"
        total = cursor.execute(f"SELECT COUNT(*) FROM ({query}) counted").fetchone()[0]
        rows = cursor.execute(
            query + f" ORDER BY dataset, row_id, column_name LIMIT {page_size} OFFSET ?", [max(0, offset)]
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
