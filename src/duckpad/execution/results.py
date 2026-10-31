"""Result statuses, paginated previews and compiled SQL of a worktree's nodes."""

from __future__ import annotations

import threading

import duckdb
import sqlglot
from sqlglot import exp

from .. import variables
from ..catalog import Catalog, redact
from ..components import expand, expand_for, in_subtree
from ..datasets import Context, Dataset
from ..graph import connection_references
from ..projects import Projects
from ..store import Store
from ..templates import VARIABLE_REFERENCE, compile_template
from ..types import Record, RunToken
from ..util import Problem, clean, qi
from .contexts import ContextPool
from .samples import (
    Sample,
    check_sample,
    reading,
    sample_bindings,
    sample_condition,
    sample_order,
    sample_query,
)

MAX_PREVIEW_ROWS = 10_000


def reads_only(sql: str, tables: set[str]) -> bool:
    """Whether a query reads only the given relations, besides its own common table expressions."""
    try:
        tree = sqlglot.parse_one(sql, read="duckdb")
    except sqlglot.errors.SqlglotError:
        return False
    if not isinstance(tree, exp.Query):
        return False
    local = {cte.alias_or_name for cte in tree.find_all(exp.CTE)}
    for table in tree.find_all(exp.Table):
        if not isinstance(table.this, exp.Identifier) or table.args.get("db") or table.args.get("catalog"):
            return False
        if table.name not in tables | local:
            return False
    return True


