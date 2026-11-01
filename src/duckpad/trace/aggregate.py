"""Grouped steps: GROUP BY and aggregates outside windows.

The explained row's group selects candidate input rows. A single aggregate further
keeps the rows that determine its value: non-null arguments, FILTER selections and,
for MIN and MAX, the rows holding the extreme value.
"""

from sqlglot import exp

from ..materialize import outer_aggregates
from . import builders as b
from .coverage import Coverage
from .step import Trace, Visitor, distinct_values

EXTREMA = (exp.Min, exp.Max)


def grouped(tree, expressions):
    """The step's grouped rows, unordered and unpaginated, selecting other expressions."""
    query = b.without(tree, "order", "limit", "offset")
    query.set("expressions", expressions)
    return query


def one_where(relation, condition):
    """SELECT 1 from a relation where a condition holds, for EXISTS."""
    return exp.select(exp.Literal.number(1)).from_(relation, copy=False).where(condition, copy=False)


class AggregateVisitor(Visitor):
    kind = "aggregate"

    @staticmethod
    def accepts(step):
        return bool(step.tree.args.get("group")) or any(outer_aggregates(e) for e in step.expressions)

    def visit(self, step):
        group = step.tree.args.get("group")
        keys = group.expressions if group else []
        names = [f"_dp_group_{i}" for i in range(len(keys))]
        rows = step.base.copy()
        if keys:
            rows.where(self.group(step, keys, names), copy=False)
        context = self.tracer.contributions(step.columns + step.conditions, rows)
        aggregates = outer_aggregates(step.target)
        if len(aggregates) != 1:
            # Every referenced input cell participates; individual aggregate
            # extrema need separate explanation to distinguish ties precisely.
            if any(isinstance(a, EXTREMA) for a in aggregates):
                raise Coverage(
                    "Split expressions combining multiple extrema into separate output columns for exact tie explanations."
                )
            return Trace(self.tracer.contributions(step.columns, rows), context)
        aggregate = aggregates[0]
        argument = self.argument(aggregate)
        predicates = self.predicates(step, aggregate, argument, keys, names)
        if predicates:
            rows.where(*predicates, copy=False)
        distinct = None
        if isinstance(aggregate, exp.Count) and isinstance(aggregate.this, exp.Distinct):
            distinct = distinct_values(rows, argument)
        return Trace(self.tracer.contributions(step.columns, rows), context, distinct)

    def group(self, step, keys, names):
        """Rows of the explained row's group, from captured group values or matching output rows."""
        if self.tracer.dataset.groups:
            hidden = self.tracer.dataset.groups.values()
            return b.every(
                b.same(key.copy(), self.tracer.recorded(name)) for key, name in zip(keys, hidden, strict=True)
            )
        aliased = [key.as_(name, quoted=True) for key, name in zip(keys, names, strict=True)]
        projections = [*(p.copy() for p in step.projections), *aliased]
        groups = b.select_from(grouped(step.tree, projections), "matched_groups")
        groups.where(step.matching.copy(), copy=False)
        equal = b.every(
            b.same(key.copy(), b.column(name, "g")) for key, name in zip(keys, names, strict=True)
        )
        return b.exists(one_where(groups.subquery("g", copy=False), equal))

    @staticmethod
    def argument(aggregate):
        argument = aggregate.this
        if not isinstance(argument, exp.Distinct):
            return argument
        if len(argument.expressions) != 1:
            raise Coverage("Multi-expression distinct aggregates are not yet supported.")
        return argument.expressions[0]

    def predicates(self, step, aggregate, argument, keys, names):
        """Conditions keeping the input rows that determine the aggregate value."""
        found = []
        filtered = aggregate.parent if isinstance(aggregate.parent, exp.Filter) else None
        if filtered and not step.all_context:
            found.append(filtered.expression.this.copy())
        if argument is None or isinstance(argument, exp.Star):
            return found
        if not step.all_context:
            found.append(b.not_null(argument.copy()))
            if isinstance(aggregate, EXTREMA):
                # The aggregate's value can be part of a larger expression.
                found.append(self.extreme(step, filtered or aggregate, argument, keys, names))
        if step.distinct_value is not ...:
            found.append(b.same(argument.copy(), b.value(step.distinct_value)))
        return found

    @staticmethod
    def extreme(step, aggregate, argument, keys, names):
        """Rows whose argument equals the MIN or MAX of the explained row's group."""
        aliased = [key.as_(name, quoted=True) for key, name in zip(keys, names, strict=True)]
        extremes = grouped(step.tree, [aggregate.as_("_dp_extreme"), *aliased]).subquery("x", copy=False)
        equal = [b.same(argument.copy(), b.column("_dp_extreme", "x"))]
        equal.extend(b.same(key.copy(), b.column(name, "x")) for key, name in zip(keys, names, strict=True))
        return b.exists(one_where(extremes, b.every(equal)))
