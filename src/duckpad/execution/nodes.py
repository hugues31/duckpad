"""SQL node execution, staging and external writes."""

from __future__ import annotations

import copy
import threading
import time
from typing import TYPE_CHECKING

import duckdb

from .. import project_extensions, variables
from ..catalog import redact
from ..data_preparation import failure_hint
from ..datasets import Context, Dataset
from ..graph import connection_references
from ..materialize import (
    collected_pass_through,
    drop_relations,
    plan_materialization,
    publish_view,
)
from ..partition_filters import filter_statements
from ..projects import Projects
from ..sql_errors import SqlSourceError
from ..store import Store
from ..types import Record
from ..util import Problem, now, qi, uid
from ..value_types import base_type
from .contexts import ContextPool
from .exports import Exports
from .fingerprints import Fingerprints
from .journal import RunJournal
from .messages import execute_messages, execute_test
from .publication import Publication
from .python_nodes import PythonNodes
from .statements import compile_node, row_count, staged_dataset, statement_kind

if TYPE_CHECKING:
    from .launches import Execution


def failure_message(error: BaseException, node: Record, secrets: list[str]) -> str:
    """The error of a node's code as displayed: secrets masked, with guidance for its parameters."""
    types = {base_type(p["type"]) for p in node["parsed"]["parameters"]}
    return project_extensions.explain_missing(redact(str(error), secrets)) + failure_hint(types)


