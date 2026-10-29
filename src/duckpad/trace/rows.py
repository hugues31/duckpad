"""Row-preserving steps: projections, filters, joins and DISTINCT.

Each output row comes from one row of every source relation. The explained row's
captured witnesses, or else its unique matching occurrence, identify those rows.
"""

from . import builders as b
from .coverage import Coverage
from .step import Trace, Visitor


class RowVisitor(Visitor):
    def visit(self, step):
        tracer = self.tracer
        row_names = {alias: f"_dp_row_{i}" for i, alias in enumerate(tracer.sources)}
        identities = [b.rowid(alias).as_(name, quoted=True) for alias, name in row_names.items()]
        matched = tracer.matched(step, identities, row_names)
        if not tracer.dataset.witnesses and not step.tree.args.get("distinct") and tracer.count(matched) > 1:
            raise Coverage(
                "This composed SQL step has indistinguishable duplicate occurrences without captured row witnesses. Exact occurrence provenance is unavailable; use separate pipeline nodes for these stages."
            )
        return Trace(
            tracer.from_matched(step.columns, matched, row_names),
            tracer.from_matched(step.conditions, matched, row_names),
        )


class DistinctVisitor(RowVisitor):
    kind = "distinct"

    @staticmethod
    def accepts(step):
        return bool(step.tree.args.get("distinct"))


class JoinVisitor(RowVisitor):
    kind = "join"

    @staticmethod
    def accepts(step):
        return bool(step.tree.args.get("joins"))


class FilterVisitor(RowVisitor):
    kind = "filter"

    @staticmethod
    def accepts(step):
        return bool(step.tree.args.get("where"))


class ProjectionVisitor(RowVisitor):
    kind = "projection"

    @staticmethod
    def accepts(step):
        return True
