"""Describe the captured calculation without inferring operations from equal values."""

from sqlglot import exp

from ..sqlast import explained, sql
from ..util import Problem
from . import builders as b

OPERATIONS = (exp.Sum, exp.Avg, exp.Min, exp.Max, exp.Count)


def describe(tracer, response):
    step = tracer.step
    if step is None:
        return {"operation": tracer.kind, "formula": tracer.expression, "passthrough": False}
    display = Display(tracer, step.tree)
    calculation = {
        "operation": "expression",
        "formula": explained(display(step.target)),
        "passthrough": isinstance(step.target, exp.Column)
        and tracer.kind in {"projection", "filter", "join"}
        and response["total"] == 1,
    }
    selection = [explained(display(predicate)) for predicate in step.predicates()]
    selection.extend(group_selection(tracer, step, display))
    if selection:
        calculation["selection"] = selection
        evaluated_selection = []
        for predicate in step.predicates():
            operands = {
                (c.table, c.name): captured_operand(tracer, c, response.get("context", []))
                for c in predicate.find_all(exp.Column)
            }
            if any(value is None for value in operands.values()):
                continue
            evaluated_selection.append(
                explained(
                    predicate.transform(
                        lambda node, captured=operands: (
                            captured[(node.table, node.name)].copy() if isinstance(node, exp.Column) else node
                        )
                    )
                )
            )
        if evaluated_selection:
            calculation["selection_evaluated"] = evaluated_selection
    operation = aggregate_operation(step.target)
    if operation:
        calculation["operation"] = operation
    evaluated = evaluate(tracer, step, response)
    if evaluated is not None:
        calculation["evaluated"] = explained(evaluated)
    return calculation


class Display:
    """Show expressions with public column names, qualified only when a name is ambiguous."""

    def __init__(self, tracer, tree):
        self.tracer = tracer
        self.aliases = {}
        for column in tree.find_all(exp.Column):
            if column.table:
                self.aliases.setdefault(column.name, set()).add(column.table)

    def __call__(self, expression):
        return expression.transform(self.column)

    def column(self, node):
        if not isinstance(node, exp.Column):
            return node
        data = self.tracer.sources.get(node.table)
        return exp.column(
            self.tracer.original_column(data, node.name) if data else node.name,
            table=node.table if len(self.aliases.get(node.name, set())) > 1 else None,
        )


def group_selection(tracer, step, display):
    """The group key values of the explained row, read from its captured group columns."""
    group = step.tree.args.get("group")
    if not group or not tracer.dataset.groups:
        return []
    selection = []
    for expression, stored in zip(group.expressions, tracer.dataset.groups.values(), strict=True):
        value = tracer.lookup(tracer.dataset.relation, stored, tracer.row)
        try:
            right = b.value(value)
        except (Problem, ValueError):
            continue
        comparison = exp.Is if value is None else exp.EQ
        selection.append(sql(comparison(this=display(expression), expression=right)))
    return selection


def aggregate_operation(target):
    aggregate = target.this if isinstance(target, exp.Filter) else target
    if not isinstance(aggregate, OPERATIONS):
        return None
    argument = aggregate.this
    if isinstance(argument, (exp.Column, exp.Star)):
        return aggregate.key
    if isinstance(aggregate, exp.Count) and isinstance(argument, exp.Distinct):
        return "count_distinct"
    return None


def evaluate(tracer, step, response):
    """The target expression with its operands replaced by their captured values.

    Only uniquely identified operands of a scalar expression are substituted. Aggregates,
    windows, paginated operands and ambiguous self-joins keep their formula.
    """
    target = step.target
    if tracer.operands:
        replacements = {
            expression: b.value(tracer.operand_values[key]) for key, expression, _ in tracer.operands
        }
        return target.transform(lambda node: replacements[node].copy() if node in replacements else node)
    if (
        target.find(exp.AggFunc, exp.Window)
        or response["offset"]
        or (response["total"] != len(response["contributions"]) and not tracer.dataset.witnesses)
    ):
        return None
    operands = {}
    for column in target.find_all(exp.Column):
        operand = captured_operand(tracer, column, response["contributions"])
        if operand is None:
            return None
        operands[(column.table, column.name)] = operand
    return target.transform(
        lambda node: operands[(node.table, node.name)].copy() if isinstance(node, exp.Column) else node
    )


def captured_operand(tracer, column, contributions):
    """The single input value a column of the explained row read, or None when it is ambiguous."""
    data = tracer.sources.get(column.table)
    if data is None:
        return None
    original = tracer.original_column(data, column.name)
    inputs = [item for item in contributions if item["dataset"] == data.id and item["column"] == original]
    witness = tracer.dataset.witnesses.get(column.table)
    if witness:
        witnessed_row = tracer.lookup(tracer.dataset.relation, witness["column"], tracer.row)
        if witnessed_row is None:
            return exp.Null()
        # A captured witness also identifies predicate operands absent from the value page.
        value = tracer.lookup(data.relation, column.name, witnessed_row)
        try:
            return b.value(value)
        except (Problem, ValueError):
            return None
    if len(inputs) != 1:
        return None
    value = tracer.lookup(data.relation, column.name, inputs[0]["row"])
    # Presentation metadata must not downgrade an otherwise valid explanation.
    try:
        return b.value(value)
    except (Problem, ValueError):
        return None
