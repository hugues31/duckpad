"""One normalized SELECT step, analyzed for the explained output column."""

from dataclasses import dataclass
from typing import Any, NamedTuple

from sqlglot import exp

from ..sqlast import has_filtering_join, has_grouping_sets, sql
from . import builders as b
from .coverage import Coverage


class Trace(NamedTuple):
    """Provenance queries of one output column: its contributions, the cells selecting them,
    and the clauses lineage groups distinct values by, as (FROM clause, value expression)."""

    contributions: exp.Query | None
    context: exp.Query | None
    distinct: tuple[str, str] | None = None


def distinct_values(rows, argument):
    """The Trace.distinct clauses: argument values over the rows a query selects."""
    values = b.project(rows, [argument.as_("_dp_distinct_value", quoted=True)])
    return sql(exp.From(this=values.subquery("_dp_distinct"))), "_dp_distinct_value"


def unalias(expression):
    return expression.this if isinstance(expression, exp.Alias) else expression


def check_supported(tree):
    if not isinstance(tree, exp.Select):
        raise Coverage("Lineage currently expects SELECT or a set operation at this step.")
    if tree.args.get("qualify"):
        raise Coverage("QUALIFY lineage is not yet supported; use a nested SELECT for this step.")
    if has_filtering_join(tree):
        raise Coverage("SEMI/ANTI join selection provenance is not yet supported; use an explicit join step.")
    if tree.args.get("group") and has_grouping_sets(tree.args["group"]):
        raise Coverage("Grouping sets, ROLLUP and CUBE provenance is not yet supported.")


def cell_columns(tracer, tree, target):
    """Columns the target computes from, and columns of the conditions selecting its rows."""
    columns = list(target.find_all(exp.Column))
    if not columns and target.find(exp.AggFunc, exp.Window):
        columns = tracer.first_columns()
    conditions = [
        column
        for node in (tree.args.get("where"), *tree.args.get("joins", []))
        if node
        for column in node.find_all(exp.Column)
    ]
    for filtered in target.find_all(exp.Filter):
        selection = list(filtered.expression.find_all(exp.Column))
        columns = [c for c in columns if not any(c is selected for selected in selection)]
        conditions.extend(selection)
    return columns, conditions


@dataclass
class Step:
    tree: exp.Select
    target: exp.Expression
    expressions: list
    # Every output expression, aliased to a positional name.
    projections: list
    # Positional output values equal the explained row's values.
    matching: exp.Expression
    # The rows of the step before grouping: its FROM, joins and WHERE, without projection.
    base: exp.Select
    # Columns of the target expression, without those of its FILTER clauses.
    columns: list
    # Columns of WHERE, join and FILTER conditions, which select contributing rows.
    conditions: list
    all_context: bool
    distinct_value: Any

    @classmethod
    def analyze(cls, tracer, tree, column_index, all_context=False, distinct_value=...):
        check_supported(tree)
        expressions = [unalias(e) for e in tree.expressions]
        if len(expressions) != len(tracer.dataset.columns):
            # Such steps publish their native query without row witnesses.
            raise Coverage(
                "Projections expanding into several columns, such as COLUMNS(...), struct.* or UNNEST of a struct, do not yet have exact provenance."
            )
        target = expressions[column_index]
        names = [f"_dp_value_{i}" for i in range(len(expressions))]
        columns, conditions = cell_columns(tracer, tree, target)
        return cls(
            tree=tree,
            target=target,
            expressions=expressions,
            projections=[e.as_(name, quoted=True) for e, name in zip(expressions, names, strict=True)],
            matching=tracer.matches(names),
            base=b.without(tree, "group", "having", "order", "limit", "offset", "distinct", "qualify"),
            columns=columns,
            conditions=conditions,
            all_context=all_context,
            distinct_value=distinct_value,
        )

    def predicates(self):
        """WHERE, join and FILTER conditions of the target."""
        found = []
        if self.tree.args.get("where"):
            found.append(self.tree.args["where"].this)
        found.extend(join.args["on"] for join in self.tree.args.get("joins", []) if join.args.get("on"))
        found.extend(filtered.expression.this for filtered in self.target.find_all(exp.Filter))
        return found


class Visitor:
    """Traces the explained cell through one SQL construct."""

    kind = ""

    def __init__(self, tracer):
        self.tracer = tracer

    @staticmethod
    def accepts(step):
        raise NotImplementedError

    def visit(self, step):
        raise NotImplementedError
