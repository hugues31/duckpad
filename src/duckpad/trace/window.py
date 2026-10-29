"""Window functions: the explained row's frame selects contributing rows.

The step is replayed with instrumented copies of the window collecting the row
identities of each source in the frame, or the single row a navigation function reads.
"""

from sqlglot import exp

from . import builders as b
from .coverage import Coverage
from .step import Trace, Visitor, distinct_values

AGGREGATES = (exp.Sum, exp.Avg, exp.Min, exp.Max, exp.Count)
NAVIGATION = (exp.Lag, exp.Lead, exp.FirstValue, exp.LastValue, exp.NthValue)
RANKING = (exp.RowNumber, exp.Rank, exp.DenseRank, exp.PercentRank, exp.CumeDist, exp.Ntile)


class WindowVisitor(Visitor):
    kind = "window"

    @staticmethod
    def accepts(step):
        return step.target.find(exp.Window) is not None

    def visit(self, step):
        window, function, selection = self.window(step.target)
        columns = list(function.find_all(exp.Column))
        columns = columns or list((window.args.get("order") or window).find_all(exp.Column))
        columns = columns or self.tracer.first_columns()
        frames = {alias: f"_dp_frame_{i}" for i, alias in enumerate(self.tracer.sources)}
        currents = {alias: f"_dp_current_{i}" for i, alias in enumerate(self.tracer.sources)}
        additions = [
            self.frame(window, function, alias).as_(name, quoted=True) for alias, name in frames.items()
        ]
        additions.append(window.as_("_dp_window_value"))
        additions.extend(b.rowid(alias).as_(name, quoted=True) for alias, name in currents.items())
        matched = self.tracer.matched(step, additions, currents)
        context_columns = columns + step.conditions + list(window.find_all(exp.Column))
        context = self.tracer.from_matched(context_columns, matched, frames, lists=True)
        if step.all_context:
            return Trace(context, context)
        predicate = Predicate(function, selection, matched, step.distinct_value)
        contributions = self.tracer.from_matched(columns, matched, frames, lists=True, predicate=predicate)
        return Trace(contributions, context, self.distinct(function, selection, matched, frames))

    @staticmethod
    def window(target):
        """The single supported window of the target, its function and its FILTER condition."""
        windows = list(target.find_all(exp.Window))
        if len(windows) != 1:
            raise Coverage(
                "Expressions containing multiple independent windows require separate output columns."
            )
        window = windows[0]
        function, selection = window.this, None
        if isinstance(function, exp.Filter):
            function, selection = function.this, function.expression.this
        if not isinstance(function, AGGREGATES + NAVIGATION + RANKING):
            raise Coverage(f"Window function {function.key} does not yet have an exact provenance rule.")
        return window, function, selection

    @staticmethod
    def frame(window, function, alias):
        """The window instrumented to return the row identities of one source in the frame."""
        instrumented = window.copy()
        if isinstance(function, NAVIGATION):
            replacement = function.copy()
            replacement.set("this", b.rowid(alias))
            if replacement.args.get("default"):
                replacement.set("default", exp.Null())
            instrumented.set("this", replacement)
            return exp.Array(expressions=[instrumented])
        instrumented.set("this", exp.ArrayAgg(this=b.rowid(alias)))
        if isinstance(function, RANKING):
            instrumented.set("spec", None)
            instrumented.set("order", None)
        return instrumented

    def distinct(self, function, selection, matched, frames):
        """Distinct argument values of COUNT(DISTINCT ...) over the frame."""
        if not (isinstance(function, exp.Count) and isinstance(function.this, exp.Distinct)):
            return None
        if len(function.this.expressions) != 1:
            raise Coverage("Multi-expression distinct windows are not yet supported.")
        argument = function.this.expressions[0]
        aliases = {c.table for c in argument.find_all(exp.Column)}
        if len(aliases) != 1:
            raise Coverage("Distinct window arguments must reference one input relation.")
        alias = next(iter(aliases))
        frame = b.select_from(matched, "frames", exp.Unnest(expressions=[b.column(frames[alias])]))
        conditions = [b.rowid(alias).isin(query=frame)]
        if selection:
            conditions.append(selection)
        rows = exp.select(exp.Star()).from_(b.table(self.tracer.sources[alias].relation, alias))
        return distinct_values(rows.where(*conditions), argument)


class Predicate:
    """Per source, the frame rows that determine the window value.

    Called only for sources with contributing columns, so an argument spanning
    relations is reported only when its contributions are requested.
    """

    def __init__(self, function, selection, matched, distinct_value):
        self.function, self.selection = function, selection
        self.matched, self.distinct_value = matched, distinct_value

    def __call__(self, alias):
        clauses = []
        argument = self.function.this
        if isinstance(self.function, AGGREGATES) and argument and not isinstance(argument, exp.Star):
            if isinstance(argument, exp.Distinct):
                argument = argument.expressions[0]
            clauses.append(b.not_null(self.local(argument, alias)))
            if isinstance(self.function, (exp.Min, exp.Max)):
                chosen = b.select_from(self.matched, "chosen", exp.column("_dp_window_value")).limit(1)
                clauses.append(b.same(self.local(argument, alias), chosen.subquery()))
        if self.selection:
            clauses.append(self.local(self.selection, alias))
        if self.distinct_value is not ...:
            value = b.value(self.distinct_value)
            clauses.append(b.same(self.local(self.function.this.expressions[0], alias), value))
        return b.every(clauses)

    @staticmethod
    def local(expression, alias):
        """Evaluate a single-relation expression against each contributing stored row."""
        if any(c.table != alias for c in expression.find_all(exp.Column)):
            raise Coverage("Window arguments spanning joined relations require an intermediate projection.")
        return expression.transform(lambda e: b.column(e.name, "d") if isinstance(e, exp.Column) else e)
