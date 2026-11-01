"""Run admission, immutable launch snapshots, node execution and output publication."""

from __future__ import annotations

import copy
import threading
import time
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, cast

import duckdb

from .. import project_extensions, variables
from ..bundle import files_to_bundle, topological
from ..catalog import Catalog, redact
from ..components import expand_for, in_subtree
from ..data_preparation import failure_hint
from ..datasets import Context, Dataset
from ..graph import connection_references, reachable
from ..materialize import drop_dataset, drop_relations, plan_materialization, publish_view
from ..native import Cursor as NativeCursor
from ..projects import Projects
from ..store import Store
from ..templates import base_type, compile_template
from ..types import Connections, Record, RunToken, SQLCursor
from ..util import Problem, now, qi, uid
from .contexts import ContextPool, cancel_lineage, interrupt, wait_for_readers
from .exports import Exports
from .fingerprints import Fingerprints
from .messages import execute_messages, execute_test, result_counts

UNFINISHED_RUN_STATUSES = ("preparing", "running", "canceling")


@dataclass
class Execution:
    """State of one accepted run, owned by its worker thread."""

    token: RunToken
    context: Context
    run: Record
    nodes: dict[str, Record]
    edges: list[Record]
    order: list[str]
    captured: Connections
    secrets: list[str]
    fingerprints: dict[str, str]
    cursor: SQLCursor | None = None
    prepared: dict[str, Exception | None] = field(default_factory=dict)
    published: dict[str, dict[str, Dataset]] = field(default_factory=dict)

    @property
    def canceled(self) -> bool:
        return self.token["cancel"].is_set()


def run_outcome(statuses: set[str], canceled: bool) -> str:
    if canceled:
        return "canceled"
    failed = bool(statuses & {"failed", "blocked"})
    if failed and "success" in statuses:
        return "partial_failure"
    return "failed" if failed else "success"


def launch_scope(nodes: dict[str, Record], edges: list[Record], target: str | None = None) -> set[str]:
    """The nodes a launch computes: the whole project, or a node subtree and its upstream nodes."""
    if not target:
        return set(nodes)
    scope = {n for n in nodes if in_subtree(n, target)}
    if not scope:
        raise Problem("Node not found", 404)
    return reachable(scope, edges, upstream=True)


