"""Provenance queries for one explained cell, rewritten over materialized dependencies.

Each SQL step is normalized (CTEs, derived tables and grouped windows become their own
materialized relations), then traced back to contributing input cells.
"""

import contextlib

import duckdb
import sqlglot
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify

from .datasets import Dataset
from .materialize import drop_relations, plan_materialization, publish_view
from .sqlast import has_filtering_join, has_grouping_sets, is_volatile, sql
from .util import Problem, digest, literal, qi


class Coverage(Exception):
    """An SQL construct outside exact provenance coverage; the result itself remains valid."""


def unalias(expression):
    return expression.this if isinstance(expression, exp.Alias) else expression


class TraceQuery:
    def __init__(self, context, cursor, dataset, row):
        self.context, self.cursor, self.dataset = context, cursor, dataset
        self.row = row
        self.sources = {}
        self.expression, self.kind = "", "projection"

    def virtual(self, query, owner, name):
        """Materialize an intermediate relation once, keyed by its owner and query."""
        key = "trace_" + digest([owner.id, sql(query), name])[:24]
        with self.context.trace_lock:
            if key in self.context.datasets:
                return self.context.datasets[key]
            data_inputs = {
                t.name: self.context.datasets[t.name]
                for t in query.find_all(exp.Table)
                if t.name in self.context.datasets
            }
            statement = {"table": key, "query": sql(query), "bindings": {}}
            plan = plan_materialization(self.cursor, statement, data_inputs)
            try:
                self.cursor.execute(plan["sql"])
                columns, mapping, _ = publish_view(self.cursor, key, plan)
                count = self.cursor.execute(f"SELECT count(*) FROM {qi(key)}").fetchone()[0]
            except BaseException:
                # An interrupted trace must not leave tables that block the next explanation.
                with contextlib.suppress(duckdb.Error):
                    drop_relations(self.cursor, key, plan["storage"])
                raise
            data = Dataset(
                id=key,
                node=owner.node,
                port=name,
                table=key,
                columns=columns,
                count=count,
                run=owner.run,
                query=sql(query),
                bindings={},
                dependencies={table: data.id for table, data in data_inputs.items()},
                fingerprint=owner.fingerprint,
                status=owner.status,
                storage=plan["storage"],
                column_map=mapping,
                witnesses=plan["witnesses"],
                groups=plan["groups"],
            )
            with self.context.lock:
                self.context.datasets[key] = data
            return data

    def normalize(self, dataset):
        tree = sqlglot.parse_one(dataset.query, read="duckdb")
        if is_volatile(tree):
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

        def inline_ctes(expression):
            return expression.transform(
                lambda e: (
                    exp.alias_(exp.to_table(cte_map[e.name]), e.alias_or_name, table=True)
                    if isinstance(e, exp.Table) and e.name in cte_map
                    else e
                )
            )

        with_ = tree.args.get("with_")
        if with_:
            if with_.args.get("recursive"):
                raise Coverage("Recursive CTE lineage is not yet supported.")
            for cte in with_.expressions:
                data = self.virtual(inline_ctes(cte.this.copy()), dataset, cte.alias)
                cte_map[cte.alias] = data.table
            tree.set("with_", None)
            tree = inline_ctes(tree)
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
                    id=dataset.id,
                    node=dataset.node,
                    port=dataset.port,
                    table=dataset.table,
                    columns=dataset.columns,
                    count=dataset.count,
                    run=dataset.run,
                    query=sql(outer),
                    bindings={},
                    dependencies={data.table: data.id},
                    fingerprint=dataset.fingerprint,
                )
            )
        for table in tree.find_all(exp.Table):
            self.sources[table.alias_or_name] = self.context.datasets[table.name]
        for column in tree.find_all(exp.Column):
            data = self.sources.get(column.table)
            if data and column.name in data.column_map:
                column.set("this", exp.to_identifier(data.stored(column.name), quoted=True))
        for table in tree.find_all(exp.Table):
            data = self.sources[table.alias_or_name]
            table.set("this", exp.to_identifier(data.relation, quoted=True))
        return tree

    def recorded(self, column):
        """Read one stored value of the explained row, keeping its exact DuckDB type."""
        return f"(SELECT {qi(column)} FROM {qi(self.dataset.relation)} WHERE rowid = {int(self.row)})"

    def matches(self, names, alias=""):
        """Match each named relation column to the explained row's public value in order."""
        prefix = qi(alias) + "." if alias else ""
        stored = [self.dataset.stored(c["name"]) for c in self.dataset.columns]
        return (
            " AND ".join(
                f"{prefix}{qi(name)} IS NOT DISTINCT FROM {self.recorded(column)}"
                for name, column in zip(names, stored, strict=True)
            )
            or "TRUE"
        )

    def trace(self, tree, column_index, all_context=False, distinct_value=...):
        if isinstance(tree, exp.SetOperation):
            return self.set_operation(tree, column_index)
        if not isinstance(tree, exp.Select):
            raise Coverage("Lineage currently expects SELECT or a set operation at this step.")
        if tree.args.get("qualify"):
            raise Coverage("QUALIFY lineage is not yet supported; use a nested SELECT for this step.")
        if has_filtering_join(tree):
            raise Coverage(
                "SEMI/ANTI join selection provenance is not yet supported; use an explicit join step."
            )
        if tree.args.get("group") and has_grouping_sets(tree.args["group"]):
            raise Coverage("Grouping sets, ROLLUP and CUBE provenance is not yet supported.")
        expressions = [unalias(e) for e in tree.expressions]
        target = expressions[column_index]
        self.target = target
        self.tree = tree
        self.expression = sql(target)
        output_names = [f"_dp_value_{i}" for i in range(len(expressions))]
        projections = [f"{sql(e)} AS {qi(n)}" for e, n in zip(expressions, output_names, strict=True)]
        matching = self.matches(output_names)
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
            columns = self.first_columns()
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
                target, conditions, projections, matching, from_clause, all_context, distinct_value
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
                    condition = " AND ".join(
                        f"{sql(e)} IS NOT DISTINCT FROM {self.recorded(hidden)}"
                        for e, hidden in zip(group_exprs, self.dataset.groups.values(), strict=True)
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
        candidate = f"SELECT {', '.join(projections + identity_projection)} {from_clause}"
        matched = f"SELECT * FROM ({candidate}) candidates WHERE {matching}"
        if (
            not self.dataset.witnesses
            and not tree.args.get("distinct")
            and self.cursor.execute(f"SELECT COUNT(*) FROM ({matched}) occurrences").fetchone()[0] > 1
        ):
            raise Coverage(
                "This composed SQL step has indistinguishable duplicate occurrences without captured row witnesses. Exact occurrence provenance is unavailable; use separate pipeline nodes for these stages."
            )
        return (
            self.from_matched(columns, matched, row_names),
            self.from_matched(conditions, matched, row_names),
            None,
        )

    def describe(self, response):
        """Describe the captured expression without inferring operations from equal values."""
        target = getattr(self, "target", None)
        if target is None:
            return {"operation": self.kind, "formula": self.expression, "passthrough": False}

        predicates = []
        if self.tree.args.get("where"):
            predicates.append(self.tree.args["where"].this)
        predicates.extend(join.args["on"] for join in self.tree.args.get("joins", []) if join.args.get("on"))
        predicates.extend(filtered.expression.this for filtered in target.find_all(exp.Filter))
        aliases = {}
        for column in self.tree.find_all(exp.Column):
            if column.table:
                aliases.setdefault(column.name, set()).add(column.table)

        def display_column(node):
            if isinstance(node, exp.Column):
                data = self.sources.get(node.table)
                return exp.column(
                    self.original_column(data, node.name) if data else node.name,
                    table=node.table if len(aliases.get(node.name, set())) > 1 else None,
                )
            return node

        calculation = {
            "operation": "expression",
            "formula": sql(target.transform(display_column)),
            "passthrough": isinstance(target, exp.Column)
            and self.kind in {"projection", "filter", "join"}
            and response["total"] == 1,
        }
        selection = [sql(predicate.transform(display_column)) for predicate in predicates]
        group = self.tree.args.get("group")
        if group and self.dataset.groups:
            for expression, stored in zip(group.expressions, self.dataset.groups.values(), strict=True):
                value = self.cursor.execute(
                    f"SELECT {qi(stored)} FROM {qi(self.dataset.relation)} WHERE rowid=?", [self.row]
                ).fetchone()[0]
                try:
                    comparison = "IS NULL" if value is None else f"= {literal(value)}"
                    selection.append(f"{sql(expression.transform(display_column))} {comparison}")
                except (Problem, ValueError):
                    pass
        if selection:
            calculation["selection"] = selection
        aggregate = target.this if isinstance(target, exp.Filter) else target
        if isinstance(aggregate, (exp.Sum, exp.Avg, exp.Min, exp.Max, exp.Count)):
            argument = aggregate.this
            if isinstance(argument, (exp.Column, exp.Star)):
                calculation["operation"] = aggregate.key
            elif isinstance(aggregate, exp.Count) and isinstance(argument, exp.Distinct):
                calculation["operation"] = "count_distinct"

        # Only substitute uniquely identified operands of a scalar expression.
        # Aggregates, windows, paginated operands and ambiguous self-joins keep their formula.
        if (
            target.find(exp.AggFunc, exp.Window)
            or response["offset"]
            or response["total"] != len(response["contributions"])
        ):
            return calculation
        replacements = {}
        for column in target.find_all(exp.Column):
            data = self.sources.get(column.table)
            if data is None:
                return calculation
            original = self.original_column(data, column.name)
            inputs = [
                item
                for item in response["contributions"]
                if item["dataset"] == data.id and item["column"] == original
            ]
            witness = self.dataset.witnesses.get(column.table)
            if witness:
                witnessed_row = self.cursor.execute(
                    f"SELECT {qi(witness['column'])} FROM {qi(self.dataset.relation)} WHERE rowid=?",
                    [self.row],
                ).fetchone()[0]
                inputs = [item for item in inputs if item["row"] == witnessed_row]
                if witnessed_row is None:
                    replacements[(column.table, column.name)] = exp.Null()
                    continue
            if len(inputs) != 1:
                return calculation
            value = self.cursor.execute(
                f"SELECT {qi(column.name)} FROM {qi(data.relation)} WHERE rowid=?",
                [inputs[0]["row"]],
            ).fetchone()[0]
            # Presentation metadata must not downgrade an otherwise valid explanation.
            try:
                replacements[(column.table, column.name)] = sqlglot.parse_one(literal(value), read="duckdb")
            except (Problem, ValueError, sqlglot.errors.ParseError):
                return calculation
        evaluated = target.transform(
            lambda node: (
                replacements[(node.table, node.name)].copy() if isinstance(node, exp.Column) else node
            )
        )
        calculation["evaluated"] = sql(evaluated)
        return calculation

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

    def first_columns(self):
        """One column per source, standing for whole rows when no column is referenced."""
        return [
            exp.column(data.stored(data.columns[0]["name"]), table=alias)
            for alias, data in self.sources.items()
            if data.columns
        ]

    @staticmethod
    def contribution(data, row_id, column_name, value, source, rest):
        """A SELECT yielding contribution records, in the column order Lineage.page reads."""
        return (
            f"SELECT {literal(data.id)} AS dataset, {literal(data.node)} AS node, {literal(data.port)} AS port, "
            f"{row_id} AS row_id, {literal(column_name)} AS column_name, to_json({value}) AS value, "
            f"{source} AS source {rest}"
        )

    def contributions(self, columns, from_clause):
        queries, seen = [], set()
        for column in columns:
            alias = column.table
            data = self.sources.get(alias)
            if data is None or column.name == "*" or (alias, column.name) in seen:
                continue
            seen.add((alias, column.name))
            queries.append(
                self.contribution(
                    data,
                    f"{qi(alias)}.rowid",
                    self.original_column(data, column.name),
                    sql(column),
                    literal(data.source),
                    from_clause
                    + (" AND " if " WHERE " in from_clause else " WHERE ")
                    + f"{qi(alias)}.rowid IS NOT NULL",
                )
            )
        return " UNION ALL ".join(queries)

    def from_matched(self, columns, matched, row_names, lists=False, predicate=None):
        queries, seen = [], set()
        for column in columns:
            alias, name = column.table, column.name
            data = self.sources.get(alias)
            if data is None or name == "*" or (alias, name) in seen:
                continue
            seen.add((alias, name))
            identities = f"SELECT {'unnest(' if lists else ''}{qi(row_names[alias])}{')' if lists else ''} AS rid FROM ({matched}) witnesses"
            queries.append(
                self.contribution(
                    data,
                    "d.rowid",
                    self.original_column(data, name),
                    f"d.{qi(name)}",
                    literal(data.source),
                    f"FROM {qi(data.relation)} d WHERE d.rowid IN ({identities})"
                    + (" AND " + predicate(alias) if predicate else ""),
                )
            )
        return " UNION ALL ".join(queries)

    def window(self, target, conditions, projections, matching, from_clause, all_context, distinct_value=...):
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
            columns = self.first_columns()
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
            base = f"FROM {qi(data.relation)} {qi(alias)} WHERE {qi(alias)}.rowid IN (SELECT unnest({qi(row_names[alias])}) FROM ({matched}) frames)"
            if filter_expression:
                base += " AND " + sql(filter_expression)
            distinct = (base, sql(argument))
        return context_query if all_context else contributions, context_query, distinct

    def set_operation(self, tree, index):
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
            match = self.matches([data.stored(c) for c in columns], "d")
            statement = self.contribution(
                data,
                "d.rowid",
                columns[index],
                f"d.{qi(data.stored(columns[index]))}",
                "FALSE",
                f"FROM {qi(data.relation)} d",
            )
            if isinstance(tree, exp.Except) and side == "right":
                contexts.append(statement)
            else:
                queries.append(statement + " WHERE " + match)
        return " UNION ALL ".join(queries), " UNION ALL ".join(contexts), None
