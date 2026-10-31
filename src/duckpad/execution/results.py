"""Result statuses, paginated previews and compiled SQL of a worktree's nodes."""

from __future__ import annotations

import threading

from .. import variables
from ..catalog import Catalog, redact
from ..components import expand, expand_for, in_subtree
from ..datasets import Context, Dataset
from ..graph import connection_references
from ..projects import Projects
from ..store import Store
from ..templates import compile_template
from ..types import Record, RunToken
from ..util import Problem, clean, qi
from .contexts import ContextPool

MAX_PREVIEW_ROWS = 10_000


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
    ) -> Record:
        context, dataset = self.find_dataset(worktree, environment, node, port)
        columns = [c["name"] for c in dataset.columns]
        if sort and sort not in columns:
            raise Problem("Unknown sort column")
        where, values = [], []
        for column, value in (filters or {}).items():
            if column not in columns:
                raise Problem("Unknown filter column")
            where.append(f"CAST({qi(dataset.stored(column))} AS VARCHAR) ILIKE ?")
            values.append("%" + str(value) + "%")
        condition = " WHERE " + " AND ".join(where) if where else ""
        order = f"{qi(dataset.stored(sort))} {'DESC' if descending else 'ASC'}, rowid" if sort else "rowid"
        relation = qi(dataset.relation)
        with context.lock:
            assert context.db is not None
            cursor = context.db.cursor()
            projection = ", ".join(qi(dataset.stored(c)) for c in columns)
            try:
                count_row = cursor.execute(f"SELECT COUNT(*) FROM {relation}{condition}", values).fetchone()
                assert count_row is not None
                count = count_row[0]
                rows = cursor.execute(
                    f"SELECT rowid, {projection} FROM {relation}{condition} ORDER BY {order} LIMIT ? OFFSET ?",
                    [*values, max(1, min(limit, MAX_PREVIEW_ROWS)), max(0, offset)],
                ).fetchall()
                run = self.store.get("run", dataset.run)
                return {
                    **dataset.public(),
                    "rows": [{"id": row[0], "values": clean(row[1:])} for row in rows],
                    "filtered_count": count,
                    "offset": offset,
                    "executed_sql": run["nodes"][dataset.node].get("statements", []),
                    "results": run["nodes"][dataset.node].get("results", []),
                    "commit": run["commit"],
                    "environment": environment,
                    "error": context.errors.get(dataset.node),
                }
            finally:
                cursor.close()

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
