"""Private storage and row witnesses, separate from the public SQL relation.

Only deterministic SELECTs with a proven cardinality-preserving augmentation
receive hidden witnesses, and only when DuckDB binds the augmented query to the
original columns. DISTINCT and set operations keep their native query.
Public views expose exactly the original columns, including a user column named
rowid. Hidden storage identities never become inputs to SELECT *.
"""

import duckdb
import sqlglot
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify

from .sqlast import has_filtering_join, has_grouping_sets, is_volatile, sql
from .util import qi, uid


def plan_materialization(cursor, statement, dependencies, instrument=True):
    query, bindings = statement["query"], statement["bindings"]
    storage = statement["table"] + "_storage"
    if not instrument:
        return _plan(storage, None, query)
    columns = [{"name": c[0], "type": c[1]} for c in cursor.execute("DESCRIBE " + query, bindings).fetchall()]
    witnesses, groups = {}, {}
    tree = sqlglot.parse_one(query, read="duckdb")
    eligible = (
        isinstance(tree, exp.Select)
        and not any(tree.args.get(k) for k in ("distinct", "with_", "qualify"))
        and not tree.find(exp.Subquery)
        and not has_filtering_join(tree)
        and not is_volatile(tree)
    )
    if eligible:
        tables = list(tree.find_all(exp.Table))
        eligible = all(t.name in dependencies for t in tables)
    if eligible:
        schema = {name: {c["name"]: c["type"] for c in data.columns} for name, data in dependencies.items()}
        try:
            augmented = qualify(tree.copy(), dialect="duckdb", schema=schema)
            # Qualification may synthesize aliases; retain DuckDB's own names.
            augmented.set(
                "expressions",
                [
                    (e.this if isinstance(e, exp.Alias) else e).copy().as_(columns[i]["name"], quoted=True)
                    for i, e in enumerate(augmented.expressions)
                ],
            )
            aliases = {t.alias_or_name: dependencies[t.name] for t in augmented.find_all(exp.Table)}
            grouping = augmented.args.get("group")
            has_aggregate = any(a.find_ancestor(exp.Window) is None for a in augmented.find_all(exp.AggFunc))
            if grouping and not has_grouping_sets(grouping):
                for expression in grouping.expressions:
                    hidden = uid("__dp_group_")
                    groups[sql(expression)] = hidden
                    augmented.append("expressions", expression.copy().as_(hidden, quoted=True))
            elif not grouping and not has_aggregate:
                for alias, data in aliases.items():
                    hidden = uid("__dp_witness_")
                    witnesses[alias] = {"column": hidden, "dataset": data.id}
                    augmented.append("expressions", exp.column("rowid", table=alias).as_(hidden, quoted=True))
            if witnesses or groups:
                # Rewrite original rowid columns before appending physical rowids.
                for column in augmented.find_all(exp.Column):
                    data = aliases.get(column.table)
                    is_witness = isinstance(column.parent, exp.Alias) and column.parent.alias in {
                        w["column"] for w in witnesses.values()
                    }
                    if data and not is_witness and column.name in data.column_map:
                        column.set("this", exp.to_identifier(data.column_map[column.name], quoted=True))
                for table in augmented.find_all(exp.Table):
                    data = dependencies[table.name]
                    table.set("this", exp.to_identifier(data.relation, quoted=True))
                instrumented = sql(augmented)
                if _binds_columns(cursor, instrumented, bindings, columns, len(augmented.expressions)):
                    query = instrumented
                else:
                    # Losing this node's lineage is better than publishing shifted columns.
                    witnesses, groups = {}, {}
        except (sqlglot.errors.SqlglotError, KeyError, IndexError):
            witnesses, groups = {}, {}
    return _plan(storage, columns, query, witnesses, groups)


def _binds_columns(cursor, query, bindings, columns, width):
    """Whether an instrumented query yields the original columns, then one per hidden alias.

    Positional aliases shift after an expression that expands to several columns, such
    as COLUMNS(...), struct.* or UNNEST(struct). Qualification can also rewrite valid
    DuckDB SQL into a query that no longer binds.
    """
    try:
        described = cursor.execute("DESCRIBE " + query, bindings).fetchall()
    except duckdb.InterruptException:
        raise
    except duckdb.Error:
        return False
    public = [{"name": c[0], "type": c[1]} for c in described[: len(columns)]]
    return public == columns and len(described) == width


def _plan(storage, columns, query, witnesses=None, groups=None):
    return {
        "storage": storage,
        "columns": columns,
        "query": query,
        "sql": f"CREATE TABLE {qi(storage)} AS {query}",
        "witnesses": witnesses or {},
        "groups": groups or {},
    }


def publish_view(cursor, table, plan):
    storage = plan["storage"]
    actual = cursor.execute(f"DESCRIBE {qi(storage)}").fetchall()
    if plan["columns"] is not None:
        actual = actual[: len(plan["columns"])]
    columns = [{"name": row[0], "type": row[1]} for row in actual]
    mapping = {}
    statements = []
    for column in columns:
        if column["name"].casefold() == "rowid":
            hidden = uid("__dp_user_")
            mapping[column["name"]] = hidden
            command = f"ALTER TABLE {qi(storage)} RENAME COLUMN {qi(column['name'])} TO {qi(hidden)}"
            cursor.execute(command)
            statements.append(command)
    projection = ", ".join(f"{qi(mapping.get(c['name'], c['name']))} AS {qi(c['name'])}" for c in columns)
    command = f"CREATE VIEW {qi(table)} AS SELECT {projection} FROM {qi(storage)}"
    cursor.execute(command)
    statements.append(command)
    return columns, mapping, statements


def drop_dataset(cursor, dataset):
    if dataset.storage:
        drop_relations(cursor, dataset.table, dataset.storage)
    else:
        cursor.execute(f"DROP TABLE IF EXISTS {qi(dataset.table)}")


def drop_relations(cursor, view, storage):
    """Drop a published view and the private storage table behind it."""
    cursor.execute(f"DROP VIEW IF EXISTS {qi(view)}")
    cursor.execute(f"DROP TABLE IF EXISTS {qi(storage)}")
