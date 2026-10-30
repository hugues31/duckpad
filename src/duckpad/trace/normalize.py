"""Rewrite one SQL step into a single SELECT or set operation over materialized relations.

CTEs, derived tables and the grouped stage of a grouped window become their own
explainable relations. The remaining SELECT is qualified and reads physical storage.
"""

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify

from ..materialize import outer_aggregates
from ..sqlast import is_volatile, sql
from . import builders as b
from .coverage import Coverage


def normalize(tracer, dataset):
    tree = parse(dataset)
    tree = materialize_ctes(tracer, tree, dataset)
    materialize_derived_tables(tracer, tree, dataset)
    if isinstance(tree, exp.SetOperation):
        return tree
    return resolve(tracer, tree, dataset)


def resolve(tracer, tree, owner):
    """Qualify a SELECT, give its grouped window input its own relation, and bind its sources."""
    tree = qualify_columns(tree, tracer.context.datasets)
    stage = grouped_stage(tree)
    if stage:
        return resolve(tracer, split_grouped_window(tracer, tree, owner, stage), owner)
    return tracer.bind(tree)


def parse(dataset):
    tree = sqlglot.parse_one(dataset.query, read="duckdb")
    if is_volatile(tree):
        raise Coverage(
            "Volatile expressions have no deterministic replay provenance. The displayed result is unchanged."
        )
    return tree.transform(
        lambda e: (
            exp.convert(dataset.bindings[e.name])
            if isinstance(e, exp.Placeholder) and e.name in dataset.bindings
            else e
        )
    )


def rename_tables(expression, tables):
    """Read the given relations instead of the named tables, keeping their aliases."""
    return expression.transform(
        lambda e: (
            exp.alias_(exp.to_table(tables[e.name]), e.alias_or_name, table=True)
            if isinstance(e, exp.Table) and e.name in tables
            else e
        )
    )


def materialize_ctes(tracer, tree, owner):
    with_ = tree.args.get("with_")
    if not with_:
        return tree
    if with_.args.get("recursive"):
        raise Coverage("Recursive CTE lineage is not yet supported.")
    tables = {}
    for cte in with_.expressions:
        data = tracer.virtual(rename_tables(cte.this.copy(), tables), owner, cte.alias)
        tables[cte.alias] = data.table
    tree.set("with_", None)
    return rename_tables(tree, tables)


def materialize_derived_tables(tracer, tree, owner):
    """Materialize derived tables separately, preserving their own explainable query."""
    for subquery in list(tree.find_all(exp.Subquery)):
        if isinstance(subquery.parent, (exp.From, exp.Join)):
            data = tracer.virtual(subquery.this, owner, subquery.alias_or_name or "subquery")
            subquery.replace(
                exp.alias_(exp.to_table(data.table), subquery.alias_or_name or data.table, table=True)
            )


def qualify_columns(tree, datasets):
    schema = {}
    for table in tree.find_all(exp.Table):
        data = datasets.get(table.name)
        if data is None:
            raise Coverage("A SQL relation is not an available materialized dependency.")
        schema[table.name] = {c["name"]: c["type"] for c in data.columns}
    try:
        return qualify(tree, dialect="duckdb", schema=schema)
    except Exception as error:
        raise Coverage(f"Column resolution is not supported for this SQL step: {error}") from error


def grouped_stage(tree):
    """Group keys and aggregates a window reads, by SQL, when the SELECT groups rows.

    SQL evaluates grouped aggregates before windows. That stage gets its own
    explainable relation instead of replaying a window over raw rows.
    """
    if not tree.find(exp.Window):
        return {}
    aggregates = outer_aggregates(tree)
    nested = [
        a for a in tree.find_all(exp.AggFunc) if a.find_ancestor(exp.Window) and a.find_ancestor(exp.AggFunc)
    ]
    group = tree.args.get("group")
    if not (group or aggregates or nested):
        return {}
    keys = group.expressions if group else []
    return {sql(e): e for e in [*keys, *aggregates, *nested]}


def split_grouped_window(tracer, tree, owner, stage):
    """The windows of a grouped SELECT, over a relation holding its group keys and aggregates."""
    names = {key: f"_dp_group_value_{i}" for i, key in enumerate(stage)}
    inner = b.without(tree, "order", "limit", "offset", "distinct", "qualify")
    inner.set("expressions", [e.copy().as_(names[key]) for key, e in stage.items()])
    data = tracer.virtual(inner, owner, "grouped_window_input")
    outer = b.without(tree, "group", "having", "where", "joins")
    outer.set("from_", exp.From(this=exp.to_table(data.table)))
    return outer.transform(lambda e: exp.column(names[sql(e)]) if sql(e) in names else e)