class Results:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        catalog: Catalog,
        pool: ContextPool,
        lock: threading.RLock,
        active: dict[str, RunToken],
    ) -> None:
        self.store, self.projects, self.catalog, self.pool = store, projects, catalog, pool
        # The engine lock and the active runs it guards.
        self.lock, self.active = lock, active

    def statuses(self, worktree: str, environment: str) -> Record:
        context = self.pool.get(worktree, environment)
        with context.lock:
            result = {
                node: {
                    "outputs": {port: dataset.public() for port, dataset in outputs.items()},
                    "error": context.errors.get(node),
                    "execution_status": context.node_status.get(node),
                }
                for node, outputs in context.outputs.items()
            }
            for node, error in context.errors.items():
                result.setdefault(
                    node, {"outputs": {}, "error": error, "execution_status": context.node_status.get(node)}
                )
                result[node]["error_run"] = context.result_runs.get(node)
            generations = {
                node: next(iter(context.outputs.get(node, {}).values())).run
                if context.outputs.get(node)
                else run
                for node, run in context.result_runs.items()
            }
        runs = {run: self.store.get("run", run) for run in set(generations.values())}
        for node, run_id in generations.items():
            state = runs[run_id]["nodes"][node]
            result.setdefault(node, {"outputs": {}, "error": None, "execution_status": state["status"]})
            result[node]["results"] = state.get("results", [])
            result[node]["result_run"] = run_id
        with self.lock:
            active = self.active.get(worktree)
        return {"nodes": result, "active": self.store.get("run", active["id"]) if active else None}

    def generation_valid(self, worktree: str, environment: str, dataset_id: str) -> bool:
        """Whether a result generation is still current, so a lineage view may keep using it."""
        context = self.pool.get(worktree, environment)
        with context.lock:
            dataset = context.datasets.get(dataset_id)
            return bool(dataset and dataset.status == "valid")

    def find_dataset(
        self, worktree: str, environment: str, node: str, port: str = "result"
    ) -> tuple[Context, Dataset]:
        context = self.pool.get(worktree, environment)
        dataset = context.outputs.get(node, {}).get(port)
        if not dataset:
            snapshot = self.projects.snapshot(worktree)
            if snapshot["bundle"]:
                _, _, boundaries = expand(snapshot["bundle"])
                target = boundaries.get(node, {}).get("outputs", {}).get(port)
                if target:
                    dataset = context.outputs.get(target[0], {}).get(target[1])
        if not dataset:
            raise Problem("No materialized result. Run this node to preview its output.", 404)
        return context, dataset

    def preview(
        self,
        worktree: str,
        environment: str,
        node: str,
        port: str = "result",
        limit: int = 100,
        offset: int = 0,
        sort: str | None = None,
        descending: bool = False,
        filters: Record | None = None,
        sample: Sample | None = None,
    ) -> Record:
        """A page of a node output's sample: first or random rows, filtered and sorted.

        The sample only selects which retained rows are shown; it never changes the result.
        """
        context, dataset = self.find_dataset(worktree, environment, node, port)
        columns = [c["name"] for c in dataset.columns]
        sample = sample or Sample()
        sample.order = sample_order(sample.order, columns)
        if sort:
            if sort not in columns:
                raise Problem("Unknown sort column")
            sample.order = sample.order or [(sort, "desc" if descending else "asc")]
        for column, value in (filters or {}).items():
            if column not in columns:
                raise Problem("Unknown filter column")
            sample.contains[column] = str(value)
        check_sample(sample.method, sample.rows, sample.seed)
        bundle = (
            self.projects.snapshot(worktree)["bundle"] if VARIABLE_REFERENCE.search(sample.filter) else None
        )
        condition, bindings = sample_condition(sample.filter, columns, bundle, environment)
        common, row, ordering = sample_query(dataset, sample, condition)
        bindings = sample_bindings(sample, columns, bindings)
        projection = ", ".join(qi(c) for c in columns)
        page = max(1, min(limit, MAX_PREVIEW_ROWS))
        with reading(context, [dataset]) as cursor:
            try:
                count_row = cursor.execute(common + "SELECT count(*) FROM matched", bindings).fetchone()
                assert count_row is not None
                matched = count_row[0]
                rows = cursor.execute(
                    common
                    + f"SELECT {qi(row)}, {projection} FROM chosen ORDER BY {ordering} "
                    + f"LIMIT {page} OFFSET {max(0, int(offset))}",
                    bindings,
                ).fetchall()
            except duckdb.InterruptException:
                raise
            except duckdb.Error as error:
                raise Problem(f"Cannot read this sample: {error}", 422) from error
        run = self.store.get("run", dataset.run)
        with context.lock:
            error = context.errors.get(dataset.node)
        return {
            **dataset.public(),
            "rows": [{"id": row[0], "values": clean(row[1:])} for row in rows],
            # Rows to page through: the sample's rows, or every matching row without a size.
            "filtered_count": matched if sample.rows is None else min(matched, sample.rows),
            "matched_count": matched,
            "offset": offset,
            "executed_sql": run["nodes"][dataset.node].get("statements", []),
            "results": run["nodes"][dataset.node].get("results", []),
            "commit": run["commit"],
            "environment": environment,
            "error": error,
        }

    def test_rows(
        self,
        worktree: str,
        environment: str,
        node: str,
        test: str,
        limit: int = 100,
        offset: int = 0,
    ) -> Record:
        """The failing rows of a data test, recomputed on demand from the retained result.

        The query is the one the run recorded for the displayed result; it must read only
        that result's outputs and inputs. Rows are paged and never stored.
        """
        context = self.pool.get(worktree, environment)
        with context.lock:
            outputs = dict(context.outputs.get(node, {}))
        if not outputs:
            raise Problem("No materialized result. Run this node to see its failing rows.", 404)
        datasets = list(outputs.values())
        if any(dataset.status != "valid" for dataset in datasets):
            raise Problem("This result is stale. Run the node again to see its failing rows.", 409)
        run = self.store.get("run", datasets[0].run)
        statement = next(
            (s for s in run["nodes"][node].get("statements", []) if s.get("test_name") == test), None
        )
        if statement is None:
            raise Problem("This test did not run for the displayed result", 404)
        readable = {dataset.id: dataset for dataset in datasets}
        with context.lock:
            for dataset in datasets:
                for dependency in dataset.dependencies.values():
                    source = context.datasets.get(dependency)
                    if source is None or source.status != "valid":
                        raise Problem("An input of this result was replaced. Run the node again.", 409)
                    readable[source.id] = source
        if not reads_only(statement["sql"], set(readable)):
            raise Problem("This test reads other resources; its failing rows cannot be recomputed", 422)
        bindings = statement.get("bindings") or {}
        query = f'SELECT * FROM ({statement["sql"]}) AS "_duckpad_test"'
        page = max(1, min(limit, MAX_PREVIEW_ROWS))
        with reading(context, readable.values()) as cursor:
            try:
                described = cursor.execute("DESCRIBE " + statement["sql"], bindings).fetchall()
                count_row = cursor.execute(f"SELECT count(*) FROM ({query})", bindings).fetchone()
                assert count_row is not None
                rows = cursor.execute(
                    f"{query} LIMIT {page} OFFSET {max(0, int(offset))}", bindings
                ).fetchall()
            except duckdb.InterruptException:
                raise
            except duckdb.Error as error:
                raise Problem(f"Cannot recompute the failing rows: {error}", 422) from error
        return {
            "test": test,
            "run": run["id"],
            "severity": statement.get("test_severity"),
            "output": statement.get("message_output"),
            "columns": [{"name": c[0], "type": c[1]} for c in described],
            "rows": [{"id": offset + index, "values": clean(row)} for index, row in enumerate(rows)],
            "filtered_count": count_row[0],
            "offset": offset,
        }

    def compile(self, worktree: str, environment: str, node_id: str) -> list[Record]:
        """The statements of a node subtree, compiled from the current files without running them."""
        snapshot = self.projects.snapshot(worktree)
        self.catalog.environment(environment)
        if not snapshot["bundle"]:
            raise Problem("Project files are invalid", 422, snapshot["diagnostics"])
        nodes, edges, _ = expand_for(snapshot["bundle"], environment, tolerant=False)
        selected = [key for key in nodes if in_subtree(key, node_id)]
        if not selected:
            raise Problem("Node not found", 404)
        output = []
        for key in selected:
            node = nodes[key]
            if node.get("error"):
                raise Problem(node["error"], 422)
            captured, secrets = self.pool.capture(worktree, connection_references(node), environment)
            inputs = {
                e["targetHandle"]: qi("input_" + e["source"].replace("::", "_") + "_" + e["sourceHandle"])
                for e in edges
                if e["target"] == key
            }
            for port in node["parsed"]["inputs"]:
                if port not in inputs:
                    raise Problem(f"Connect input {port} before compiling")
            input_schemas = {}
            context = self.pool.find(worktree, environment)
            if context:
                with context.lock:
                    for edge in edges:
                        if edge["target"] == key:
                            dataset = context.outputs.get(edge["source"], {}).get(edge["sourceHandle"])
                            if dataset:
                                input_schemas[edge["targetHandle"]] = dataset.columns
            statements = compile_template(
                node["parsed"],
                node.get("params", {}),
                inputs,
                {p: "output_" + p for p in node["parsed"]["outputs"]},
                captured,
                self.store.paths.exports(worktree, environment),
                input_schemas=input_schemas,
                variables=variables.expression_values(node),
            )
            for statement in statements:
                statement["sql"] = redact(statement["sql"], secrets)
            output.extend(variables.annotate(statements, node))
        return output
