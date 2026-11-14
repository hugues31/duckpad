"""On-demand relational witnesses over immutable, materialized execution data.

DuckDB executes value queries unchanged. Explanations are separate SQL queries:
they never reopen a source resource or change result values or cardinalities.
"""

import json
import threading

from sqlglot import exp

from .partition_lineage import PartitionLineage
from .sqlast import explained, sql
from .trace import Coverage, TraceQuery
from .trace.describe import Display, aggregate_operation
from .util import Problem, clean, qi, uid

PAGE_SIZE = 5
INTERRUPTED = "Lineage interrupted by recalculation. Select a cell in the new result."
# Up to this many rows, a page sorts the first records of each branch instead of every record.
BRANCH_ROWS = 100_000


def selected_operand(tracer, operand):
    part = next((part for key, _, part in tracer.operands if key == operand), None)
    if part is None:
        raise Problem("Unknown calculation operand", 422)
    return part


def union(queries):
    return " UNION ALL ".join(queries)


def record(row):
    """A contribution record, in the column order `TraceQuery.contribution` projects."""
    return {
        "dataset": row[0],
        "node": row[1],
        "port": row[2],
        "row": row[3],
        "column": row[4],
        "value": json.loads(row[5]) if row[5] is not None else None,
        "source": row[6],
    }


def page_statements(cells, offset, page_size):
    """The statements reading a page of records, plus one row telling whether more follow,
    and counting every record."""
    offset, page_size = int(offset), int(page_size)
    branches = [sql(branch.query) for branch in cells.branches]
    # A branch holds one column of one relation: its records are ordered by row alone.
    order = "row_id" if len(branches) == 1 else "dataset, row_id, column_name"
    reach = offset + page_size + 1
    records = counted = union(branches)
    if not cells.exact:
        records = f"SELECT DISTINCT * FROM ({records}) contributions"
        # The other columns of a record depend on these three.
        counted = f"SELECT DISTINCT dataset, row_id, column_name FROM ({counted}) contributions"
    elif reach <= BRANCH_ROWS:
        # The first rows of the page order are among the first rows of each branch.
        records = union(
            f"(SELECT * FROM ({branch}) branch ORDER BY row_id LIMIT {reach})" for branch in branches
        )
    return (
        f"SELECT * FROM ({records}) contributions ORDER BY {order} LIMIT {page_size + 1} OFFSET {offset}",
        f"SELECT COUNT(*) FROM ({counted}) counted",
    )


