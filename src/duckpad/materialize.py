"""Private storage and row witnesses, separate from the public SQL relation.

Only deterministic SELECTs with a proven cardinality-preserving augmentation
receive hidden witnesses. DISTINCT and set operations keep their native query.
Public views expose exactly the original columns, including a user column named
rowid. Hidden storage identities never become inputs to SELECT *.
"""

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify

from .util import qi, uid


def sql(expression):
    return expression.sql(dialect="duckdb")


def plan_materialization(cursor, statement, dependencies, instrument=True):
    query, bindings = statement["query"], statement["bindings"]
    if not instrument:
        storage = statement["table"] + "_storage"
        return {
            "storage": storage,
            "columns": None,
            "query": query,
            "sql": f"CREATE TABLE {qi(storage)} AS {query}",
            "witnesses": {},
            "groups": {},
        }
    columns = [{"name": c[0], "type": c[1]} for c in cursor.execute("DESCRIBE " + query, bindings).fetchall()]
    witnesses, groups = {}, {}
    tree = sqlglot.parse_one(query, read="duckdb")
    eligible = (
        instrument
        and isinstance(tree, exp.Select)
        and not any(tree.args.get(k) for k in ("distinct", "with_", "qualify"))
        and not tree.find(exp.Subquery)
        and not any(j.args.get("kind") in ("SEMI", "ANTI") for j in tree.find_all(exp.Join))
        and not any(
            isinstance(f, (exp.Rand, exp.Uuid, exp.CurrentTimestamp, exp.CurrentDate)) for f in tree.walk()
        )
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
            if grouping and not any(grouping.args.get(k) for k in ("grouping_sets", "cube", "rollup")):
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
                    table.set("this", exp.to_identifier(data.storage or data.table, quoted=True))
                query = sql(augmented)
        except (sqlglot.errors.SqlglotError, KeyError, IndexError):
            witnesses, groups = {}, {}
    storage = statement["table"] + "_storage"
    return {
        "storage": storage,
        "columns": columns,
        "query": query,
        "sql": f"CREATE TABLE {qi(storage)} AS {query}",
        "witnesses": witnesses,
        "groups": groups,
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
        cursor.execute(f"DROP VIEW IF EXISTS {qi(dataset.table)}")
        cursor.execute(f"DROP TABLE IF EXISTS {qi(dataset.storage)}")
    else:
        cursor.execute(f"DROP TABLE IF EXISTS {qi(dataset.table)}")