class Runner:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        catalog: Catalog,
        pool: ContextPool,
        exports: Exports,
        fingerprints: Fingerprints,
        lock: threading.RLock,
        active: dict[str, RunToken],
        *,
        isolated: bool,
    ) -> None:
        self.store, self.projects, self.catalog = store, projects, catalog
        self.pool, self.exports, self.fingerprints = pool, exports, fingerprints
        # The engine lock and the active run tokens by worktree that it guards.
        self.lock, self.active = lock, active
        self.isolated = isolated
        self.threads: list[threading.Thread] = []

    def recover(self) -> None:
        """Close runs left unfinished by a stopped backend; nothing is replayed."""
        for run in self.store.runs_with_statuses(UNFINISHED_RUN_STATUSES):
            run["status"] = "interrupted"
            run["error"] = (
                "The backend stopped before completion was confirmed. Manual recomputation is required."
            )
            for node in run["nodes"].values():
                if node["status"] in ("pending", "running"):
                    if node["status"] == "running" and node.get("kind") == "export":
                        node["external_outcome"] = "unknown"
                    node["status"] = "interrupted"
            self._persist(run, [])

    def launch(
        self,
        worktree: str,
        environment: str,
        target: str | None = None,
        entry_point: str = "api",
        *,
        requester: Record | None = None,
        job: Record | None = None,
        external_trigger: Record | None = None,
        idempotency: Record | None = None,
    ) -> Record:
        record = self.projects.get(worktree)
        if record.get("read_only") and job is None:
            raise Problem("Launch this worktree from its Job", 403)
        token: RunToken = {"id": uid("run_"), "cancel": threading.Event(), "cursor": None}
        self._admit(worktree, environment, token)
        try:
            execution = self._prepare(token, worktree, environment, target, entry_point)
            execution.run["requester"] = copy.deepcopy(requester)
            if job is not None:
                execution.run.update(trigger="job", job=copy.deepcopy(job), tag=job.get("tag"))
                execution.run["external_trigger"] = copy.deepcopy(external_trigger)
            self._persist(execution.run, execution.secrets, idempotency=idempotency)
            thread = threading.Thread(target=self._execute, args=(execution,), name=token["id"], daemon=True)
            with self.lock:
                self.threads = [t for t in self.threads if t.is_alive()] + [thread]
            thread.start()
            return cast(Record, self.store.get("run", token["id"]))
        except Exception:
            with self.lock:
                self.active.pop(worktree, None)
            raise

    def _admit(self, worktree: str, environment: str, token: RunToken) -> None:
        """Reserve the worktree for a run; a busy worktree refuses it instead of queuing it."""
        with self.lock:
            self.catalog.environment(environment)
            if worktree in self.active:
                raise Problem(
                    "This worktree already has an active execution. Wait or stop it before running again.",
                    409,
                    {"run": self.active[worktree]["id"]},
                )
            self.active[worktree] = token

    def _prepare(
        self, token: RunToken, worktree: str, environment: str, target: str | None, entry_point: str
    ) -> Execution:
        """Capture the committed definitions and connection settings the run will use."""
        snapshot = self.projects.flush(worktree)
        bundle = copy.deepcopy(snapshot["bundle"])
        if bundle is None:
            raise Problem(
                "Project files are invalid; correct them before execution", 422, snapshot["diagnostics"]
            )
        nodes, edges, _ = expand_for(bundle, environment)
        scope = launch_scope(nodes, edges, target)
        order = [n for n in topological(nodes, edges, tolerant=True) if n in scope]
        self._check_conflicts(snapshot["conflicts"], scope, environment)
        captured, secrets = self._capture_connections(
            worktree, nodes, scope, environment, strict=bool(target)
        )
        fingerprints = self.fingerprints.of(bundle, environment, captured)
        context = self.pool.get(
            worktree,
            environment,
            create=True,
            requirements=project_extensions.enabled(bundle.get("extensions")),
        )
        affected = reachable(scope, edges, upstream=False)
        self.exports.mark_stale(worktree, environment, affected - scope)
        with context.lock:
            cancel_lineage(context, affected)
            for dataset in context.datasets.values():
                if dataset.node in affected:
                    dataset.status = "stale"
        run = {
            "id": token["id"],
            "worktree": worktree,
            "project": snapshot["worktree"]["project"],
            "branch": snapshot["worktree"]["branch"],
            "environment": environment,
            "commit": snapshot["commit"],
            "revision": snapshot["revision"],
            "scope": target or "project",
            "trigger": "manual",
            "entry_point": entry_point,
            "status": "preparing",
            "started": now(),
            "nodes": {
                n: {
                    "status": "pending",
                    "label": nodes[n].get("label", n),
                    "kind": nodes[n]["parsed"]["kind"],
                    "fingerprint": fingerprints[n],
                    "results": [],
                    **variables.run_usages(nodes[n]),
                }
                for n in order
            },
            "variables": variables.used(bundle, nodes, scope, environment),
            "connections": {
                ref: {"definition": c["definition"], "settings": c["settings"], "name": c["name"]}
                for ref, c in captured.items()
            },
            "definitions": bundle["templates"],
            "node_sql": bundle.get("node_sql", {}),
            "components": bundle["components"],
            "flow": bundle["flow"],
            "variable_declarations": bundle.get("variables"),
            "extensions": bundle.get("extensions"),
        }
        return Execution(token, context, run, nodes, edges, order, captured, secrets, fingerprints)

    def scope_variables(self, worktree: str, environment: str, target: str | None = None) -> Record:
        """Variables a launch would use, with their values and sources in this environment."""
        self.catalog.environment(environment)
        snapshot = self.projects.snapshot(worktree)
        if snapshot["bundle"] is None:
            return {}
        nodes, edges, _ = expand_for(snapshot["bundle"], environment)
        return variables.used(snapshot["bundle"], nodes, launch_scope(nodes, edges, target), environment)

    def _check_conflicts(self, conflicts: list[Record], scope: set[str], environment: str) -> None:
        """Reject a run when a pending edit conflict would change a node in its scope."""
        for conflict in conflicts:
            try:
                current = self.fingerprints.of(files_to_bundle(conflict["current"]), environment)
                proposed = self.fingerprints.of(files_to_bundle(conflict["proposal"]), environment)
                computation_conflict = any(current.get(n) != proposed.get(n) for n in scope)
            except Exception:
                computation_conflict = True
            if computation_conflict:
                raise Problem("Resolve computation-affecting edit conflicts before running", 409)

    def _capture_connections(
        self, worktree: str, nodes: dict[str, Record], scope: set[str], environment: str, strict: bool
    ) -> tuple[Connections, list[str]]:
        """Freeze connection settings for the scope; invalid ones block their nodes (or the run if strict)."""
        captured: Connections = {}
        secrets: list[str] = []
        for key in scope:
            node = nodes[key]
            try:
                values, hidden = self.pool.capture(worktree, connection_references(node), environment)
                captured.update(values)
                secrets.extend(hidden)
            except Problem as error:
                node["error"] = str(error)
            if strict and node.get("error"):
                raise Problem(node["error"], 422)
        return captured, secrets

    def cancel(self, run_id: str) -> Record:
        run = self.store.get("run", run_id)
        if not run:
            raise Problem("Execution not found", 404)
        with self.lock:
            token = self.active.get(run["worktree"])
            if not token or token["id"] != run_id:
                return cast(Record, self.store.get("run", run_id))
            token["cancel"].set()
            cursor = token["cursor"]
        if cursor:
            interrupt(cursor)
        # The run's later writes keep this status; its final write replaces it.
        with self.store.transaction():
            run = self.store.get("run", run_id)
            if run["status"] in ("preparing", "running"):
                run["status"] = "canceling"
                self.store.put("run", run_id, run)
        return cast(Record, run)

    def _persist(self, run: Record, secrets: list[str], *, idempotency: Record | None = None) -> None:
        run["warning_count"] = sum(
            result_counts(state.get("results", []))["warning"] for state in run["nodes"].values()
        )

        def sanitize(value: Any) -> Any:
            if isinstance(value, str):
                return redact(value, secrets)
            if isinstance(value, dict):
                return {key: sanitize(item) for key, item in value.items()}
            if isinstance(value, list):
                return [sanitize(item) for item in value]
            return value

        with self.store.transaction():
            # Check inside the write, which serializes with a cancellation request's own update.
            token = self.active.get(run["worktree"])
            if (
                token
                and token["id"] == run["id"]
                and token["cancel"].is_set()
                and run["status"] in ("preparing", "running")
            ):
                run["status"] = "canceling"
            self.store.put("run", run["id"], sanitize(run))
            if idempotency is not None:
                self.store.remember_job_launch(idempotency, run["id"], time.time())
            replaced = self.exports.record(run)
        self.exports.discard(replaced)
        context = self.pool.find(run["worktree"], run["environment"])
        if context:
            with context.lock:
                context.node_status.update({key: state["status"] for key, state in run["nodes"].items()})

    def _execute(self, execution: Execution) -> None:
        run, secrets, context = execution.run, execution.secrets, execution.context
        started = time.monotonic()
        try:
            assert context.db is not None
            execution.cursor = context.db.cursor()
            if not self.isolated:
                execution.cursor = NativeCursor(execution.cursor)
            execution.token["cursor"] = execution.cursor
            run["status"] = "running"
            self._persist(run, secrets)
            self.pool.forget_removed(context, execution.nodes)
            for key in execution.order:
                state = run["nodes"][key]
                skipped = self._skip_reason(execution, key)
                if skipped:
                    state.update(skipped)
                    if "error" in skipped:
                        with context.lock:
                            context.errors[key] = skipped["error"]
                            context.result_runs[key] = run["id"]
                    self._persist(run, secrets)
                    continue
                self._run_node(execution, key)
            run["status"] = run_outcome({n["status"] for n in run["nodes"].values()}, execution.canceled)
        except Exception as error:
            run.update(
                status="canceled" if execution.canceled else "failed",
                error=redact(str(error), secrets),
            )
            for state in run["nodes"].values():
                if state["status"] in ("pending", "running"):
                    state["status"] = "canceled" if execution.canceled else "blocked"
        finally:
            execution.token["cursor"] = None
            if execution.cursor:
                # A concurrent interrupt of this closed cursor is ignored.
                with suppress(duckdb.Error, Problem):
                    execution.cursor.close()
            with self.lock:
                try:
                    if execution.canceled:
                        run["status"] = "canceled"
                    run.update(finished=now(), duration=time.monotonic() - started)
                    self._persist(run, secrets)
                finally:
                    self.active.pop(context.worktree, None)

    @staticmethod
    def _skip_reason(execution: Execution, key: str) -> dict[str, str] | None:
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

    def _run_node(self, execution: Execution, key: str) -> None:
        run, secrets, context = execution.run, execution.secrets, execution.context
        node, state = execution.nodes[key], run["nodes"][key]
        state.update(status="running", started=now(), parameters=node.get("params", {}))
        if node["parsed"]["kind"] == "export":
            state["external_outcome"] = "unknown"
        self._persist(run, secrets)
        node_start = time.monotonic()
        created_tables: list[tuple[str, str]] = []
        try:
            staged = self._compute(execution, key, created_tables)
            if execution.canceled:
                raise Problem("Execution canceled after the active SQL operation ended")
            previous = self._publish(execution, key, staged)
            created_tables.clear()
            self._retire(execution, key, previous)
            state.update(status="success", outputs={p: d.public() for p, d in staged.items()})
            try:
                self._prune_documentation(execution, key, staged)
            except Exception as error:
                state["documentation_error"] = str(error)
        except Exception as error:
            self._drop_staged(context, created_tables)
            types = {base_type(p["type"]) for p in node["parsed"]["parameters"]}
            message = redact(str(error), secrets) + failure_hint(types)
            state.update(status="canceled" if execution.canceled else "failed", error=message)
            with context.lock:
                context.errors[key] = message
            if state.get("kind") == "export" and state.get("external_outcome") != "completed":
                state["external_outcome"] = (
                    "partial or unknown" if state.get("external_started") else "failed"
                )
        state.update(finished=now(), duration=time.monotonic() - node_start)
        self._persist(run, secrets)
        with context.lock:
            context.result_runs[key] = run["id"]

    @staticmethod
    def _drop_staged(context: Context, created_tables: list[tuple[str, str]]) -> None:
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

    def _prepare_connections(self, execution: Execution, node: Record) -> None:
        """Prepare each logical connection once per run, replaying its first failure."""
        for reference in connection_references(node):
            if reference not in execution.prepared:
                try:
                    if not self.isolated:
                        self.catalog.prepare(execution.cursor, {reference: execution.captured[reference]})
                    execution.prepared[reference] = None
                except Exception as error:
                    execution.prepared[reference] = error
            failure = execution.prepared[reference]
            if failure is not None:
                raise failure

    def _compute(
        self, execution: Execution, key: str, created_tables: list[tuple[str, str]]
    ) -> dict[str, Dataset]:
        """Execute a node's statements into freshly named tables; return its staged outputs."""
        cursor, context, run = execution.cursor, execution.context, execution.run
        assert cursor is not None
        node, state = execution.nodes[key], run["nodes"][key]
        self._prepare_connections(execution, node)
        input_datasets = {
            e["targetHandle"]: execution.published[e["source"]][e["sourceHandle"]]
            for e in execution.edges
            if e["target"] == key
        }
        physical = {port: uid("data_") for port in node["parsed"]["outputs"]}
        directory = self.store.paths.exports(context.worktree, context.environment)
        directory.mkdir(parents=True, exist_ok=True)
        statements = compile_template(
            node["parsed"],
            node.get("params", {}),
            {port: qi(data.table) for port, data in input_datasets.items()},
            physical,
            execution.captured,
            directory,
            input_schemas={port: data.columns for port, data in input_datasets.items()},
            variables=variables.expression_values(node),
        )
        state["statements"] = variables.annotate(statements, node)
        self._persist(run, execution.secrets)
        staged: dict[str, Dataset] = {}
        check_failure = None
        for statement in statements:
            if execution.canceled:
                raise Problem("Execution canceled")
            if statement.get("message_block") or statement.get("test_name"):
                execute_check = execute_test if statement.get("test_name") else execute_messages
                failure = execute_check(
                    cursor, statement, run, key, execution.secrets, lambda: execution.canceled
                )
                if check_failure is None:
                    check_failure = failure
                self._persist(run, execution.secrets)
                continue
            if not statement["output"]:
                if check_failure is not None:
                    raise Problem(check_failure or "An execution check reported an error")
                self._export(execution, key, statement)
                continue
            table = statement["table"]
            data_inputs = {data.table: data for data in [*input_datasets.values(), *staged.values()]}
            plan = plan_materialization(
                cursor, statement, data_inputs, instrument=node["parsed"]["kind"] != "source"
            )
            statement["materialization_sql"] = [plan["sql"]]
            self._persist(run, execution.secrets)
            cursor.execute(plan["sql"], statement["bindings"])
            created_tables.append((table, plan["storage"]))
            columns, column_map, view_sql = publish_view(cursor, table, plan)
            statement["materialization_sql"].extend(view_sql)
            count_row = cursor.execute(f"SELECT count(*) FROM {qi(table)}").fetchone()
            assert count_row is not None
            count = count_row[0]
            staged[statement["output"]] = Dataset(
                id=table,
                node=key,
                port=statement["output"],
                columns=columns,
                count=count,
                run=run["id"],
                query=statement["query"],
                bindings=statement["bindings"],
                labels=statement.get("variable_bindings", {}),
                dependencies={data.table: data.id for data in data_inputs.values()},
                fingerprint=execution.fingerprints[key],
                storage=plan["storage"],
                source=node["parsed"]["kind"] == "source",
                column_map=column_map,
                witnesses=plan["witnesses"],
                groups=plan["groups"],
            )
        if check_failure is not None:
            raise Problem(check_failure or "An execution check reported an error")
        return staged

    def _export(self, execution: Execution, key: str, statement: Record) -> None:
        """Run an export statement, then keep a private copy of the file it wrote for download."""
        state = execution.run["nodes"][key]
        # Serialize file writes and capture across worktrees sharing a destination.
        with self.exports.write_lock:
            if execution.canceled:
                raise Problem("Execution canceled")
            state["external_started"] = True
            assert execution.cursor is not None
            execution.cursor.execute(statement["sql"], statement["bindings"])
            if statement.get("export_file"):
                state["artifact"] = self.exports.capture(
                    statement["export_file"], execution.run, key, execution.captured
                )
        state["external_outcome"] = "completed"

    def _publish(self, execution: Execution, key: str, staged: dict[str, Dataset]) -> dict[str, Dataset]:
        """Atomically replace a node's outputs; return the previous output set."""
        context = execution.context
        # A later edit must not turn a result for the old snapshot valid.
        with self.projects.locked(context.worktree):
            current = self.fingerprints.current(context.worktree, context.environment)
            with self.lock, context.lock:
                if execution.canceled:
                    raise Problem("Execution canceled before publication")
                previous = context.outputs.get(key, {})
                for dataset in staged.values():
                    if current.get(key) != dataset.fingerprint:
                        dataset.status = "stale"
                    context.datasets[dataset.id] = dataset
                context.outputs[key] = staged
                context.errors.pop(key, None)
                execution.published[key] = staged
        return previous

    def _retire(self, execution: Execution, key: str, previous: dict[str, Dataset]) -> None:
        """Drop replaced outputs and their lineage tables once no lineage reader uses them."""
        context = execution.context
        for dataset in previous.values():
            wait_for_readers(context, {dataset.node})
            with context.lock:
                traces = [
                    d
                    for d in context.datasets.values()
                    if d.id.startswith("trace_") and d.node == key and d.run != execution.run["id"]
                ]
                assert context.db is not None
                cleanup = context.db.cursor()
                try:
                    for old in [dataset, *traces]:
                        drop_dataset(cleanup, old)
                        context.datasets.pop(old.id, None)
                finally:
                    cleanup.close()

    def _prune_documentation(self, execution: Execution, key: str, staged: dict[str, Dataset]) -> None:
        """Remove documentation of columns that the node's current outputs no longer have."""
        context = execution.context
        columns = {
            port: [c["name"] for c in data.columns] for port, data in staged.items() if data.status == "valid"
        }
        if not columns:
            return

        def current(bundle: Record) -> bool:
            fingerprint = self.fingerprints.of(bundle, context.environment).get(key)
            return fingerprint == execution.fingerprints[key]

        self.projects.prune_column_documentation(context.worktree, key, columns, current)

    def close(self) -> None:
        """Cancel active runs and wait for their workers."""
        with self.lock:
            tokens, threads = list(self.active.values()), list(self.threads)
        for token in tokens:
            self.cancel(token["id"])
        for thread in threads:
            thread.join()