class NodeExecutor:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        pool: ContextPool,
        exports: Exports,
        fingerprints: Fingerprints,
        lock: threading.RLock,
        journal: RunJournal,
    ) -> None:
        self.store, self.pool, self.exports, self.journal = store, pool, exports, journal
        self.publication = Publication(projects, pool, fingerprints, lock, journal)
        self.python = PythonNodes(store, exports, journal)

    def execute_nodes(self, execution: Execution, order: list[str]) -> None:
        for key in order:
            state = execution.run["nodes"][key]
            skipped = self.skip_reason(execution, key)
            if skipped:
                state.update(skipped)
                if "error" in skipped:
                    with execution.context.lock:
                        execution.context.errors[key] = skipped["error"]
                        execution.context.result_runs[key] = execution.run["id"]
                self.journal.persist(execution.run, execution.secrets)
            else:
                self.run_node(execution, key)

    @staticmethod
    def skip_reason(execution: Execution, key: str) -> dict[str, str] | None:
        """Return the state update for a node that must not start, if any."""
        if execution.canceled:
            return {"status": "canceled"}
        node = execution.nodes[key]
        if node.get("error"):
            return {"status": "blocked", "error": node["error"]}
        failed = [
            e["source"]
            for e in execution.edges
            if e["target"] == key and execution.run["nodes"][e["source"]]["status"] != "success"
        ]
        if failed:
            return {"status": "blocked", "error": "Blocked by " + ", ".join(failed)}
        return None

    def run_node(self, execution: Execution, key: str) -> None:
        run, secrets, context = execution.run, execution.secrets, execution.context
        node, state = execution.nodes[key], run["nodes"][key]
        state.update(status="running", started=now(), parameters=node.get("params", {}))
        if node["parsed"]["writes_external"]:
            state["external_outcome"] = "unknown"
        self.journal.persist(run, secrets)
        node_start = time.monotonic()
        created_tables: list[tuple[str, str]] = []
        try:
            staged = self.compute(execution, key, created_tables)
            if execution.canceled:
                raise Problem("Execution canceled after the active SQL operation ended")
            previous = self.publication.publish(execution, key, staged)
            created_tables.clear()
            self.publication.retire(execution, key, previous)
            state.update(
                status="success",
                outputs={p: {**d.public(), "duration": d.duration} for p, d in staged.items()},
            )
            try:
                self.publication.prune_documentation(execution, key, staged)
            except Exception as error:
                state["documentation_error"] = str(error)
        except Exception as error:
            if state.get("artifact"):
                artifact = state.pop("artifact")
                self.exports.discard([artifact])
            self.drop_staged(context, created_tables)
            message = failure_message(error, node, secrets)
            if isinstance(error, SqlSourceError) and not execution.canceled:
                state["diagnostic"] = {**error.diagnostic, "message": message, "source": node["template_sql"]}
            state.update(status="canceled" if execution.canceled else "failed", error=message)
            with context.lock:
                context.errors[key] = message
            if state.get("writes_external") and state.get("external_outcome") != "completed":
                state["external_outcome"] = (
                    "partial or unknown" if state.get("external_started") else "failed"
                )
        state.update(finished=now(), duration=time.monotonic() - node_start)
        self.journal.persist(run, secrets)
        with context.lock:
            context.result_runs[key] = run["id"]

    @staticmethod
    def drop_staged(context: Context, created_tables: list[tuple[str, str]]) -> None:
        """Drop the tables of a node that failed before publication."""
        if not created_tables:
            return
        try:
            assert context.db is not None
            cleanup = context.db.cursor()
            try:
                for table, storage in created_tables:
                    drop_relations(cleanup, table, storage)
            finally:
                cleanup.close()
        except (duckdb.Error, Problem):
            # A dead worker has already discarded its tables.
            pass

    def prepare_connections(self, execution: Execution, node: Record) -> None:
        """Prepare each logical connection once per run, replaying its first failure."""
        with execution.preparing:
            for reference in connection_references(node):
                if reference not in execution.prepared:
                    try:
                        assert execution.cursor is not None
                        self.pool.connections.prepare(
                            execution.cursor, {reference: execution.captured[reference]}, execution.secrets
                        )
                        execution.prepared[reference] = None
                    except Exception as error:
                        execution.prepared[reference] = error
                failure = execution.prepared[reference]
                if failure is not None:
                    raise failure

    def compute(
        self, execution: Execution, key: str, created_tables: list[tuple[str, str]]
    ) -> dict[str, Dataset]:
        """Execute a node's statements into freshly named tables; return its staged outputs."""
        cursor, context, run = execution.cursor, execution.context, execution.run
        assert cursor is not None
        node, state = execution.nodes[key], run["nodes"][key]
        self.prepare_connections(execution, node)
        input_datasets = {
            e["targetHandle"]: execution.published[e["source"]][e["sourceHandle"]]
            for e in execution.edges
            if e["target"] == key
        }
        physical = {port: uid("data_") for port in node["parsed"]["outputs"]}
        project_files = self.store.paths.project_files(run["project"], context.worktree, context.environment)
        project_files["destination"].mkdir(parents=True, exist_ok=True)
        if node.get("language") == "python":
            return self.python.compute(
                execution, key, input_datasets, physical, project_files, created_tables
            )
        statements = compile_node(
            node,
            {port: qi(data.table) for port, data in input_datasets.items()},
            physical,
            execution.captured,
            project_files,
            {port: data.columns for port, data in input_datasets.items()},
        )
        # Locations map DuckDB errors back to the authored code; runs do not record them.
        locations = [statement.pop("source_location") for statement in statements]
        state["statements"] = variables.annotate(statements, node)
        self.journal.persist(run, execution.secrets)
        staged: dict[str, Dataset] = {}
        check_failure = None
        location: Record | None = None
        executed = ""
        try:
            for index, statement in enumerate(statements):
                location, executed = locations[index], statement["sql"]
                if execution.canceled:
                    raise Problem("Execution canceled")
                kind = statement_kind(statement)
                if kind in ("messages", "tests"):
                    if execution.schema_only:
                        continue
                    execute_check = execute_test if kind == "tests" else execute_messages
                    failure = execute_check(
                        cursor, statement, run, key, execution.secrets, lambda: execution.canceled
                    )
                    if check_failure is None:
                        check_failure = failure
                    self.journal.persist(run, execution.secrets)
                    continue
                if kind == "exports":
                    if execution.schema_only:
                        continue
                    if check_failure is not None:
                        raise Problem(check_failure or "An execution check reported an error")
                    self.export(execution, key, statement)
                    continue
                data_inputs = {data.table: data for data in [*input_datasets.values(), *staged.values()]}
                staged[statement["output"]] = self.materialize_output(
                    execution, key, statement, data_inputs, created_tables, location
                )
        except duckdb.Error as error:
            if location is None:
                raise
            raise SqlSourceError(error, location, executed) from error

        if check_failure is not None:
            raise Problem(check_failure or "An execution check reported an error")
        return staged

    def materialize_output(
        self,
        execution: Execution,
        key: str,
        statement: Record,
        data_inputs: dict[str, Dataset],
        created_tables: list[tuple[str, str]],
        location: Record,
    ) -> Dataset:
        """Stage one SQL output, retaining source locations for materialization errors."""
        cursor, run = execution.cursor, execution.run
        assert cursor is not None
        node = execution.nodes[key]
        executed = statement["sql"]
        try:
            table = statement["table"]
            if execution.partition is not None:
                filter_statements([statement], node, execution.partition, cursor)
            if execution.schema_only:
                statement["sql"] = f"SELECT * FROM ({statement['sql']}) AS empty_partition LIMIT 0"
            output_start = time.monotonic()
            collected = collected_pass_through(statement["sql"], data_inputs)
            if collected and not execution.schema_only:
                storage = table + "_disk"
                cursor.execute(f"CREATE VIEW {qi(storage)} AS SELECT * FROM {qi(collected.storage)}")
                created_tables.append((table, storage))
                projection = ", ".join(
                    f"{qi(collected.stored(c['name']))} AS {qi(c['name'])}" for c in collected.columns
                )
                cursor.execute(f"CREATE VIEW {qi(table)} AS SELECT {projection} FROM {qi(storage)}")
                return staged_dataset(
                    execution,
                    key,
                    statement["output"],
                    table,
                    collected.columns,
                    storage,
                    output_start,
                    count=collected.count,
                    query=statement["sql"],
                    bindings=statement["bindings"],
                    dependencies={collected.table: collected.id},
                    disk=True,
                    column_map=collected.column_map,
                    origins=copy.deepcopy(collected.origins),
                )
            executed = "DESCRIBE " + statement["sql"]
            plan = plan_materialization(cursor, statement, data_inputs, instrument=not statement["source"])
            statement["materialization_sql"] = [plan["sql"]]
            self.journal.persist(run, execution.secrets)
            executed = plan["sql"]
            cursor.execute(plan["sql"], statement["bindings"])
            created_tables.append((table, plan["storage"]))
            columns, column_map, view_sql = publish_view(cursor, table, plan)
            statement["materialization_sql"].extend(view_sql)
            count = row_count(cursor, table)
            source_columns = plan["columns"]
            if source_columns is None and any(
                s.get("node") == key and s.get("port") == statement["output"]
                for s in [*execution.sources.values(), execution.partition_plan.get("source") or {}]
            ):
                source_columns = [
                    {"name": c[0], "type": c[1]}
                    for c in cursor.execute("DESCRIBE " + statement["sql"], statement["bindings"]).fetchall()
                ]
            return staged_dataset(
                execution,
                key,
                statement["output"],
                table,
                columns,
                plan["storage"],
                output_start,
                count=count,
                query=statement["sql"],
                bindings=statement["bindings"],
                labels=statement.get("variable_bindings", {}),
                dependencies={data.table: data.id for data in data_inputs.values()},
                source_columns=source_columns or columns,
                source=statement["source"],
                column_map=column_map,
                witnesses=plan["witnesses"],
                groups=plan["groups"],
            )
        except duckdb.Error as error:
            raise SqlSourceError(error, location, executed) from error

    def export(self, execution: Execution, key: str, statement: Record) -> None:
        """Run an export statement, then keep a private copy of the file it wrote for download."""
        state = execution.run["nodes"][key]
        # Serialize file writes and capture across worktrees sharing a destination.
        with self.exports.writing(statement.get("export_file"), lambda: execution.canceled):
            state["external_started"] = True
            assert execution.cursor is not None
            execution.cursor.execute(statement["sql"], statement["bindings"])
            if statement.get("export_file"):
                state["artifact"] = self.exports.capture(
                    statement["export_file"], execution.run, key, execution.captured
                )
        state["external_outcome"] = "completed"