def first_of_each(contributions, limit):
    """The first record of each column in a complete page, as `Lineage.first_inputs` reads them."""
    found = {}
    for item in contributions:
        found.setdefault((item["dataset"], item["column"]), dict(item))
    return list(found.values())[:limit]


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
                trace = tracer.trace(tree, columns.index(column), context_values, operand=operand)
                if operand is not None:
                    trace = selected_operand(tracer, operand)
                contributions, selection, distinct = trace
                response["expression"] = tracer.expression
                response["kind"] = tracer.kind
                # COUNT(DISTINCT ...) pages its distinct values, then the rows of a chosen one.
                grouped = bool(distinct) and not context_values
                chosen = contributions
                if grouped and group is not None:
                    trace = tracer.trace(tree, columns.index(column), False, json.loads(group), operand)
                    if operand is not None:
                        trace = selected_operand(tracer, operand)
                    chosen, selection, _ = trace
                if rows_dataset is not None:
                    data = next((d for d in tracer.sources.values() if d.id == rows_dataset), None)
                    if data is None or not chosen:
                        raise Problem("This dataset does not contribute to the selected value", 422)
                    response = self.rows(cursor, data, chosen, offset, page_size, search)
                else:
                    if summary:
                        response["input_order"] = [
                            {
                                "dataset": tracer.sources[c.table].id,
                                "column": tracer.original_column(tracer.sources[c.table], c.name),
                            }
                            for c in tracer.referenced(tracer.step.columns if tracer.step else [])
                        ]
                    if not grouped:
                        page = self.page(cursor, chosen, offset, page_size)
                    elif group is None:
                        page = self.distinct_groups(cursor, distinct, offset, page_size)
                    else:
                        page = self.page(cursor, chosen, offset, page_size)
                        page["group"] = json.loads(group)
                    if contributions and summary:
                        columns_read = max(1, sum(len(d.columns) for d in tracer.sources.values()))
                        if not grouped and not offset and page["total"] == len(page["contributions"]):
                            response["first_inputs"] = first_of_each(page["contributions"], columns_read)
                        else:
                            response["first_inputs"] = self.first_inputs(cursor, contributions, columns_read)
                    response.update(page)
                    selected = self.page(cursor, selection, 0, page_size)
                    response.update(
                        context_total=selected["total"],
                        context=selected["contributions"],
                        tables=[
                            {
                                "dataset": data.id,
                                "node": data.node,
                                "port": data.port,
                                "columns": data.columns,
                            }
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
                                        else self.page(cursor, part.contributions, 0, PAGE_SIZE)
                                    ),
                                }
                                for key, expression, part in tracer.operands
                            ]
                    response["partition_groups"] = self.partitions.groups(
                        context, cursor, chosen, tracer.sources
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
    def rows(cursor, dataset, cells, offset, page_size, search):
        """Page whole contributing rows, recomputed from witnesses and never stored."""
        projection = ", ".join(qi(dataset.stored(c["name"])) for c in dataset.columns)
        branches = [branch for branch in cells.branches if branch.dataset == dataset.id]
        count = total = 0
        records = []
        if branches:
            identities = union(f"SELECT row_id FROM ({sql(branch.query)}) branch" for branch in branches)
            if len(branches) > 1 or not branches[0].once:
                identities = f"SELECT DISTINCT row_id FROM ({identities}) cells"
            count = total = cursor.execute(f"SELECT count(*) FROM ({identities}) counted").fetchone()[0]
            parameters = []
            if search:
                matching = " OR ".join(
                    f"CAST({qi(dataset.stored(c['name']))} AS VARCHAR) ILIKE ?" for c in dataset.columns
                )
                identities = (
                    f"SELECT rowid AS row_id FROM {qi(dataset.relation)} "
                    f"WHERE rowid IN ({identities}) AND ({matching})"
                )
                parameters = [f"%{search}%"] * len(dataset.columns)
                filtered = f"SELECT count(*) FROM ({identities}) counted"
                total = cursor.execute(filtered, parameters).fetchone()[0]
            # Only identities are sorted to find the page; whole rows are read for that page alone.
            records = cursor.execute(
                f"SELECT rowid, {projection} FROM {qi(dataset.relation)} WHERE rowid IN "
                f"(SELECT row_id FROM ({identities}) selected ORDER BY row_id LIMIT ? OFFSET ?) "
                "ORDER BY rowid",
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
    def first_inputs(cursor, cells, limit):
        """The first record of each contributing column, from the first record of each branch."""
        firsts = union(
            f"(SELECT * FROM ({sql(branch.query)}) branch ORDER BY row_id LIMIT 1)"
            for branch in cells.branches
        )
        rows = cursor.execute(
            f"SELECT * FROM ({firsts}) firsts "
            "QUALIFY row_number() OVER (PARTITION BY dataset, column_name ORDER BY row_id)=1 "
            f"ORDER BY dataset, row_id, column_name LIMIT {limit}"
        ).fetchall()
        return [record(row) for row in rows]

    @staticmethod
    def page(cursor, cells, offset, page_size=PAGE_SIZE):
        """One page of contribution records, each cell once, and their total."""
        if not cells:
            return {"total": 0, "contributions": []}
        offset = max(0, offset)
        page, count = page_statements(cells, offset, page_size)
        rows = cursor.execute(page).fetchall()
        if len(rows) > page_size or (offset and not rows):
            total = cursor.execute(count).fetchone()[0]
        else:
            # The page ends with the last record: counting them all again is not needed.
            total = offset + len(rows)
        return {"total": total, "contributions": [record(row) for row in rows[:page_size]]}
