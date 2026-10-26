"""On-demand relational witnesses over immutable, materialized execution data.

DuckDB executes value queries unchanged. Explanations are separate SQL queries:
they never reopen a source resource or change result values or cardinalities.
"""

import json
import threading
import time

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify

from .engine import Dataset
from .materialize import plan_materialization, publish_view
from .util import Problem, clean, literal, qi, uid


class Coverage(Exception):
    pass


def sql(expression):
    return expression.sql(dialect="duckdb")


def unalias(expression):
    return expression.this if isinstance(expression, exp.Alias) else expression


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
            "row": row,
            "column": column,
            "complete": True,
            "warnings": [],
            "offset": offset,
            "page_size": 5,
        }
        try:
            projection = ", ".join(qi(dataset.column_map.get(c, c)) for c in columns)
            record = cursor.execute(
                f"SELECT {projection} FROM {qi(dataset.storage or dataset.table)} WHERE rowid=?", [row]
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
                    tree, record, columns.index(column), context_values
                )
                response["expression"] = tracer.expression
                response["kind"] = tracer.kind
                if distinct and not context_values:
                    base, value_expression = distinct
                    if group is None:
                        groups_query = f"SELECT to_json(v) AS value, COUNT(*) AS rows FROM (SELECT {value_expression} AS v {base}) q WHERE v IS NOT NULL GROUP BY v"
                        total = cursor.execute(f"SELECT count(*) FROM ({groups_query})").fetchone()[0]
                        rows = cursor.execute(
                            groups_query + " ORDER BY value LIMIT 5 OFFSET ?", [offset]
                        ).fetchall()
                        response.update(
                            kind="distinct_groups",
                            total=total,
                            groups=[{"value": json.loads(v), "rows": count, "key": v} for v, count in rows],
                            contributions=[],
                        )
                    else:
                        contribution_sql, selection_sql, _ = tracer.trace(
                            tree, record, columns.index(column), False, json.loads(group)
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
            if (
                canceled.is_set()
                or dataset.status != "valid"
                or context.datasets.get(dataset_id) is not dataset
            ):
                raise Problem("Lineage interrupted by recalculation. Select a cell in the new result.", 409)
            return response
        except Coverage as error:
            if canceled.is_set() or dataset.status != "valid":
                raise Problem(
                    "Lineage interrupted by recalculation. Select a cell in the new result.", 409
                ) from error
            response.update(
                complete=False, warnings=[str(error)], contributions=[], total=0, context=[], context_total=0
            )
            return response
        except Exception as error:
            if canceled.is_set():
                raise Problem(
                    "Lineage interrupted by recalculation. Select a cell in the new result.", 409
                ) from error
            if isinstance(error, Problem):
                raise
            response.update(
                complete=False,
                warnings=[f"This SQL step could not be explained: {error}"],
                contributions=[],
                total=0,
                context=[],
                context_total=0,
            )
            return response
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
            query + " ORDER BY dataset, row_id, column_name LIMIT 5 OFFSET ?", [max(0, offset)]
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


class TraceQuery:
    def __init__(self, context, cursor, dataset, row, detailed=False):
        self.context, self.cursor, self.dataset = context, cursor, dataset
        self.row = row
        self.sources = {}
        self.expression, self.kind = "", "projection"
        self.detailed = detailed
        self.role_columns = set()
        self.existence = ""
        self.evidence = {}
        self.branch_columns = set()
        self.declarations = {}

    def virtual(self, query, owner, name):
        lock = self.context.trace_lock
        timeout = max(0, self.cursor.deadline - time.monotonic()) if hasattr(self.cursor, "deadline") else -1
        if not lock.acquire(timeout=timeout):
            raise Problem("The investigation exceeded its SQL materialization budget", 408)
        try:
            return self._virtual(query, owner, name)
        finally:
            lock.release()

    def _virtual(self, query, owner, name):
        from .util import digest

        local_ctes = {cte.alias for cte in query.find_all(exp.CTE)}
        if any(
            table.name not in self.context.datasets and table.name not in local_ctes
            for table in query.find_all(exp.Table)
        ):
            raise Coverage(
                "An intermediate relation is not retained execution data. External sources are never reopened for lineage."
            )
        key = "trace_" + digest([owner.id, sql(query), name])[:24]
        if key not in self.context.datasets:
            data_inputs = {
                t.name: self.context.datasets[t.name]
                for t in query.find_all(exp.Table)
                if t.name in self.context.datasets
            }
            statement = {"table": key, "query": sql(query), "bindings": {}}
            plan = plan_materialization(self.cursor, statement, data_inputs)
            self.cursor.execute(plan["sql"])
            columns, mapping, _ = publish_view(self.cursor, key, plan)
            count = self.cursor.execute(f"SELECT count(*) FROM {qi(key)}").fetchone()[0]
            dependencies = {name: data.id for name, data in data_inputs.items()}
            data = Dataset(
                key,
                owner.node,
                name,
                key,
                columns,
                count,
                owner.run,
                sql(query),
                {},
                dependencies,
                owner.fingerprint,
                storage=plan["storage"],
                column_map=mapping,
                witnesses=plan["witnesses"],
                groups=plan["groups"],
            )
            with self.context.lock:
                data.status = owner.status
                self.context.datasets[key] = data
        return self.context.datasets[key]

    def normalize(self, dataset):
        tree = sqlglot.parse_one(dataset.query, read="duckdb")
        if any(
            isinstance(f, (exp.Rand, exp.Uuid, exp.CurrentTimestamp, exp.CurrentDate)) for f in tree.walk()
        ):
            raise Coverage(
                "Volatile expressions have no deterministic replay provenance. The displayed result is unchanged."
            )
        tree = tree.transform(
            lambda e: (
                exp.convert(dataset.bindings[e.name])
                if isinstance(e, exp.Placeholder) and e.name in dataset.bindings
                else e
            )
        )
        cte_map = {}
        with_ = tree.args.get("with_")
        if with_:
            if with_.args.get("recursive"):
                raise Coverage("Recursive CTE lineage is not yet supported.")
            for cte in with_.expressions:
                inner = cte.this.copy().transform(
                    lambda e: (
                        exp.alias_(exp.to_table(cte_map[e.name]), e.alias_or_name, table=True)
                        if isinstance(e, exp.Table) and e.name in cte_map
                        else e
                    )
                )
                data = self.virtual(inner, dataset, cte.alias)
                cte_map[cte.alias] = data.table
            tree.set("with_", None)
            tree = tree.transform(
                lambda e: (
                    exp.alias_(exp.to_table(cte_map[e.name]), e.alias_or_name, table=True)
                    if isinstance(e, exp.Table) and e.name in cte_map
                    else e
                )
            )
        # Materialize derived tables separately, preserving their own explainable query.
        for subquery in list(tree.find_all(exp.Subquery)):
            if isinstance(subquery.parent, (exp.From, exp.Join)):
                data = self.virtual(subquery.this, dataset, subquery.alias_or_name or "subquery")
                subquery.replace(
                    exp.alias_(exp.to_table(data.table), subquery.alias_or_name or data.table, table=True)
                )
        if isinstance(tree, exp.SetOperation):
            return tree
        schema = {}
        for table in tree.find_all(exp.Table):
            data = self.context.datasets.get(table.name)
            if data is None:
                raise Coverage("A SQL relation is not an available materialized dependency.")
            schema[table.name] = {c["name"]: c["type"] for c in data.columns}
        try:
            tree = qualify(tree, dialect="duckdb", schema=schema)
        except Exception as error:
            raise Coverage(f"Column resolution is not supported for this SQL step: {error}") from error
        # SQL evaluates grouped aggregates before windows. Give that stage its
        # own explainable relation instead of replaying a window over raw rows.
        grouped = tree.args.get("group") or any(
            not a.find_ancestor(exp.Window) for a in tree.find_all(exp.AggFunc)
        )
        nested = [
            a
            for a in tree.find_all(exp.AggFunc)
            if a.find_ancestor(exp.Window) and a.find_ancestor(exp.AggFunc)
        ]
        if tree.find(exp.Window) and (grouped or nested):
            keys = tree.args["group"].expressions if tree.args.get("group") else []
            aggregates = [a for a in tree.find_all(exp.AggFunc) if not a.find_ancestor(exp.Window)] + nested
            expressions = {sql(e): e for e in [*keys, *aggregates]}
            names = {key: f"_dp_group_value_{i}" for i, key in enumerate(expressions)}
            inner = tree.copy()
            for key in ("order", "limit", "offset", "distinct", "qualify"):
                inner.set(key, None)
            inner.set("expressions", [e.copy().as_(names[key]) for key, e in expressions.items()])
            data = self.virtual(inner, dataset, "grouped_window_input")
            outer = tree.copy()
            for key in ("group", "having", "where", "joins"):
                outer.set(key, None)
            outer.set("from_", exp.From(this=exp.to_table(data.table)))
            outer = outer.transform(lambda e: exp.column(names[sql(e)]) if sql(e) in names else e)
            return self.normalize(
                Dataset(
                    dataset.id,
                    dataset.node,
                    dataset.port,
                    dataset.table,
                    dataset.columns,
                    dataset.count,
                    dataset.run,
                    sql(outer),
                    {},
                    {data.table: data.id},
                    dataset.fingerprint,
                )
            )
        for table in tree.find_all(exp.Table):
            self.sources[table.alias_or_name] = self.context.datasets[table.name]
        for column in tree.find_all(exp.Column):
            data = self.sources.get(column.table)
            if data and column.name in data.column_map:
                column.set("this", exp.to_identifier(data.column_map[column.name], quoted=True))
        for table in tree.find_all(exp.Table):
            data = self.sources[table.alias_or_name]
            table.set("this", exp.to_identifier(data.storage or data.table, quoted=True))
        return tree

    def matches(self, names, record, alias=""):
        prefix = qi(alias) + "." if alias else ""
        return (
            " AND ".join(
                f"{prefix}{qi(name)} IS NOT DISTINCT FROM {literal(value)}"
                for name, value in zip(names, record, strict=True)
            )
            or "TRUE"
        )

    def trace(self, tree, record, column_index, all_context=False, distinct_value=...):
        if isinstance(tree, exp.SetOperation):
            return self.set_operation(tree, record, column_index)
        if not isinstance(tree, exp.Select):
            raise Coverage("Lineage currently expects SELECT or a set operation at this step.")
        if tree.args.get("qualify"):
            raise Coverage("QUALIFY lineage is not yet supported; use a nested SELECT for this step.")
        if any(j.args.get("kind") in ("SEMI", "ANTI") for j in tree.find_all(exp.Join)):
            raise Coverage(
                "SEMI/ANTI join selection provenance is not yet supported; use an explicit join step."
            )
        if tree.args.get("group") and any(
            tree.args["group"].args.get(k) for k in ("grouping_sets", "cube", "rollup")
        ):
            raise Coverage("Grouping sets, ROLLUP and CUBE provenance is not yet supported.")
        expressions = [unalias(e) for e in tree.expressions]
        target = expressions[column_index]
        self.expression = sql(target)
        output_names = [f"_dp_value_{i}" for i in range(len(expressions))]
        projections = [f"{sql(e)} AS {qi(n)}" for e, n in zip(expressions, output_names, strict=True)]
        matching = self.matches(output_names, record)
        from_query = tree.copy()
        for key in ("group", "having", "order", "limit", "offset", "distinct", "qualify"):
            from_query.set(key, None)
        from_query.set("expressions", [exp.Star()])
        from_clause = sql(from_query)[len("SELECT *") :]
        windows = list(target.find_all(exp.Window))
        aggregates = [a for a in target.find_all(exp.AggFunc) if not a.find_ancestor(exp.Window)]
        has_group = bool(tree.args.get("group")) or any(
            e.find(exp.AggFunc) and not e.find(exp.Window) for e in expressions
        )
        columns = list(target.find_all(exp.Column))
        if not columns and (aggregates or windows):
            columns = [
                exp.column(data.column_map.get(data.columns[0]["name"], data.columns[0]["name"]), table=alias)
                for alias, data in self.sources.items()
                if data.columns
            ]
        conditions = []
        for node in [tree.args.get("where"), *tree.args.get("joins", [])]:
            if node:
                conditions.extend(node.find_all(exp.Column))
        for filtered in target.find_all(exp.Filter):
            selection_columns = list(filtered.expression.find_all(exp.Column))
            columns = [c for c in columns if not any(c is selected for selected in selection_columns)]
            conditions.extend(selection_columns)
        if windows:
            self.kind = "window"
            return self.window(
                tree,
                target,
                record,
                column_index,
                columns,
                conditions,
                projections,
                matching,
                from_clause,
                all_context,
                distinct_value,
            )
        distinct = None
        if has_group:
            self.kind = "aggregate"
            group_exprs = tree.args["group"].expressions if tree.args.get("group") else []
            group_names = [f"_dp_group_{i}" for i in range(len(group_exprs))]
            group_query = tree.copy()
            group_query.set("order", None)
            group_query.set("limit", None)
            group_query.set("offset", None)
            group_query.set(
                "expressions",
                [sqlglot.parse_one(p, read="duckdb") for p in projections]
                + [e.copy().as_(name) for e, name in zip(group_exprs, group_names, strict=True)],
            )
            group_rows = f"SELECT * FROM ({sql(group_query)}) matched_groups WHERE {matching}"
            if group_exprs:
                if self.dataset.groups:
                    fields = list(self.dataset.groups.values())
                    values = self.cursor.execute(
                        f"SELECT {', '.join(qi(f) for f in fields)} FROM {qi(self.dataset.storage)} WHERE rowid=?",
                        [self.row],
                    ).fetchone()
                    condition = " AND ".join(
                        f"{sql(e)} IS NOT DISTINCT FROM {literal(v)}"
                        for e, v in zip(group_exprs, values, strict=True)
                    )
                else:
                    equal = " AND ".join(
                        f"{sql(e)} IS NOT DISTINCT FROM g.{qi(name)}"
                        for e, name in zip(group_exprs, group_names, strict=True)
                    )
                    condition = f"EXISTS (SELECT 1 FROM ({group_rows}) g WHERE {equal})"
                from_clause += (" AND " if tree.args.get("where") else " WHERE ") + condition
            raw_clause = from_clause
            if len(aggregates) == 1:
                aggregate = aggregates[0]
                argument = aggregate.this
                if isinstance(argument, exp.Distinct):
                    if len(argument.expressions) != 1:
                        raise Coverage("Multi-expression distinct aggregates are not yet supported.")
                    argument = argument.expressions[0]
                    if isinstance(aggregate, exp.Count):
                        distinct = (raw_clause, sql(argument))
                predicates = []
                filtered = aggregate.parent if isinstance(aggregate.parent, exp.Filter) else None
                if filtered and not all_context:
                    predicates.append(sql(filtered.expression.this))
                if argument is not None and not isinstance(argument, exp.Star):
                    if not all_context:
                        predicates.append(f"{sql(argument)} IS NOT NULL")
                    if isinstance(aggregate, (exp.Min, exp.Max)) and not all_context:
                        # The aggregate's value can be part of a larger expression.
                        aggregate_query = tree.copy()
                        aggregate_query.set(
                            "expressions",
                            [
                                (filtered or aggregate).copy().as_("_dp_extreme"),
                                *[e.copy().as_(n) for e, n in zip(group_exprs, group_names, strict=True)],
                            ],
                        )
                        aggregate_query.set("order", None)
                        aggregate_query.set("limit", None)
                        extreme_equal = " AND ".join(
                            f"{sql(e)} IS NOT DISTINCT FROM x.{qi(n)}"
                            for e, n in zip(group_exprs, group_names, strict=True)
                        )
                        predicates.append(
                            f"EXISTS (SELECT 1 FROM ({sql(aggregate_query)}) x WHERE {sql(argument)} IS NOT DISTINCT FROM x._dp_extreme"
                            + (" AND " + extreme_equal if extreme_equal else "")
                            + ")"
                        )
                    if distinct_value is not ...:
                        predicates.append(f"{sql(argument)} IS NOT DISTINCT FROM {literal(distinct_value)}")
                if predicates:
                    from_clause += (" AND " if " WHERE " in from_clause else " WHERE ") + " AND ".join(
                        predicates
                    )
                if distinct:
                    distinct = (from_clause, sql(argument))
            elif len(aggregates) > 1:
                # Every referenced input cell participates; individual aggregate
                # extrema need separate explanation to distinguish ties precisely.
                if any(isinstance(a, (exp.Min, exp.Max)) for a in aggregates):
                    raise Coverage(
                        "Split expressions combining multiple extrema into separate output columns for exact tie explanations."
                    )
            if self.detailed:
                conditions += [c for e in group_exprs for c in e.find_all(exp.Column)]
                self.existence = self.contributions(self.existence_columns(), raw_clause)
                self.evidence["group_keys"] = [sql(e) for e in group_exprs]
                if group_exprs:
                    self.evidence["group_values"] = clean(
                        self.cursor.execute(
                            "SELECT " + ", ".join(sql(e) for e in group_exprs) + raw_clause + " LIMIT 1"
                        ).fetchone()
                    )
                if len(aggregates) == 1:
                    self.evidence["function"] = aggregates[0].key.upper()
                    self.evidence["argument"] = sql(argument) if argument is not None else "*"
                    self.evidence["row_count"] = isinstance(aggregates[0], exp.Count) and isinstance(
                        argument, exp.Star
                    )
                    self.evidence["examined_rows"] = self.cursor.execute(
                        "SELECT COUNT(*) " + raw_clause
                    ).fetchone()[0]
                    self.evidence["retained_rows"] = self.cursor.execute(
                        "SELECT COUNT(*) " + from_clause
                    ).fetchone()[0]
                if len(self.sources) > 1:
                    self.capture_pairs(
                        "SELECT "
                        + ", ".join(f"{qi(alias)}.rowid AS {qi(alias)}" for alias in self.sources)
                        + raw_clause
                    )
            context_query = self.contributions(columns + conditions, raw_clause)
            return self.contributions(columns, from_clause), context_query, distinct
        self.kind = (
            "distinct"
            if tree.args.get("distinct")
            else "join"
            if tree.args.get("joins")
            else "filter"
            if tree.args.get("where")
            else "projection"
        )
        row_names = {alias: "_dp_row_" + str(i) for i, alias in enumerate(self.sources)}
        identity_projection = [f"{qi(alias)}.rowid AS {qi(name)}" for alias, name in row_names.items()]
        matching += self.witness_filter(row_names)
        additions, value_paths = [], None
        if self.detailed:
            value_paths, condition_columns = self.scalar_paths(target)
            conditions += condition_columns
            for i, (_, predicate) in enumerate(value_paths):
                additions.append(f"({predicate}) IS TRUE AS {qi('_dp_gate_' + str(i))}")
            calculations = self.scalar_evaluations[:32]
            additions += [
                f"CASE WHEN ({predicate}) IS TRUE THEN to_json({sql(e)}) END AS {qi('_dp_calc_' + str(i))}"
                for i, (e, predicate) in enumerate(calculations)
            ]
            additions += [
                f"({predicate}) IS TRUE AS {qi('_dp_eval_' + str(i))}"
                for i, (_, predicate) in enumerate(calculations)
            ]
        candidate = f"SELECT {', '.join(projections + identity_projection + additions)} {from_clause}"
        matched = f"SELECT * FROM ({candidate}) candidates WHERE {matching}"
        if not self.dataset.witnesses and not tree.args.get("distinct"):
            if self.cursor.execute(f"SELECT COUNT(*) FROM ({matched}) occurrences").fetchone()[0] > 1:
                raise Coverage(
                    "This composed SQL step has indistinguishable duplicate occurrences without captured row witnesses. Exact occurrence provenance is unavailable; use separate pipeline nodes for these stages."
                )
        contributions = self.from_matched(columns, matched, row_names)
        if self.detailed:
            paths = [
                self.from_matched(
                    [column], f"SELECT * FROM ({matched}) gated WHERE {qi('_dp_gate_' + str(i))}", row_names
                )
                for i, (column, _) in enumerate(value_paths)
            ]
            contributions = " UNION ALL ".join(paths)
            self.declarations[contributions] = set().union(*(self.declarations.get(p, set()) for p in paths))
            if value_paths:
                selected = self.cursor.execute(
                    "SELECT "
                    + ", ".join(f"bool_or({qi('_dp_gate_' + str(i))})" for i in range(len(value_paths)))
                    + f" FROM ({matched}) gates"
                ).fetchone()
                self.branch_columns = {
                    (c.table, self.original_column(self.sources[c.table], c.name))
                    for (c, predicate), active in zip(value_paths, selected, strict=True)
                    if predicate != "TRUE" and not active
                }
            self.existence = self.from_matched(self.existence_columns(), matched, row_names)
            if len(self.sources) > 1:
                self.capture_pairs(
                    "SELECT "
                    + ", ".join(f"{qi(name)} AS {qi(alias)}" for alias, name in row_names.items())
                    + f" FROM ({matched}) pairs"
                )
            if calculations:
                values = self.cursor.execute(
                    "SELECT "
                    + ", ".join(
                        qi("_dp_calc_" + str(i)) + ", " + qi("_dp_eval_" + str(i))
                        for i in range(len(calculations))
                    )
                    + f" FROM ({matched}) evaluated LIMIT 2"
                ).fetchall()
                if len(values) == 1:
                    self.evidence["calculations"] = [
                        {"expression": sql(e), "value": json.loads(v) if v is not None else None}
                        for (e, _), v, active in zip(
                            calculations, values[0][::2], values[0][1::2], strict=True
                        )
                        if active
                    ]
        return (
            contributions,
            self.from_matched(conditions, matched, row_names),
            None,
        )

    def existence_columns(self):
        return [
            exp.column(data.column_map.get(data.columns[0]["name"], data.columns[0]["name"]), table=alias)
            for alias, data in self.sources.items()
            if data.columns
        ]

    def capture_pairs(self, query):
        total = self.cursor.execute(f"SELECT COUNT(*) FROM ({query}) pairs").fetchone()[0]
        self.evidence["join_pairs"] = {
            "aliases": list(self.sources),
            "rows": clean(self.cursor.execute(query + " ORDER BY ALL LIMIT 25").fetchall()),
            "total": total,
            "limit": 25,
        }

    def scalar_paths(self, target):
        """Keep CASE/IF predicates as context; follow only selected value branches."""
        paths, conditions, evaluations = [], [], {}

        def visit(expression, predicate="TRUE", value=True):
            if isinstance(expression, (exp.Column, exp.Binary, exp.Case, exp.If, exp.Literal, exp.Cast)):
                key = sql(expression)
                previous = evaluations.get(key)
                evaluations[key] = (
                    expression,
                    f"({previous[1]}) OR ({predicate})" if previous else predicate,
                )
            if isinstance(expression, exp.Column):
                if value:
                    paths.append((expression, predicate))
                else:
                    conditions.append(expression)
            elif isinstance(expression, exp.Case):
                remaining = predicate
                for branch in expression.args.get("ifs", []):
                    condition = (
                        exp.EQ(this=expression.this.copy(), expression=branch.this.copy())
                        if expression.this
                        else branch.this
                    )
                    visit(condition, remaining, False)
                    visit(branch.args["true"], f"({remaining}) AND ({sql(condition)}) IS TRUE", value)
                    remaining = f"({remaining}) AND ({sql(condition)}) IS NOT TRUE"
                if expression.args.get("default"):
                    visit(expression.args["default"], remaining, value)
            elif isinstance(expression, exp.If):
                visit(expression.this, predicate, False)
                visit(expression.args["true"], f"({predicate}) AND ({sql(expression.this)}) IS TRUE", value)
                if expression.args.get("false"):
                    visit(
                        expression.args["false"],
                        f"({predicate}) AND ({sql(expression.this)}) IS NOT TRUE",
                        value,
                    )
            else:
                for child in expression.iter_expressions():
                    visit(child, predicate, value)

        visit(target)
        self.scalar_evaluations = list(evaluations.values())
        # One input cell may occur more than once syntactically. Participation
        # counts represent joined rows, not repeated references in an expression.
        grouped = {}
        for column, predicate in paths:
            key = (column.table, column.name)
            if key in grouped:
                old, previous = grouped[key]
                grouped[key] = (old, f"({previous}) OR ({predicate})")
            else:
                grouped[key] = (column, predicate)
        return list(grouped.values()), conditions

    def witness_filter(self, row_names):
        conditions = []
        for alias, witness in self.dataset.witnesses.items():
            if alias in row_names:
                value = self.cursor.execute(
                    f"SELECT {qi(witness['column'])} FROM {qi(self.dataset.storage)} WHERE rowid=?",
                    [self.row],
                ).fetchone()[0]
                conditions.append(f"{qi(row_names[alias])} IS NOT DISTINCT FROM {literal(value)}")
        return (" AND " + " AND ".join(conditions)) if conditions else ""

    @staticmethod
    def original_column(data, name):
        return next((original for original, stored in data.column_map.items() if stored == name), name)

    def contributions(self, columns, from_clause):
        queries, seen = [], set()
        for column in columns:
            alias = column.table
            data = self.sources.get(alias)
            if data is None or column.name == "*" or (alias, column.name) in seen:
                continue
            seen.add((alias, column.name))
            self.role_columns.add((alias, self.original_column(data, column.name)))
            role = f", {literal(alias)} AS role" if self.detailed else ""
            queries.append(
                f"SELECT {literal(data.id)} AS dataset, {literal(data.node)} AS node, {literal(data.port)} AS port, {qi(alias)}.rowid AS row_id, {literal(self.original_column(data, column.name))} AS column_name, to_json({sql(column)}) AS value, {literal(data.source)} AS source{role} {from_clause}"
                + (" AND " if " WHERE " in from_clause else " WHERE ")
                + f"{qi(alias)}.rowid IS NOT NULL"
            )
        query = " UNION ALL ".join(queries)
        self.declarations[query] = {
            (alias, self.original_column(self.sources[alias], name)) for alias, name in seen
        }
        return query

    def from_matched(self, columns, matched, row_names, lists=False, predicate=None):
        queries, seen = [], set()
        for column in columns:
            alias, name = column.table, column.name
            data = self.sources.get(alias)
            if data is None or name == "*" or (alias, name) in seen:
                continue
            seen.add((alias, name))
            self.role_columns.add((alias, self.original_column(data, name)))
            role = f", {literal(alias)} AS role" if self.detailed else ""
            identities = f"SELECT {'unnest(' if lists else ''}{qi(row_names[alias])}{')' if lists else ''} AS rid FROM ({matched}) witnesses"
            membership = (
                f"JOIN ({identities}) participation ON d.rowid=participation.rid WHERE TRUE"
                if self.detailed
                else f"WHERE d.rowid IN ({identities})"
            )
            queries.append(
                f"SELECT {literal(data.id)} AS dataset, {literal(data.node)} AS node, {literal(data.port)} AS port, d.rowid AS row_id, {literal(self.original_column(data, name))} AS column_name, to_json(d.{qi(name)}) AS value, {literal(data.source)} AS source{role} FROM {qi(data.storage or data.table)} d {membership}"
                + (" AND " + predicate(alias) if predicate else "")
            )
        query = " UNION ALL ".join(queries)
        self.declarations[query] = {
            (alias, self.original_column(self.sources[alias], name)) for alias, name in seen
        }
        return query

    def window(
        self,
        tree,
        target,
        record,
        index,
        columns,
        conditions,
        projections,
        matching,
        from_clause,
        all_context,
        distinct_value=...,
    ):
        windows = list(target.find_all(exp.Window))
        if len(windows) != 1:
            raise Coverage(
                "Expressions containing multiple independent windows require separate output columns."
            )
        window = windows[0]
        function = window.this
        filter_expression = None
        if isinstance(function, exp.Filter):
            filter_expression = function.expression.this
            function = function.this
        supported = (
            exp.Sum,
            exp.Avg,
            exp.Min,
            exp.Max,
            exp.Count,
            exp.Lag,
            exp.Lead,
            exp.FirstValue,
            exp.LastValue,
            exp.NthValue,
            exp.RowNumber,
            exp.Rank,
            exp.DenseRank,
            exp.PercentRank,
            exp.CumeDist,
            exp.Ntile,
        )
        if not isinstance(function, supported):
            raise Coverage(f"Window function {function.key} does not yet have an exact provenance rule.")
        function_columns = list(function.find_all(exp.Column))
        columns = function_columns or list((window.args.get("order") or window).find_all(exp.Column))
        if not columns:
            columns = [
                exp.column(data.column_map.get(data.columns[0]["name"], data.columns[0]["name"]), table=alias)
                for alias, data in self.sources.items()
            ]
        row_names, additions = {}, []
        for i, alias in enumerate(self.sources):
            name = "_dp_frame_" + str(i)
            row_names[alias] = name
            instrumented = window.copy()
            if isinstance(function, (exp.Lag, exp.Lead, exp.FirstValue, exp.LastValue, exp.NthValue)):
                replacement = function.copy()
                replacement.set("this", exp.column("rowid", table=alias))
                if replacement.args.get("default"):
                    replacement.set("default", exp.Null())
                instrumented.set("this", replacement)
                additions.append(f"[{sql(instrumented)}] AS {qi(name)}")
            else:
                instrumented.set("this", exp.ArrayAgg(this=exp.column("rowid", table=alias)))
                if isinstance(
                    function,
                    (exp.RowNumber, exp.Rank, exp.DenseRank, exp.PercentRank, exp.CumeDist, exp.Ntile),
                ):
                    instrumented.set("spec", None)
                    instrumented.set("order", None)
                additions.append(f"{sql(instrumented)} AS {qi(name)}")
        additions.append(f"{sql(window)} AS _dp_window_value")
        current_rows = {alias: "_dp_current_" + str(i) for i, alias in enumerate(self.sources)}
        additions.extend(f"{qi(alias)}.rowid AS {qi(name)}" for alias, name in current_rows.items())
        matching += self.witness_filter(current_rows)
        candidate = f"SELECT {', '.join(projections + additions)} {from_clause}"
        matched = f"SELECT * FROM ({candidate}) candidates WHERE {matching}"

        def predicate(alias):
            clauses = []
            argument = function.this

            # Single-relation aggregate arguments can be evaluated against each
            # contributing stored row without changing frame membership.
            def local(expression):
                if any(c.table != alias for c in expression.find_all(exp.Column)):
                    raise Coverage(
                        "Window arguments spanning joined relations require an intermediate projection."
                    )
                return sql(
                    expression.copy().transform(
                        lambda e: (
                            exp.column(e.name, table="d", quoted=True) if isinstance(e, exp.Column) else e
                        )
                    )
                )

            if (
                isinstance(function, (exp.Sum, exp.Avg, exp.Min, exp.Max, exp.Count))
                and argument
                and not isinstance(argument, exp.Star)
            ):
                if isinstance(argument, exp.Distinct):
                    argument = argument.expressions[0]
                clauses.append(local(argument) + " IS NOT NULL")
                if isinstance(function, (exp.Min, exp.Max)):
                    clauses.append(
                        local(argument)
                        + f" IS NOT DISTINCT FROM (SELECT _dp_window_value FROM ({matched}) chosen LIMIT 1)"
                    )
            if filter_expression:
                clauses.append(local(filter_expression))
            if distinct_value is not ...:
                clauses.append(
                    local(function.this.expressions[0]) + " IS NOT DISTINCT FROM " + literal(distinct_value)
                )
            return " AND ".join(clauses) or "TRUE"

        contributions = self.from_matched(
            columns, matched, row_names, lists=True, predicate=None if all_context else predicate
        )
        context_query = self.from_matched(
            columns + conditions + list(window.find_all(exp.Column)), matched, row_names, lists=True
        )
        if self.detailed:
            self.existence = self.from_matched(self.existence_columns(), matched, row_names, lists=True)
            self.evidence.update(
                function=function.key.upper(),
                argument=sql(function),
                row_count=isinstance(function, exp.Count) and isinstance(function.this, exp.Star),
                partition=[sql(e) for e in window.args.get("partition_by", [])],
                order=sql(window.args["order"]) if window.args.get("order") else "",
                frame=sql(window.args["spec"]) if window.args.get("spec") else "SQL default frame",
            )
        distinct = None
        if isinstance(function, exp.Count) and isinstance(function.this, exp.Distinct) and not all_context:
            if len(function.this.expressions) != 1:
                raise Coverage("Multi-expression distinct windows are not yet supported.")
            argument = function.this.expressions[0]
            aliases = {c.table for c in argument.find_all(exp.Column)}
            if len(aliases) != 1:
                raise Coverage("Distinct window arguments must reference one input relation.")
            alias = next(iter(aliases))
            data = self.sources[alias]
            base = f"FROM {qi(data.storage or data.table)} {qi(alias)} WHERE {qi(alias)}.rowid IN (SELECT unnest({qi(row_names[alias])}) FROM ({matched}) frames)"
            if filter_expression:
                base += " AND " + sql(filter_expression)
            distinct = (base, sql(argument))
        return context_query if all_context else contributions, context_query, distinct

    def set_operation(self, tree, record, index):
        if tree.args.get("distinct") is False:
            raise Coverage(
                "Set operations with ALL preserve native results, but occurrence-level duplicate assignment is not yet covered. DISTINCT set operations are supported."
            )
        self.kind = tree.key
        self.expression = tree.key.upper() + " · " + self.dataset.columns[index]["name"]
        queries, contexts = [], []
        for side, query in (("left", tree.this), ("right", tree.expression)):
            data = self.virtual(query, self.dataset, side)
            self.sources[side] = data
            columns = [c["name"] for c in data.columns]
            match = self.matches([data.column_map.get(c, c) for c in columns], record, "d")
            statement = f"SELECT {literal(data.id)} AS dataset, {literal(data.node)} AS node, {literal(data.port)} AS port, d.rowid AS row_id, {literal(columns[index])} AS column_name, to_json(d.{qi(data.column_map.get(columns[index], columns[index]))}) AS value, FALSE AS source FROM {qi(data.storage or data.table)} d"
            if self.detailed:
                self.role_columns.add((side, columns[index]))
                statement = statement.replace(
                    " AS source FROM ", f" AS source, {literal(side)} AS role FROM "
                )
            if isinstance(tree, exp.Except) and side == "right":
                contexts.append(statement)
            else:
                queries.append(statement + " WHERE " + match)
        values, selection = " UNION ALL ".join(queries), " UNION ALL ".join(contexts)
        self.declarations[values] = {
            (side, self.sources[side].columns[index]["name"])
            for side in self.sources
            if not (isinstance(tree, exp.Except) and side == "right")
        }
        self.declarations[selection] = (
            {("right", self.sources["right"].columns[index]["name"])} if contexts else set()
        )
        return values, selection, None
