"""SQLGlot builders for provenance queries.

Builders take ownership of the nodes they receive, except `project` and `without`,
which copy their query. Pass a copy of a node that belongs to another tree or is reused.
"""

from decimal import Decimal
from functools import reduce

from sqlglot import exp

from ..util import literal


def identifier(name):
    return exp.to_identifier(name, quoted=True)


def table(name, alias=None):
    return exp.Table(this=identifier(name), alias=exp.TableAlias(this=identifier(alias)) if alias else None)


def column(name, table=None):
    return exp.Column(this=identifier(name), table=identifier(table) if table else None)


def rowid(table=None):
    """The physical row identity of a relation."""
    return exp.Column(this=exp.to_identifier("rowid"), table=identifier(table) if table else None)


def value(item):
    """A Python scalar as a SQL literal, rendered like `util.literal`."""
    if item is None:
        return exp.Null()
    if isinstance(item, bool):
        return exp.Boolean(this=item)
    if isinstance(item, (int, float, Decimal)):
        return exp.Literal(this=literal(item), is_string=False)
    return exp.Literal.string(str(item))


def same(left, right):
    """Null-safe equality."""
    return exp.NullSafeEQ(this=left, expression=right)


def not_null(expression):
    return exp.Not(this=exp.Is(this=expression, expression=exp.Null()))


def every(conditions):
    """The conjunction of conditions, TRUE when there are none."""
    conditions = list(conditions)
    return exp.and_(*conditions, copy=False) if conditions else exp.true()


def exists(query):
    return exp.Exists(this=query)


def project(query, expressions):
    """A copy of a query selecting other expressions."""
    query = query.copy()
    query.set("expressions", list(expressions))
    return query


def without(query, *clauses):
    """A copy of a query without the given clauses."""
    query = query.copy()
    for clause in clauses:
        query.set(clause, None)
    return query


def select_from(query, alias, *expressions):
    """Select expressions, all columns by default, from a query used as a derived table."""
    return exp.select(*(expressions or [exp.Star()])).from_(query.subquery(alias, copy=False), copy=False)


def union_all(queries):
    """Concatenate queries, or None when there is no query."""
    queries = list(queries)
    if not queries:
        return None
    return reduce(lambda left, right: exp.Union(this=left, expression=right, distinct=False), queries)
