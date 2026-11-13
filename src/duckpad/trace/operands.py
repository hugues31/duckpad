"""Independent operands of mixed scalar, aggregate and window expressions."""

from dataclasses import replace

from sqlglot import exp

from ..materialize import outer_aggregates
from ..sqlast import sql
from . import builders as b
from .coverage import Coverage
from .step import cell_columns


def parts(target):
    result = []

    def collect(node):
        if isinstance(node, (exp.Window, exp.AggFunc, exp.Column)) or (
            isinstance(node, exp.Filter) and node.find(exp.AggFunc)
        ):
            if node not in result:
                result.append(node)
            return
        for child in node.iter_expressions():
            collect(child)

    collect(target)
    # A direct aggregate already has its own contribution page.
    if not any(p.find(exp.AggFunc, exp.Window) for p in result) or result == [target]:
        return []
    return result


def trace_parts(tracer, step, visitors):
    result = []
    for index, expression in enumerate(parts(step.target)):
        columns, conditions = cell_columns(tracer, step.tree, expression)
        part = replace(step, target=expression, columns=columns, conditions=conditions)
        visitor = next(visitor for visitor in visitors if visitor.accepts(part))
        result.append((str(index), expression, visitor(tracer).visit(part)))
    return result


def values(tracer, step, expressions):
    """Evaluate operands over the exact captured row/group, never over just one page."""
    names = [f"_dp_operand_{i}" for i in range(len(expressions))]
    extra = [e.as_(name, quoted=True) for e, name in zip(expressions, names, strict=True)]
    conditions = [step.matching.copy()]
    if step.tree.args.get("group"):
        for index, (key, stored) in enumerate(
            zip(step.tree.args["group"].expressions, tracer.dataset.groups.values(), strict=True)
        ):
            name = f"_dp_key_{index}"
            extra.append(key.as_(name, quoted=True))
            conditions.append(b.same(b.column(name), tracer.recorded(stored)))
    elif not any(outer_aggregates(e) for e in step.expressions):
        row_names = {alias: f"_dp_row_{i}" for i, alias in enumerate(tracer.sources)}
        extra.extend(b.rowid(alias).as_(name, quoted=True) for alias, name in row_names.items())
        conditions.extend(tracer.witnesses(row_names))
    query = b.without(step.tree, "order", "limit", "offset")
    query.set("expressions", [*step.projections, *extra])
    query = b.select_from(query, "operands", *(b.column(name) for name in names))
    query.where(*conditions, copy=False).distinct(copy=False).limit(2, copy=False)
    rows = tracer.cursor.execute(sql(query)).fetchall()
    if len(rows) != 1:
        raise Coverage("The captured row does not uniquely identify the operands of this expression.")
    return rows[0]
