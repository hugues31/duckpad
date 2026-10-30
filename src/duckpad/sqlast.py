"""SQLGlot helpers shared by materialization planning and lineage tracing."""

import re

from sqlglot import exp

# Functions whose results differ between evaluations; their rows have no replayable witnesses.
VOLATILE_FUNCTIONS = (exp.Rand, exp.Uuid, exp.CurrentTimestamp, exp.CurrentDate)
# A comment on a literal that holds a project variable's bound value, naming the variable.
VARIABLE_LABEL = "duckpad-variable:"
LABEL_COMMENT = re.compile(r"\s*/\* " + re.escape(VARIABLE_LABEL) + r"(\w+) \*/")


def sql(expression):
    return expression.sql(dialect="duckdb")


def labeled(expression, name):
    """Mark an expression as the value of a project variable; `explained` shows the name."""
    expression.add_comments([VARIABLE_LABEL + name])
    return expression


def explained(expression):
    """SQL for explanations: a project variable's value is followed by its name, as `900 (threshold)`."""
    return LABEL_COMMENT.sub(r" (\1)", sql(expression))


def is_volatile(tree):
    return any(isinstance(node, VOLATILE_FUNCTIONS) for node in tree.walk())


def has_filtering_join(tree):
    """Whether a SEMI or ANTI join selects rows without contributing columns."""
    return any(join.args.get("kind") in ("SEMI", "ANTI") for join in tree.find_all(exp.Join))


def has_grouping_sets(group):
    """Whether a GROUP BY clause uses GROUPING SETS, CUBE or ROLLUP."""
    return any(group.args.get(key) for key in ("grouping_sets", "cube", "rollup"))
