"""SQLGlot helpers shared by materialization planning and lineage tracing."""

from sqlglot import exp

# Functions whose results differ between evaluations; their rows have no replayable witnesses.
VOLATILE_FUNCTIONS = (exp.Rand, exp.Uuid, exp.CurrentTimestamp, exp.CurrentDate)


def sql(expression):
    return expression.sql(dialect="duckdb")


def is_volatile(tree):
    return any(isinstance(node, VOLATILE_FUNCTIONS) for node in tree.walk())


def has_filtering_join(tree):
    """Whether a SEMI or ANTI join selects rows without contributing columns."""
    return any(join.args.get("kind") in ("SEMI", "ANTI") for join in tree.find_all(exp.Join))


def has_grouping_sets(group):
    """Whether a GROUP BY clause uses GROUPING SETS, CUBE or ROLLUP."""
    return any(group.args.get(key) for key in ("grouping_sets", "cube", "rollup"))
