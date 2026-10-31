"""The explained cell, the relations it reads, and the dispatch to construct visitors."""

import contextlib

import duckdb
from sqlglot import exp

from ..datasets import Dataset
from ..materialize import drop_relations, plan_materialization, publish_view, to_physical
from ..sqlast import explained, sql
from ..util import digest, qi
from . import builders as b
from .aggregate import AggregateVisitor
from .describe import describe
from .normalize import normalize
from .rows import DistinctVisitor, FilterVisitor, JoinVisitor, ProjectionVisitor
from .set_operation import SetOperationVisitor
from .step import Step
from .window import WindowVisitor

# The first visitor accepting a SELECT traces it.
VISITORS = (WindowVisitor, AggregateVisitor, DistinctVisitor, JoinVisitor, FilterVisitor, ProjectionVisitor)


def render(query):
    return sql(query) if query is not None else ""


class TraceQuery:
    def __init__(self, context, cursor, dataset, row):
        self.context, self.cursor, self.dataset = context, cursor, dataset
        self.row = row
        self.sources = {}
        self.expression, self.kind = "", "projection"
        self.step = None

    def normalize(self, dataset):
        return normalize(self, dataset)

    def trace(self, tree, column_index, all_context=False, distinct_value=...):
        """Contribution and selection queries for one output column, and distinct value groups."""
        if isinstance(tree, exp.SetOperation):
            result = SetOperationVisitor(self).visit(tree, column_index)
        else:
            self.step = Step.analyze(self, tree, column_index, all_context, distinct_value)
            self.expression = explained(self.step.target)
            visitor = next(visitor for visitor in VISITORS if visitor.accepts(self.step))
            self.kind = visitor.kind
            result = visitor(self).visit(self.step)
        return render(result.contributions), render(result.context), result.distinct

    def describe(self, response):
        return describe(self, response)

    def virtual(self, query, owner, name):
        """Materialize an intermediate relation once, keyed by its owner and query."""
        key = "trace_" + digest([owner.id, sql(query), name])[:24]
        with self.context.trace_lock:
            if key in self.context.datasets:
                return self.context.datasets[key]
            data_inputs = {
                t.name: self.context.datasets[t.name]
                for t in query.find_all(exp.Table)
                if t.name in self.context.datasets
            }
            statement = {"table": key, "query": sql(query), "bindings": {}}
            plan = plan_materialization(self.cursor, statement, data_inputs)
            try:
                self.cursor.execute(plan["sql"])
                columns, mapping, _ = publish_view(self.cursor, key, plan)
                count = self.cursor.execute(f"SELECT count(*) FROM {qi(key)}").fetchone()[0]
            except BaseException:
                # An interrupted trace must not leave tables that block the next explanation.
                with contextlib.suppress(duckdb.Error):
                    drop_relations(self.cursor, key, plan["storage"])
                raise
            data = Dataset(
                id=key,
                node=owner.node,
                port=name,
                columns=columns,
                count=count,
                run=owner.run,
                query=sql(query),
                bindings={},
                dependencies={table: data.id for table, data in data_inputs.items()},
                fingerprint=owner.fingerprint,
                status=owner.status,
                storage=plan["storage"],
                column_map=mapping,
                witnesses=plan["witnesses"],
                groups=plan["groups"],
            )
            with self.context.lock:
                self.context.datasets[key] = data
            return data

    def bind(self, tree):
        """Record the relations a normalized SELECT reads and point it at their storage."""
        self.sources.update(to_physical(tree, self.context.datasets))
        return tree

    def lookup(self, relation, name, row):
        """One stored value of a materialized relation."""
        query = (
            exp.select(b.column(name))
            .from_(b.table(relation), copy=False)
            .where(exp.EQ(this=b.rowid(), expression=exp.Placeholder()), copy=False)
        )
        return self.cursor.execute(sql(query), [row]).fetchone()[0]

    def count(self, query):
        counted = b.select_from(query.copy(), "occurrences", exp.Count(this=exp.Star()))
        return self.cursor.execute(sql(counted)).fetchone()[0]

    def recorded(self, name):
        """One stored value of the explained row, as a subquery keeping its exact DuckDB type."""
        position = exp.EQ(this=b.rowid(), expression=exp.Literal.number(int(self.row)))
        query = exp.select(b.column(name)).from_(b.table(self.dataset.relation), copy=False)
        return query.where(position, copy=False).subquery(copy=False)

    def matches(self, names, alias=None):
        """Match each named relation column to the explained row's public value in order."""
        stored = [self.dataset.stored(c["name"]) for c in self.dataset.columns]
        return b.every(
            b.same(b.column(name, alias), self.recorded(column))
            for name, column in zip(names, stored, strict=True)
        )

    def witnesses(self, row_names):
        """Conditions pinning each relation's row identity to the explained row's captured witness."""
        return [
            b.same(
                b.column(row_names[alias]),
                b.value(self.lookup(self.dataset.relation, witness["column"], self.row)),
            )
            for alias, witness in self.dataset.witnesses.items()
            if alias in row_names
        ]

    def matched(self, step, additions, row_names):
        """Candidate rows of the step whose output values and witnesses match the explained row."""
        candidates = b.project(step.base, [*(p.copy() for p in step.projections), *additions])
        matching = b.every([step.matching.copy(), *self.witnesses(row_names)])
        return b.select_from(candidates, "candidates").where(matching, copy=False)

    def first_columns(self):
        """One column per source, standing for whole rows when no column is referenced."""
        return [
            b.column(data.stored(data.columns[0]["name"]), alias)
            for alias, data in self.sources.items()
            if data.columns
        ]

    def referenced(self, columns):
        """Source columns, each once, in order."""
        seen = set()
        for column in columns:
            key = (column.table, column.name)
            if column.table in self.sources and column.name != "*" and key not in seen:
                seen.add(key)
                yield column

    @staticmethod
    def original_column(data, name):
        """The public name of a stored column."""
        return next((original for original, stored in data.column_map.items() if stored == name), name)

    @staticmethod
    def contribution(data, row_id, name, value, source):
        """Projections yielding contribution records, in the column order Lineage.page reads."""
        records = {
            "dataset": b.value(data.id),
            "node": b.value(data.node),
            "port": b.value(data.port),
            "row_id": row_id,
            "column_name": b.value(name),
            "value": exp.Anonymous(this="to_json", expressions=[value]),
            "source": b.value(source),
        }
        return [expression.as_(alias, copy=False) for alias, expression in records.items()]

    def contributions(self, columns, query):
        """Contributions of columns over the rows a step query selects."""
        queries = []
        for column in self.referenced(columns):
            data = self.sources[column.table]
            name = self.original_column(data, column.name)
            records = self.contribution(data, b.rowid(column.table), name, column.copy(), data.source)
            queries.append(b.project(query, records).where(b.not_null(b.rowid(column.table)), copy=False))
        return b.union_all(queries)

    def from_matched(self, columns, matched, row_names, lists=False, predicate=None):
        """Contributions of columns from the stored rows whose identities matched rows captured."""
        queries = []
        for column in self.referenced(columns):
            alias, name = column.table, column.name
            data = self.sources[alias]
            identity = b.column(row_names[alias])
            if lists:
                identity = exp.Unnest(expressions=[identity])
            identities = b.select_from(matched.copy(), "witnesses", identity.as_("rid", copy=False))
            conditions = [b.rowid("d").isin(query=identities, copy=False)]
            if predicate:
                conditions.append(predicate(alias))
            records = self.contribution(
                data, b.rowid("d"), self.original_column(data, name), b.column(name, "d"), data.source
            )
            rows = exp.select(*records).from_(b.table(data.relation, "d"), copy=False)
            queries.append(rows.where(*conditions, copy=False))
        return b.union_all(queries)
