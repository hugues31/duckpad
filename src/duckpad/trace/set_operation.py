"""DISTINCT set operations: UNION, INTERSECT and EXCEPT.

Each side becomes its own materialized relation. Rows equal to the explained row
contribute; the right side of EXCEPT only provides context.
"""

from sqlglot import exp

from . import builders as b
from .coverage import Coverage
from .step import Trace, Visitor


class SetOperationVisitor(Visitor):
    def visit(self, tree, index):
        if tree.args.get("distinct") is False:
            raise Coverage(
                "Set operations with ALL preserve native results, but occurrence-level duplicate assignment is not yet covered. DISTINCT set operations are supported."
            )
        tracer = self.tracer
        tracer.kind = tree.key
        tracer.expression = tree.key.upper() + " · " + tracer.dataset.columns[index]["name"]
        queries, contexts = [], []
        for side, query in (("left", tree.this), ("right", tree.expression)):
            data = tracer.virtual(query, tracer.dataset, side)
            tracer.sources[side] = data
            columns = [data.stored(c["name"]) for c in data.columns]
            records = tracer.contribution(
                data, b.rowid("d"), data.columns[index]["name"], b.column(columns[index], "d"), False
            )
            rows = exp.select(*records).from_(b.table(data.relation, "d"), copy=False)
            if isinstance(tree, exp.Except) and side == "right":
                contexts.append(rows)
            else:
                queries.append(rows.where(tracer.matches(columns, "d"), copy=False))
        return Trace(b.union_all(queries), b.union_all(contexts))
