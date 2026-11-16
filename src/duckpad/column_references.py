"""Resolve editable SQL identifier spans without serializing the author's SQL."""

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import Scope, build_scope
from sqlglot.tokens import TokenType

from .column_analysis import Incomplete, analyze


def query_tree(text):
    tree = sqlglot.parse_one(text, read="duckdb")
    if isinstance(tree, exp.Copy):
        tree = tree.this
    elif isinstance(tree, exp.Insert):
        tree = tree.expression
    if isinstance(tree, exp.Subquery):
        tree = tree.this
    if isinstance(tree, exp.Table):
        tree = exp.select("*").from_(tree.copy())
    if not isinstance(tree, exp.Query):
        raise Incomplete("unsupported_statement")
    return tree


def export_inputs(text, schema):
    return {ref for item in analyze(query_tree(text).sql(dialect="duckdb"), schema) for ref in item["refs"]}


def references(text, schema, renamed, *, definition=None, automatic=None):
    """Return spans to edit and output names which follow a rename.

    Explicit aliases form name boundaries. Generated aliases from qualification do
    not. Scopes keep unrelated same-named columns, CTEs and strings independent.
    """
    tree = query_tree(text)
    active_names = {name.casefold() for names in renamed.values() for name in names}
    if any(
        identifier.name.casefold() in active_names
        for star in tree.find_all(exp.Star)
        for identifier in star.find_all(exp.Identifier)
    ):
        raise Incomplete("star_modifiers")
    # Reuse the origin analysis' coverage boundary, including correlated queries.
    analyze(tree.sql(dialect="duckdb"), schema)
    if any(j.args.get("using") or j.args.get("method") == "NATURAL" for j in tree.find_all(exp.Join)):
        raise Incomplete("join_using")
    # SQLGlot removes explicit CTE column lists when qualifying: keep their name boundary.
    fixed = {
        c.alias: [i.name for i in c.args["alias"].args.get("columns", [])]
        for c in tree.find_all(exp.CTE, exp.Subquery)
        if c.args.get("alias") and c.args["alias"].args.get("columns")
    }
    spans, changed = set(), {}

    def mark(identifier):
        if identifier is not None and "start" in identifier.meta:
            spans.add((identifier.meta["start"], identifier.meta["end"] + 1))

    # WHERE, GROUP BY, HAVING and later projections may name the renamed output itself.
    # Qualification replaces such a reference by a copy of its expression, so it is located
    # first. The name designates the output only when no input of the query has it.
    sources = [s.this for s in [tree.args.get("from_"), *tree.args.get("joins", [])] if s is not None]
    if (
        definition is not None
        and isinstance(tree, exp.Select)
        and all(isinstance(t, exp.Table) and t.name in schema for t in sources)
        and not any(definition.casefold() == n.casefold() for t in sources for n in schema[t.name])
    ):
        for column in tree.find_all(exp.Column):
            if (
                not column.table
                and column.name.casefold() == definition.casefold()
                and column.find_ancestor(exp.Query) is tree
            ):
                mark(column.this)
    tree = qualify(tree, schema=schema, dialect="duckdb")
    root = build_scope(tree)
    if root is None:
        raise Incomplete("scope")

    for scope in root.traverse():

        def follows(column, scope=scope):
            if not isinstance(column, exp.Column):
                return False
            source = scope.sources.get(column.table)
            if isinstance(source, exp.Table):
                names = renamed.get(source.name, set())
            elif isinstance(source, Scope):
                names = changed.get(id(source), set())
            else:
                names = set()
            return column.name.casefold() in {n.casefold() for n in names}

        for column in scope.columns:
            if follows(column):
                mark(column.this)
        output = set()
        query = scope.expression
        if not isinstance(query, exp.Query):
            raise Incomplete("scope_query")
        if isinstance(query, exp.SetOperation):
            left = scope.set_operation_scopes[0]
            output = changed[id(left)].copy()
        else:
            for selected in query.selects:
                alias = selected.args.get("alias") if isinstance(selected, exp.Alias) else None
                value = selected.this if isinstance(selected, exp.Alias) else selected
                # Qualification lowercases every name; DuckDB compares them without case.
                forced = (
                    scope is root
                    and definition is not None
                    and selected.alias_or_name.casefold() == definition.casefold()
                )
                implicit = alias is None or "start" not in alias.meta
                if forced or (follows(value) and selected.alias_or_name == value.name):
                    output.add(selected.alias_or_name)
                    if forced or not implicit:
                        mark(alias if alias is not None else value.this)
                    if (
                        scope is root
                        and automatic is not None
                        and isinstance(value, exp.Column)
                        and not value.this.meta
                    ):
                        automatic.add(selected.alias_or_name)
            # ORDER BY aliases are deliberately not in Scope.columns.
            for column in query.find_all(exp.Column):
                if column.find_ancestor(exp.Query) is query and not column.table and column.name in output:
                    mark(column.this)
        parent = query.parent
        if isinstance(parent, (exp.CTE, exp.Subquery)) and parent.alias in fixed:
            output = set()
        changed[id(scope)] = output
    return sorted(spans), changed[id(root)]


def replace_spans(text, spans, name):
    for start, end in sorted(set(spans), reverse=True):
        # Keep the author's quoted/unquoted identifier style.
        keyword = sqlglot.tokenize(name, read="duckdb")[0].token_type != TokenType.VAR
        replacement = '"' + name + '"' if text[start:end].startswith('"') or keyword else name
        text = text[:start] + replacement + text[end:]
    return text


def local_alias(text, column, name):
    """Introduce a name at a carried output, without changing its input column.

    Return an insertion point in the rendered SQL. Complex star modifiers remain
    an explicit manual boundary rather than rewriting a projection approximately.
    """
    tree = sqlglot.parse_one(text, read="duckdb")
    if not isinstance(tree, exp.Select):
        raise Incomplete("output_alias")
    selected = next((s for s in tree.selects if s.alias_or_name.casefold() == column.casefold()), None)
    if isinstance(selected, exp.Alias):
        return None
    if isinstance(selected, exp.Column) and not selected.is_star:
        return selected.this.meta["end"] + 1, " AS " + '"' + name + '"'
    stars = [s for s in tree.selects if s.is_star]
    if len(stars) != 1 or tree.args.get("joins"):
        raise Incomplete("output_alias")
    star = stars[0].this if isinstance(stars[0], exp.Column) else stars[0]
    if any(star.args.values()):
        raise Incomplete("star_modifiers")
    depth, selecting = 0, False
    for token in sqlglot.tokenize(text, read="duckdb"):
        if token.token_type == TokenType.L_PAREN:
            depth += 1
        elif token.token_type == TokenType.R_PAREN:
            depth -= 1
        elif not depth and token.token_type == TokenType.SELECT:
            selecting = True
        elif not depth and token.token_type == TokenType.FROM:
            selecting = False
        elif not depth and selecting and token.token_type == TokenType.STAR:
            return token.end + 1, f' RENAME ("{column}" AS "{name}")'
    raise Incomplete("output_alias")
