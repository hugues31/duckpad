"""Forward row correspondence over captured storage, never external source queries."""

from sqlglot import exp

from .materialize import outer_aggregates, to_physical
from .sqlast import explained, sql
from .trace import Coverage
from .trace import builders as b
from .trace.describe import Display
from .trace.normalize import parse, qualify_columns
from .trace.step import check_supported
from .util import clean, qi


class Matcher:
    def __init__(self, context, cursor, data, parent, row):
        self.cursor, self.data, self.parent, self.row = cursor, data, parent, row
        if data.opaque_python:
            raise Coverage("Python does not provide an input-row mapping.")
        if data.source:
            raise Coverage("This output reads external data and has no captured input-row mapping.")
        if data.partition or data.partition_context or data.origins or data.disk:
            raise Coverage("Downstream row tracing across partitions is not yet supported.")
        tree = parse(data)
        check_supported(tree)
        if tree.args.get("with_") or tree.find(exp.Subquery):
            raise Coverage("This composed SQL step has no captured forward row mapping.")
        # Restrict qualification to this generation's captured dependencies. Table functions,
        # external relations and newer generations can never be substituted here.
        dependencies = {name: context.datasets[identity] for name, identity in data.dependencies.items()}
        tree = qualify_columns(tree, dependencies)
        self.sources = to_physical(tree, dependencies)
        self.tree = tree
        self.aliases = [alias for alias, source in self.sources.items() if source.id == parent.id]
        if not self.aliases:
            raise Coverage("This output does not capture the selected input generation.")
        self.member = exp.or_(*(b.same(b.rowid(a), b.value(row)) for a in self.aliases))
        self.base = b.without(tree, "group", "having", "order", "limit", "offset", "distinct", "qualify")
        self.base.set("expressions", [exp.Star()])

    @staticmethod
    def original_column(data, name):
        return next((key for key, value in data.column_map.items() if value == name), name)

    def display(self, expression):
        return explained(Display(self, self.tree)(expression))

    def count(self, query):
        return self.cursor.execute(f"SELECT count(*) FROM ({sql(query)}) counted").fetchone()[0]

    def predicate(self, predicate, query, kind):
        # Read the original typed operands (including aggregates) from captured storage.
        operands = []
        for item in predicate.walk(prune=lambda e: isinstance(e, exp.AggFunc)):
            if isinstance(item, (exp.Column, exp.AggFunc)) and item not in operands:
                operands.append(item)
        projected = b.project(query, [predicate.copy(), *(o.copy() for o in operands)])
        record = self.cursor.execute(sql(projected.limit(1))).fetchone()
        if record is None:
            return None
        values = {sql(o): b.value(v) for o, v in zip(operands, record[1:], strict=True)}
        evaluated = predicate.transform(lambda e: values[sql(e)].copy() if sql(e) in values else e)
        return {
            "kind": kind,
            "condition": self.display(predicate),
            "evaluated": explained(evaluated),
            "result": record[0],
        }

    def rejection(self):
        before = b.without(self.base, "where").where(self.member)
        if not self.count(before):
            joins = self.tree.args.get("joins") or []
            if len(joins) == 1 and len(self.sources) == 2 and len(self.aliases) == 1:
                join = joins[0]
                predicate = join.args.get("on")
                if predicate is not None and not join.args.get("side"):
                    alias = self.aliases[0]
                    other = next(data for key, data in self.sources.items() if key != alias)
                    columns = list(predicate.find_all(exp.Column))
                    values = {}
                    for column in columns:
                        if column.table == alias:
                            value = self.cursor.execute(
                                f"SELECT {qi(column.name)} FROM {qi(self.parent.relation)} WHERE rowid=?",
                                [self.row],
                            ).fetchone()[0]
                            values[sql(column)] = b.value(value)
                    return {
                        "kind": "join",
                        "condition": self.display(predicate),
                        "evaluated": sql(
                            predicate.transform(lambda e: values[sql(e)].copy() if sql(e) in values else e)
                        ),
                        "missing_node": other.node,
                        "missing_port": other.port,
                        "result": False,
                    }
            raise Coverage("The join has no matching row; its exact rejection reason is not covered.")
        where = self.tree.args.get("where")
        if where and not self.count(self.base.where(self.member)):
            return self.predicate(where.this, before, "where")
        raise Coverage("No captured output row matches; this SQL selection is not yet covered.")

    def match(self):
        witnesses = [w for w in self.data.witnesses.values() if w["dataset"] == self.parent.id]
        if witnesses:
            where = " OR ".join(f"{qi(w['column'])}=?" for w in witnesses)
            query = f"SELECT rowid FROM {qi(self.data.relation)} WHERE {where}"
            return query, [self.row] * len(witnesses), {}
        if self.tree.args.get("group") or outer_aggregates(self.tree):
            return self.grouped()
        if self.tree.args.get("distinct") and not self.tree.find(exp.Window):
            if self.tree.args.get("limit") or self.tree.args.get("offset"):
                raise Coverage("DISTINCT with LIMIT or OFFSET has no exact forward row mapping.")
            # DISTINCT identifies a value tuple, including NULL, rather than an occurrence.
            values = b.project(self.base.where(self.member), self.tree.expressions)
            if len(values.expressions) != len(self.data.columns):
                raise Coverage("Expanding projections have no exact forward row mapping.")
            for index, expression in enumerate(values.expressions):
                expression = expression.this if isinstance(expression, exp.Alias) else expression
                values.expressions[index] = expression.copy().as_(f"v{index}")
            condition = " AND ".join(
                f"o.{qi(self.data.stored(c['name']))} IS NOT DISTINCT FROM v.v{i}"
                for i, c in enumerate(self.data.columns)
            )
            return (
                f"SELECT o.rowid FROM {qi(self.data.relation)} o WHERE EXISTS "
                f"(SELECT 1 FROM ({sql(values)}) v WHERE {condition})",
                [],
                {},
            )
        raise Coverage("This SQL step has no captured forward row witnesses.")

    def grouped(self):
        group = self.tree.args.get("group")
        keys = group.expressions if group else []
        if len(keys) != len(self.data.groups):
            raise Coverage("The group keys have no exact captured mapping.")
        if self.tree.find(exp.Window):
            raise Coverage("Combined grouping and windows have no exact forward row mapping.")
        selected = b.project(self.base.where(self.member), keys or [b.value(1)]).distinct()
        groups = self.cursor.execute(sql(selected)).fetchall()
        if not groups:
            return "SELECT NULL::BIGINT WHERE FALSE", [], {}
        # A join can place the selected row into several groups; all matching output rows
        # remain selectable. Group details are computed for the followed row below.
        conditions = [
            b.every(
                b.same(b.column(hidden), b.value(v))
                for hidden, v in zip(self.data.groups.values(), values[: len(keys)], strict=True)
            )
            for values in groups
        ]
        query = f"SELECT rowid FROM {qi(self.data.relation)} WHERE {sql(exp.or_(*conditions))}"
        metadata = {"grouped": True}
        if not self.cursor.execute(query).fetchone():
            having = self.tree.args.get("having")
            if having:
                if len(groups) > 1:
                    raise Coverage(
                        "This row enters several rejected groups; their rejection reasons are not yet covered."
                    )
                condition = b.every(
                    b.same(k.copy(), b.value(v)) for k, v in zip(keys, groups[0], strict=False)
                )
                evaluation = b.without(self.tree, "having", "order", "limit", "offset").where(condition)
                reason = self.predicate(having.this, evaluation, "having")
                if reason and reason["result"] is not True:
                    metadata["reason"] = reason
        return query, [], metadata

    def group_details(self, row):
        keys = self.tree.args["group"].expressions if self.tree.args.get("group") else []
        values = (
            self.cursor.execute(
                f"SELECT {', '.join(qi(c) for c in self.data.groups.values())} "
                f"FROM {qi(self.data.relation)} WHERE rowid=?",
                [row],
            ).fetchone()
            if keys
            else []
        )
        selected = self.base.where(
            b.every(b.same(k.copy(), b.value(v)) for k, v in zip(keys, values, strict=True))
        )
        return {
            "other_rows": max(0, self.count(selected) - 1),
            "group": [
                {"expression": self.display(k), "value": clean(v)} for k, v in zip(keys, values, strict=True)
            ],
        }

    def join_details(self, row):
        conditions = []
        for join in self.tree.args.get("joins") or []:
            predicate = join.args.get("on")
            if predicate is not None:
                conditions.append(sql(predicate))
        if not conditions:
            return {}
        values = {}
        for alias, witness in self.data.witnesses.items():
            identity = self.cursor.execute(
                f"SELECT {qi(witness['column'])} FROM {qi(self.data.relation)} WHERE rowid=?", [row]
            ).fetchone()[0]
            values[alias] = identity
        selected = b.without(self.base, "where").where(
            b.every(b.same(b.rowid(alias), b.value(identity)) for alias, identity in values.items())
        )
        return {
            "conditions": [
                self.predicate(j.args["on"], selected, "join")
                for j in self.tree.args.get("joins", [])
                if j.args.get("on") is not None
            ]
        }
