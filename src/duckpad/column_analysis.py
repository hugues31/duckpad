"""Static SQL column dependencies. Never execute SQL or inspect row values."""

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import Scope, build_scope

from .sqlast import sql


class Incomplete(ValueError):
    """A construct whose column semantics we cannot prove."""


def unique(items):
    return list(dict.fromkeys(items))


def analyze(query, schema, labels=None, bindings=None):
    """Return each projection's value inputs separately from its row-selection inputs.

    Qualification expands stars (including EXCLUDE/REPLACE), join aliases and CTE aliases.
    References are resolved through scopes, never by matching unqualified column names.
    """
    tree = sqlglot.parse_one(query, read="duckdb")
    if not isinstance(tree, exp.Query):
        raise Incomplete("query")
    labels = labels or {}
    bindings = bindings or {}

    def display(expression):
        def readable(item):
            if isinstance(item, exp.Placeholder) and item.name in bindings:
                return exp.convert(bindings[item.name])
            if isinstance(item, exp.Identifier) and item.name in labels:
                return exp.to_identifier(labels[item.name], quoted=True)
            return item

        return sql(expression.transform(readable))

    if any(
        isinstance(item, (exp.Pivot, exp.Unnest))
        or (isinstance(item, exp.CTE) and item.args.get("recursive"))
        or (isinstance(item, exp.With) and item.args.get("recursive"))
        or (isinstance(item, exp.Anonymous) and item.name.upper() == "COLUMNS")
        or (isinstance(item, exp.Window) and item.args.get("alias"))
        for item in tree.walk()
    ):
        raise Incomplete("unsupported_construct")
    tree = qualify(tree, dialect="duckdb", schema=schema)
    root = build_scope(tree)
    if root is None:
        raise Incomplete("scope")
    scopes = {id(scope.expression): scope for scope in root.traverse()}
    for scope in scopes.values():
        if scope.is_correlated_subquery:
            raise Incomplete("correlated_subquery")
        for source in scope.sources.values():
            if isinstance(source, exp.Table) and source.name not in schema:
                raise Incomplete("external_relation")
    memo = {}

    def projection(scope, name):
        key = (id(scope), name.casefold())
        if key in memo:
            if memo[key] is None:
                raise Incomplete("recursive_reference")
            return memo[key]
        memo[key] = None
        query = scope.expression
        if isinstance(query, exp.SetOperation):
            left, right = scope.set_operation_scopes
            names = query.named_selects
            index = next((i for i, n in enumerate(names) if n.casefold() == name.casefold()), None)
            if index is None or query.args.get("by_name"):
                raise Incomplete("set_alignment")
            a = projection(left, left.expression.named_selects[index])
            b = projection(right, right.expression.named_selects[index])
            # EXCEPT/INTERSECT's right-hand rows decide membership, not output values.
            refs = unique(a[0] + b[0]) if isinstance(query, exp.Union) else a[0]
            result = (refs, query.copy(), False)
        elif isinstance(query, exp.Select):
            selected = next((s for s in query.selects if s.alias_or_name.casefold() == name.casefold()), None)
            if selected is None or selected.is_star:
                raise Incomplete("unknown_column")
            value = selected.this if isinstance(selected, exp.Alias) else selected
            refs, expression = resolve(scope, value, value_expression=True)
            result = (refs, expression, isinstance(expression, exp.Column))
        else:
            raise Incomplete("unsupported_scope")
        memo[key] = result
        return result

    def resolve(scope, expression, value_expression=False):
        refs = []

        def replace(item, collect):
            if isinstance(item, exp.Subquery):
                nested = scopes.get(id(item.this))
                if (
                    nested is None
                    or not isinstance(nested.expression, exp.Query)
                    or len(nested.expression.named_selects) != 1
                ):
                    raise Incomplete("subquery")
                found, _, _ = projection(nested, nested.expression.named_selects[0])
                if collect:
                    refs.extend(found)
                # Preserve scalar-subquery semantics in the displayed SQL. Inlining an
                # aggregate here would misleadingly turn it into an outer aggregate.
                return item.copy()
            if not isinstance(item, exp.Column):
                return item
            source = scope.sources.get(item.table)
            if isinstance(source, Scope):
                found, value, _ = projection(source, item.name)
                if collect:
                    refs.extend(found)
                return value.copy() if isinstance(value, exp.Column) else exp.Paren(this=value.copy())
            if isinstance(source, exp.Table) and source.name in schema:
                column = next((n for n in schema[source.name] if n.casefold() == item.name.casefold()), None)
                if column is None:
                    raise Incomplete("unknown_column")
                if collect:
                    refs.append((source.name, column))
                return exp.column(column, table=source.name, quoted=True)
            raise Incomplete("unresolved_column")

        # Transform visits the original nodes so subquery scopes keep their identities.
        def visit(item, collect=True):
            replacement = replace(item, collect)
            if replacement is not item:
                return replacement
            result = item.copy()
            for key, child in item.args.items():
                value_input = collect and not (
                    (isinstance(item, exp.Window) and key in {"partition_by", "order", "spec"})
                    or (isinstance(item, exp.Filter) and key == "expression")
                    or (value_expression and isinstance(item, exp.Order) and key == "expressions")
                )
                if isinstance(child, exp.Expression):
                    result.set(key, visit(child, value_input))
                elif isinstance(child, list):
                    result.set(
                        key, [visit(v, value_input) if isinstance(v, exp.Expression) else v for v in child]
                    )
            return result

        result = visit(expression)
        return unique(refs), result

    conditions = []
    seen = set()

    def selection(scope):
        if id(scope) in seen:
            return
        seen.add(id(scope))
        query = scope.expression
        if isinstance(query, exp.SetOperation):
            for child in scope.set_operation_scopes:
                selection(child)
            if not isinstance(query, exp.Union) or query.args.get("distinct"):
                refs = unique(
                    [
                        ref
                        for child in scope.set_operation_scopes
                        for name in child.expression.named_selects
                        for ref in projection(child, name)[0]
                    ]
                )
                conditions.append({"kind": query.key, "expression": query.key.upper(), "refs": refs})
        elif isinstance(query, exp.Select):
            clauses = [
                (key, query.args.get(key))
                for key in ("where", "group", "having", "qualify", "order", "limit", "offset")
            ]
            clauses.extend(("join", join.args.get("on")) for join in query.args.get("joins", []))
            if query.args.get("distinct"):
                distinct = query.args["distinct"]
                refs = (
                    resolve(scope, distinct.args["on"])[0]
                    if distinct.args.get("on")
                    else unique([ref for name in query.named_selects for ref in projection(scope, name)[0]])
                )
                conditions.append(
                    {"kind": "distinct", "expression": display(query.args["distinct"]), "refs": refs}
                )
            for kind, clause in clauses:
                if clause is not None:
                    # GROUP BY ALL depends on every non-aggregate projection.
                    if kind == "group" and clause.args.get("all"):
                        refs = unique(
                            [
                                ref
                                for s in query.selects
                                if not s.find(exp.AggFunc)
                                for ref in projection(scope, s.alias_or_name)[0]
                            ]
                        )
                        rendered = display(clause)
                    else:
                        refs, value = resolve(scope, clause)
                        rendered = display(value)
                    conditions.append({"kind": kind, "expression": rendered, "refs": refs})
        for _, source in scope.selected_sources.values():
            if isinstance(source, Scope):
                selection(source)
        for child in scope.subquery_scopes:
            selection(child)

    selection(root)

    def window_conditions(value):
        result = []
        clauses = [("aggregate_filter", item.expression) for item in value.find_all(exp.Filter)]
        clauses.extend(
            ("order", clause)
            for order in value.find_all(exp.Order)
            if order.find_ancestor(exp.Window) is None
            for clause in order.expressions
        )
        clauses.extend(
            ("window", clause)
            for window in value.find_all(exp.Window)
            for clause in [
                *window.args.get("partition_by", []),
                window.args.get("order"),
                window.args.get("spec"),
            ]
        )
        for kind, clause in clauses:
            if clause is not None:
                refs = unique([(c.table, c.name) for c in clause.find_all(exp.Column)])
                if any(table not in schema for table, _ in refs):
                    raise Incomplete("window_scope")
                result.append({"kind": kind, "expression": display(clause), "refs": refs})
        return result

    return [
        {
            "name": name,
            "refs": refs,
            "expression": display(value),
            "passthrough": passthrough,
            "selection": conditions + window_conditions(value),
        }
        for name in tree.named_selects
        for refs, value, passthrough in [projection(root, name)]
    ]
