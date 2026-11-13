"""On-demand relational witnesses over immutable, materialized execution data.

DuckDB executes value queries unchanged. Explanations are separate SQL queries:
they never reopen a source resource or change result values or cardinalities.
"""

import json
import threading

from sqlglot import exp

from .partition_lineage import PartitionLineage
from .sqlast import explained
from .trace import Coverage, TraceQuery
from .trace.describe import Display, aggregate_operation
from .trace.query import render
from .util import Problem, clean, qi, uid

PAGE_SIZE = 5
INTERRUPTED = "Lineage interrupted by recalculation. Select a cell in the new result."


def selected_operand(tracer, operand):
    part = next((part for key, _, part in tracer.operands if key == operand), None)
    if part is None:
        raise Problem("Unknown calculation operand", 422)
    return render(part.contributions), render(part.context), part.distinct


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
        operand=None,
        rows_dataset=None,
        search="",
    ):
        page_size = max(1, min(100, page_size))
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
            "commit": evidence.get("commit"),
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
                # Operand pages and contributing rows only need their own contributions.
                summary = not context_values and operand is None and rows_dataset is None
                contribution_sql, selection_sql, distinct = tracer.trace(
                    tree, columns.index(column), context_values, operand=operand
                )
                if operand is not None:
                    contribution_sql, selection_sql, distinct = selected_operand(tracer, operand)
                response["expression"] = tracer.expression
                response["kind"] = tracer.kind
                if summary:
                    response["input_order"] = [
                        {
                            "dataset": tracer.sources[c.table].id,
                            "column": tracer.original_column(tracer.sources[c.table], c.name),
                        }
                        for c in tracer.referenced(tracer.step.columns if tracer.step else [])
                    ]
                if contribution_sql and summary:
                    first_inputs = (
                        f"SELECT * FROM ({contribution_sql}) c QUALIFY "
                        "row_number() OVER (PARTITION BY dataset, column_name ORDER BY row_id)=1"
                    )
                    response["first_inputs"] = self.page(
                        cursor,
                        first_inputs,
                        0,
                        max(1, sum(len(d.columns) for d in tracer.sources.values())),
                    )["contributions"]
                if distinct and not context_values:
                    if group is None:
                        response.update(self.distinct_groups(cursor, distinct, offset, page_size))
                    else:
                        contribution_sql, selection_sql, _ = tracer.trace(
                            tree, columns.index(column), False, json.loads(group), operand
                        )
                        if operand is not None:
                            contribution_sql, selection_sql, _ = selected_operand(tracer, operand)
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
                if summary:
                    response["calculation"] = tracer.describe(response)
                    if tracer.operands and tracer.step is not None:
                        display = Display(tracer, tracer.step.tree)
                        response["operands"] = [
                            {
                                "id": key,
                                "formula": explained(display(expression)),
                                "value": clean(tracer.operand_values[key]),
                                "aggregate": expression.find(exp.AggFunc, exp.Window) is not None,
                                "operation": aggregate_operation(expression) or "expression",
                                **(
                                    self.distinct_groups(cursor, part.distinct, 0, PAGE_SIZE)
                                    if part.distinct
                                    else self.page(cursor, render(part.contributions), 0, PAGE_SIZE)
                                ),
                            }
                            for key, expression, part in tracer.operands
                        ]
                if rows_dataset is None:
                    response["partition_groups"] = self.partitions.groups(
                        context, cursor, contribution_sql, tracer.sources
                    )
                else:
                    data = next((d for d in tracer.sources.values() if d.id == rows_dataset), None)
                    if data is None or not contribution_sql:
                        raise Problem("This dataset does not contribute to the selected value", 422)
                    response = self.rows(cursor, data, contribution_sql, offset, page_size, search)
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
            if rows_dataset is not None:
                raise Problem(str(error), 422) from error
            return incomplete(response, str(error))
        except Exception as error:
            if canceled.is_set():
                raise Problem(INTERRUPTED, 409) from error
            if isinstance(error, Problem):
                raise
            if rows_dataset is not None:
                raise Problem(f"Contributing rows could not be explained: {error}", 422) from error
            return incomplete(response, f"This SQL step could not be explained: {error}")
        finally:
            # Unregister first: a recalculation interrupts only registered, still open cursors.
            with context.lock:
                context.lineage.pop(request_id, None)
            cursor.close()

    @staticmethod
    def distinct_groups(cursor, distinct, offset, page_size):
        base, value_expression = distinct
        groups_query = f"SELECT to_json(v) AS value, COUNT(*) AS rows FROM (SELECT {value_expression} AS v {base}) q WHERE v IS NOT NULL GROUP BY v"
        total = cursor.execute(f"SELECT count(*) FROM ({groups_query})").fetchone()[0]
        rows = cursor.execute(
            groups_query + f" ORDER BY value LIMIT {page_size} OFFSET ?", [offset]
        ).fetchall()
        return {
            "kind": "distinct_groups",
            "total": total,
            "groups": [{"value": json.loads(v), "rows": count, "key": v} for v, count in rows],
            "contributions": [],
        }

    @staticmethod
    def rows(cursor, dataset, query, offset, page_size, search):
        """Page whole contributing rows, recomputed from witnesses and never stored."""
        projection = ", ".join(qi(dataset.stored(c["name"])) for c in dataset.columns)
        selected = f"rowid IN (SELECT row_id FROM ({query}) c WHERE dataset=?)"
        parameters = [dataset.id]
        count = cursor.execute(
            f"SELECT count(*) FROM {qi(dataset.relation)} WHERE {selected}", parameters
        ).fetchone()[0]
        total = count
        if search:
            selected += (
                " AND ("
                + " OR ".join(
                    f"CAST({qi(dataset.stored(c['name']))} AS VARCHAR) ILIKE ?" for c in dataset.columns
                )
                + ")"
            )
            parameters += [f"%{search}%"] * len(dataset.columns)
            total = cursor.execute(
                f"SELECT count(*) FROM {qi(dataset.relation)} WHERE {selected}", parameters
            ).fetchone()[0]
        records = cursor.execute(
            f"SELECT rowid, {projection} FROM {qi(dataset.relation)} WHERE {selected} ORDER BY rowid LIMIT ? OFFSET ?",
            [*parameters, page_size, max(0, offset)],
        ).fetchall()
        return {
            "id": dataset.id,
            "node": dataset.node,
            "port": dataset.port,
            "status": "valid",
            "columns": dataset.columns,
            "count": count,
            "filtered_count": total,
            "rows": [{"id": row[0], "values": clean(row[1:])} for row in records],
        }

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
