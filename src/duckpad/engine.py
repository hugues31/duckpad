"""Embedded execution service with atomic admission and immutable launch snapshots."""

import copy
import logging
import re
import threading
import time
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

from .artifacts import Artifacts
from .bundle import bundle_to_files, files_to_bundle, topological
from .catalog import redact
from .components import expand, in_subtree
from .data_preparation import PREPARATION_TYPES
from .datasets import Context, Dataset
from .extensions import MAX_UPLOAD_BYTES, database_config, install, runtime
from .materialize import drop_dataset, drop_relations, plan_materialization, publish_view
from .native import Cursor as NativeCursor
from .templates import URI, base_type, compile_template, executable_sql
from .util import Problem, clean, digest, now, qi, uid

logger = logging.getLogger(__name__)

UNFINISHED_RUN_STATUSES = ("preparing", "running", "canceling")
MAX_PREVIEW_ROWS = 10_000
# How often a run waits for lineage readers to release a replaced output.
READER_POLL_INTERVAL = 0.005
# URL prefixes that DuckDB scopes to each object storage secret type by default.
REMOTE_PREFIXES = {"s3": ("s3://", "s3a://", "s3n://"), "r2": ("r2://",), "gcs": ("gcs://", "gs://")}
SECRET_OPTIONS = re.compile(r"\bSECRET\s+\{\{\s*secret_name\s*\}\}\s*\(([^)]*)", re.IGNORECASE)
SECRET_TYPE = re.compile(r"\bTYPE\s+[\"']?(\w+)", re.IGNORECASE)


@dataclass
class Execution:
    """State of one accepted run, owned by its worker thread."""

    token: dict
    context: Context
    run: dict
    nodes: dict
    edges: list
    order: list
    captured: dict
    secrets: list
    fingerprints: dict
    cursor: object = None
    prepared: dict = field(default_factory=dict)
    published: dict = field(default_factory=dict)

    @property
    def canceled(self):
        return self.token["cancel"].is_set()


def connection_references(node):
    """Return the connection IDs selected by a node's connection parameters."""
    params = node.get("params", {})
    return [
        params.get(parameter["name"], parameter.get("default"))
        for parameter in node["parsed"]["parameters"]
        if parameter["type"] == "connection"
    ]


def reachable(seeds, edges, upstream):
    """Return the seeds and every node reachable against (upstream) or along the edges."""
    origin, destination = ("target", "source") if upstream else ("source", "target")
    result = set(seeds)
    while True:
        extended = result | {edge[destination] for edge in edges if edge[origin] in result}
        if extended == result:
            return result
        result = extended


def remote_prefixes(captured):
    """Remote URL prefixes covered by the connections' storage secret types, whatever their IDs."""
    prefixes = []
    for connection in captured.values():
        sql = re.sub(r"--[^\n]*|/\*.*?\*/", "", connection["definition"].get("init_sql", ""), flags=re.DOTALL)
        for options in SECRET_OPTIONS.findall(sql):
            for kind in SECRET_TYPE.findall(options):
                prefixes += [p for p in REMOTE_PREFIXES.get(kind.lower(), ()) if p not in prefixes]
    return prefixes


def interrupt(cursor):
    """Interrupt a cursor without waiting for its statement to stop.

    Cancellation persists in the cursor, and a cursor closed meanwhile has nothing left to stop.
    """

    def stop():
        with suppress(duckdb.Error, Problem):
            cursor.interrupt()

    threading.Thread(target=stop, name="interrupt", daemon=True).start()


def run_outcome(statuses, canceled):
    if canceled:
        return "canceled"
    failed = bool(statuses & {"failed", "blocked"})
    if failed and "success" in statuses:
        return "partial_failure"
    return "failed" if failed else "success"


class Engine:
    def __init__(self, store, projects, catalog, access=None, *, trusted_local=False):
        self.access = access
        # API authorization is independent of the explicitly selected SQL execution mode.
        self.isolated = access is not None and not trusted_local
        self.store, self.projects, self.catalog = store, projects, catalog
        self.lock = threading.RLock()
        self.export_lock = threading.Lock()
        self.artifacts = Artifacts(store)
        self.contexts, self.active = {}, {}
        self.threads = []
        for run in store.runs_with_statuses(UNFINISHED_RUN_STATUSES):
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

    def context(self, worktree, environment, create=False):
        """The live DuckDB context of an existing worktree in a configured environment.

        Its database starts outside the engine lock, so status and cancellation requests
        never wait for a worker, extension installation or connection setup.
        """
        key = (worktree, environment)
        while True:
            self.projects.get(worktree)
            if environment not in self.catalog.environment_names():
                raise Problem("Unknown environment", 404)
            with self.lock:
                context, stopped = self.contexts.get(key), None
                if context is None or getattr(context.db, "closed", False):
                    stopped = context and context.db
                    context = self.contexts[key] = Context(*key, db=None)
            if stopped:
                # Reap the replaced worker's process and release its descriptors.
                stopped.close()
            if context.db is not None or (self.access and not create):
                return context
            database = self._open(worktree, environment)
            with self.lock:
                if self.contexts.get(key) is context and context.db is None:
                    context.db = database
                    return context
            # Another request published its database first, or the context was discarded meanwhile.
            database.close()
            if self.contexts.get(key) is context:
                return context

    def _open(self, worktree, environment):
        extensions = self.store.home / "extensions"
        extensions.mkdir(exist_ok=True)
        config = {**database_config(extensions), **self.extension_settings()}
        if not self.isolated:
            return duckdb.connect(":memory:", config=config)
        from .sandbox import Database

        project = self.projects.get(worktree)["project"]
        captured, secrets = self._configured_connections(project, environment)
        roots, writable = self.access.local_roots(project, captured)
        directory = self.exports(worktree, environment)
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / ".temporary"
        temporary.mkdir(exist_ok=True)
        self._install_extensions(captured, config, secrets)
        try:
            return Database(
                {
                    "captured": captured,
                    "extensions": str(extensions),
                    "allow_unsigned_extensions": config["allow_unsigned_extensions"],
                    "offline_extensions": self.store.get("settings", "offline_extensions", {}),
                    "read_paths": [str(p) for p in roots],
                    "write_paths": [str(p) for p in [*writable, directory]],
                    "temporary": str(temporary),
                    "remote_paths": remote_prefixes(captured),
                }
            )
        except Problem as error:
            raise Problem(redact(str(error), secrets), error.status, error.detail) from None

    def _configured_connections(self, project, environment):
        """Capture the project's authorized connections that are fully configured for the environment.

        Creating an environment adds an empty configuration to every connection. A connection
        still missing required settings stays unavailable instead of failing every run; nodes
        that use it are blocked by their own capture error.
        """
        captured, secrets = {}, []
        for reference in self.access.record(project)["connections"]:
            try:
                values, hidden = self.catalog.capture([reference], environment)
            except Problem:
                continue
            captured.update(values)
            secrets.extend(hidden)
        return captured, secrets

    def _install_extensions(self, captured, config, secrets):
        """Provision trusted administrator-declared extensions before the worker gets read-only
        access to their cache. Connection setup, such as ATTACH, runs only in the worker."""
        declared = [c for c in captured.values() if c["definition"].get("extensions")]
        if not declared:
            return
        with duckdb.connect(config=config) as setup:
            for connection in declared:
                definition = {**connection["definition"], "init_sql": ""}
                try:
                    self.catalog.prepare(setup, {"extensions": {**connection, "definition": definition}})
                except duckdb.Error as error:
                    raise Problem(
                        f"Cannot install the extensions of connection {connection['name']}: "
                        + redact(str(error), secrets),
                        503,
                    ) from None

    def extension_settings(self):
        return {"allow_unsigned_extensions": self.store.get("settings", "allow_unsigned_extensions", False)}

    def extension_runtime(self):
        version, platform = runtime()
        return {
            "version": version,
            "platform": platform,
            "max_upload_bytes": MAX_UPLOAD_BYTES,
            "imports": list(self.store.get("settings", "offline_extensions", {}).values()),
        }

    def import_extension(self, filename, source, stream):
        with self.projects.lock, self.lock:
            if self.active:
                raise Problem("Stop active executions before importing extensions", 409)
            entry = install(
                self.store.home / "extensions",
                filename,
                source,
                stream,
                self.extension_settings()["allow_unsigned_extensions"],
                self.reset_catalog,
            )
            installed = self.store.get("settings", "offline_extensions", {})
            installed[entry["name"]] = entry
            self.store.put("settings", "offline_extensions", installed)
            return self.extension_runtime()

    def configure_extensions(self, allow_unsigned):
        with self.projects.lock, self.lock:
            if self.extension_settings()["allow_unsigned_extensions"] == allow_unsigned:
                return self.extension_settings()
            if self.active:
                raise Problem("Stop active executions before changing extension settings", 409)
            # Loaded native code cannot be unloaded from a live DuckDB instance.
            self.reset_catalog()
            self.store.put("settings", "allow_unsigned_extensions", allow_unsigned)
            return self.extension_settings()

    def capture(self, worktree, references, environment):
        if self.access:
            self.access.connections(self.projects.get(worktree)["project"], references)
        return self.catalog.capture(references, environment)

    def reset_catalog(self):
        with self.lock:
            if self.active:
                raise Problem("Stop active executions before changing connections", 409)
            for project in self.store.all("project"):
                self.reset_project(project["id"])

    def reset_project(self, project):
        with self.lock:
            worktrees = {w["id"] for w in self.store.worktrees(project)}
            if worktrees & self.active.keys():
                raise Problem(
                    "Stop active executions before changing project connections or deleting the project", 409
                )
            for worktree in worktrees:
                self.discard_worktree(worktree)

    def discard_worktree(self, worktree):
        """Release every environment context, even after its worktree was removed."""
        with self.lock:
            if worktree in self.active:
                raise Problem("Stop the worktree's execution before removing it", 409)
            for key, context in list(self.contexts.items()):
                if context.worktree == worktree:
                    with context.lock:
                        self.cancel_lineage(context)
                        if context.db:
                            context.db.close()
                        del self.contexts[key]

    def fingerprints(self, bundle, environment, captured=None):
        nodes, edges, _ = expand(bundle, tolerant=True)
        fingerprints = {}
        for key in topological(nodes, edges, tolerant=True):
            node = nodes[key]
            connections = {}
            for reference in connection_references(node):
                try:
                    values = captured or self.catalog.capture([reference], environment)[0]
                    connections[reference] = values[reference]["fingerprint"]
                except (Problem, KeyError) as error:
                    connections[reference] = "invalid:" + str(error)
            fingerprints[key] = digest(
                {
                    "sql": executable_sql(node["template_sql"]),
                    "error": node.get("error"),
                    "params": node.get("params", {}),
                    "connections": connections,
                    "inputs": [
                        (
                            e["targetHandle"],
                            e["source"],
                            e["sourceHandle"],
                            fingerprints.get(e["source"], "invalid"),
                        )
                        for e in edges
                        if e["target"] == key
                    ],
                }
            )
        return fingerprints

    def _current_fingerprints(self, worktree, environment):
        """Fingerprints of the committed files, or none when they cannot be expanded."""
        snapshot = self.projects.snapshot(worktree, committed=True)
        if snapshot["bundle"] is None:
            return {}
        try:
            return self.fingerprints(snapshot["bundle"], environment)
        except Exception:
            # Unreadable definitions invalidate every result rather than blocking the caller.
            logger.warning("Cannot fingerprint worktree %s", worktree, exc_info=True)
            return {}

    def invalidate(self, worktree=None):
        with self.projects.lock:
            with self.lock:
                contexts = list(self.contexts.values())
            for context in contexts:
                if worktree and context.worktree != worktree:
                    continue
                if not self.store.get("worktree", context.worktree):
                    self.discard_worktree(context.worktree)
                    continue
                fingerprints = self._current_fingerprints(context.worktree, context.environment)
                with context.lock:
                    changed = set()
                    for dataset in context.datasets.values():
                        if fingerprints.get(dataset.node) != dataset.fingerprint:
                            dataset.status = "stale"
                            changed.add(dataset.node)
                    self.cancel_lineage(context, changed)

    def cancel_lineage(self, context, affected=None):
        for request in list(context.lineage.values()):
            if affected is None or request["nodes"] & affected:
                request["canceled"].set()
                interrupt(request["cursor"])

    def statuses(self, worktree, environment):
        context = self.context(worktree, environment)
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
        with self.lock:
            active = self.active.get(worktree)
        return {"nodes": result, "active": self.store.get("run", active["id"]) if active else None}

    def launch(self, worktree_id, environment, target=None, entry_point="api", *, confirmed=False):
        self.projects.get(worktree_id)
        run_id = uid("run_")
        token = {"id": run_id, "cancel": threading.Event(), "cursor": None}
        with self.lock:
            settings = self.catalog.environment(environment)
            if entry_point == "ui" and settings["confirm_before_run"] and not confirmed:
                raise Problem(
                    "Confirm this environment before running",
                    409,
                    {"confirmation_required": settings},
                )
            if worktree_id in self.active:
                raise Problem(
                    "This worktree already has an active execution. Wait or stop it before running again.",
                    409,
                    {"run": self.active[worktree_id]["id"]},
                )
            self.active[worktree_id] = token
        try:
            snapshot = self.projects.flush(worktree_id)
            bundle = copy.deepcopy(snapshot["bundle"])
            if bundle is None:
                raise Problem(
                    "Project files are invalid; correct them before execution", 422, snapshot["diagnostics"]
                )
            nodes, edges, _ = expand(bundle, tolerant=True)
            order = topological(nodes, edges, tolerant=True)
            if target:
                scope = {n for n in nodes if in_subtree(n, target)}
                if not scope:
                    raise Problem("Node not found", 404)
                scope = reachable(scope, edges, upstream=True)
                order = [n for n in order if n in scope]
            else:
                scope = set(nodes)
            self._check_conflicts(snapshot["conflicts"], scope, environment)
            captured, secrets = self._capture_connections(
                worktree_id, nodes, scope, environment, strict=bool(target)
            )
            fingerprints = self.fingerprints(bundle, environment, captured)
            context = self.context(worktree_id, environment, create=True)
            affected = reachable(scope, edges, upstream=False)
            for key in affected - scope:
                identity = digest([worktree_id, environment, key])
                previous = self.store.get("export_result", identity)
                if previous:
                    self.store.put("export_result", identity, {**previous, "status": "stale"})
            with context.lock:
                self.cancel_lineage(context, affected)
                for dataset in context.datasets.values():
                    if dataset.node in affected:
                        dataset.status = "stale"
            run = {
                "id": run_id,
                "worktree": worktree_id,
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
                    }
                    for n in order
                },
                "connections": {
                    ref: {"definition": c["definition"], "settings": c["settings"], "name": c["name"]}
                    for ref, c in captured.items()
                },
                "definitions": bundle["templates"],
                "components": bundle["components"],
                "flow": bundle["flow"],
            }
            self._persist(run, secrets)
            execution = Execution(token, context, run, nodes, edges, order, captured, secrets, fingerprints)
            thread = threading.Thread(target=self._execute, args=(execution,), name=run_id, daemon=True)
            with self.lock:
                self.threads = [t for t in self.threads if t.is_alive()] + [thread]
            thread.start()
            return self.store.get("run", run_id)
        except Exception:
            with self.lock:
                self.active.pop(worktree_id, None)
            raise

    def _check_conflicts(self, conflicts, scope, environment):
        """Reject a run when a pending edit conflict would change a node in its scope."""
        for conflict in conflicts:
            try:
                current = self.fingerprints(files_to_bundle(conflict["current"]), environment)
                proposed = self.fingerprints(files_to_bundle(conflict["proposal"]), environment)
                computation_conflict = any(current.get(n) != proposed.get(n) for n in scope)
            except Exception:
                computation_conflict = True
            if computation_conflict:
                raise Problem("Resolve computation-affecting edit conflicts before running", 409)

    def _capture_connections(self, worktree, nodes, scope, environment, strict):
        """Freeze connection settings for the scope; invalid ones block their nodes (or the run if strict)."""
        captured, secrets = {}, []
        for key in scope:
            node = nodes[key]
            try:
                values, hidden = self.capture(worktree, connection_references(node), environment)
                captured.update(values)
                secrets.extend(hidden)
            except Problem as error:
                node["error"] = str(error)
            if strict and node.get("error"):
                raise Problem(node["error"], 422)
        return captured, secrets

    def _persist(self, run, secrets):
        def sanitize(value):
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
            for key, state in run["nodes"].items():
                if state.get("kind") == "export":
                    self.store.put(
                        "export_result",
                        digest([run["worktree"], run["environment"], key]),
                        {
                            **{k: state.get(k) for k in ("status", "fingerprint", "artifact")},
                            **{k: run[k] for k in ("worktree", "environment", "commit", "started")},
                            "node": key,
                            "run": run["id"],
                            "run_status": run["status"],
                        },
                    )
        context = self.contexts.get((run["worktree"], run["environment"]))
        if context:
            with context.lock:
                context.node_status.update({key: state["status"] for key, state in run["nodes"].items()})

    def _execute(self, execution):
        run, secrets, context = execution.run, execution.secrets, execution.context
        started = time.monotonic()
        try:
            execution.cursor = context.db.cursor()
            if not self.isolated:
                execution.cursor = NativeCursor(execution.cursor)
            execution.token["cursor"] = execution.cursor
            run["status"] = "running"
            self._persist(run, secrets)
            for key in execution.order:
                state = run["nodes"][key]
                skipped = self._skip_reason(execution, key)
                if skipped:
                    state.update(skipped)
                    if "error" in skipped:
                        with context.lock:
                            context.errors[key] = skipped["error"]
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
    def _skip_reason(execution, key):
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

    def _run_node(self, execution, key):
        run, secrets, context = execution.run, execution.secrets, execution.context
        node, state = execution.nodes[key], run["nodes"][key]
        state.update(status="running", started=now(), parameters=node.get("params", {}))
        if node["parsed"]["kind"] == "export":
            state["external_outcome"] = "unknown"
        self._persist(run, secrets)
        node_start = time.monotonic()
        created_tables = []
        try:
            staged = self._compute(execution, key, created_tables)
            if execution.canceled:
                raise Problem("Execution canceled after the active SQL operation ended")
            previous = self._publish(execution, key, staged)
            created_tables.clear()
            self._retire(execution, key, previous)
            state.update(status="success", outputs={p: d.public() for p, d in staged.items()})
            try:
                self.cleanup_column_docs(
                    context.worktree,
                    key,
                    {p: d for p, d in staged.items() if d.status == "valid"},
                    context.environment,
                )
            except Exception as error:
                state["documentation_error"] = str(error)
        except Exception as error:
            if created_tables:
                try:
                    cleanup = context.db.cursor()
                    try:
                        for table, storage in created_tables:
                            drop_relations(cleanup, table, storage)
                    finally:
                        cleanup.close()
                except (duckdb.Error, Problem):
                    # A dead worker has already discarded its tables.
                    pass
            message = redact(str(error), secrets)
            preparation = {base_type(p["type"]) for p in node["parsed"]["parameters"]} & PREPARATION_TYPES
            if preparation:
                message += "\nCheck the configured source columns and output types. Conversions must be valid for every value."
                if "value_cleaning" in preparation:
                    message += " Date text must match its format (for example %d/%m/%Y); null replacements must match the resulting type (YYYY-MM-DD for DATE)."
            state.update(status="canceled" if execution.canceled else "failed", error=message)
            with context.lock:
                context.errors[key] = message
            if state.get("kind") == "export" and state.get("external_outcome") != "completed":
                state["external_outcome"] = (
                    "partial or unknown" if state.get("external_started") else "failed"
                )
        state.update(finished=now(), duration=time.monotonic() - node_start)
        self._persist(run, secrets)

    def _prepare_connections(self, execution, node):
        """Prepare each logical connection once per run, replaying its first failure."""
        for reference in connection_references(node):
            if reference not in execution.prepared:
                try:
                    if not self.isolated:
                        self.catalog.prepare(execution.cursor, {reference: execution.captured[reference]})
                    execution.prepared[reference] = None
                except Exception as error:
                    execution.prepared[reference] = error
            if execution.prepared[reference]:
                raise execution.prepared[reference]

    def _compute(self, execution, key, created_tables):
        """Execute a node's statements into freshly named tables; return its staged outputs."""
        cursor, context, run = execution.cursor, execution.context, execution.run
        node, state = execution.nodes[key], run["nodes"][key]
        self._prepare_connections(execution, node)
        input_datasets = {
            e["targetHandle"]: execution.published[e["source"]][e["sourceHandle"]]
            for e in execution.edges
            if e["target"] == key
        }
        physical = {port: uid("data_") for port in node["parsed"]["outputs"]}
        directory = self.exports(context.worktree, context.environment)
        directory.mkdir(parents=True, exist_ok=True)
        statements = compile_template(
            node["parsed"],
            node.get("params", {}),
            {port: qi(data.table) for port, data in input_datasets.items()},
            physical,
            execution.captured,
            directory,
            input_schemas={port: data.columns for port, data in input_datasets.items()},
        )
        state["statements"] = statements
        self._persist(run, execution.secrets)
        staged = {}
        for statement in statements:
            if execution.canceled:
                raise Problem("Execution canceled")
            if not statement["output"]:
                # Serialize file writes and capture across worktrees sharing a destination.
                with self.export_lock:
                    if execution.canceled:
                        raise Problem("Execution canceled")
                    state["external_started"] = True
                    cursor.execute(statement["sql"], statement["bindings"])
                    if len(statements) == 1 and statement.get("export_file"):
                        roots = [directory]
                        if self.access:
                            _, writable = self.access.local_roots(run["project"], execution.captured)
                            roots.extend(writable)
                        else:
                            roots.extend(
                                Path(c["values"]["root"]).resolve()
                                for c in execution.captured.values()
                                if c["values"].get("root")
                            )
                        try:
                            state["artifact"] = self.artifacts.capture(
                                statement["export_file"], run, key, roots
                            )
                        except OSError:
                            # The external export succeeded even if its download copy is unavailable.
                            state["artifact"] = None
                state["external_outcome"] = "completed"
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
            count = cursor.execute(f"SELECT count(*) FROM {qi(table)}").fetchone()[0]
            staged[statement["output"]] = Dataset(
                id=table,
                node=key,
                port=statement["output"],
                table=table,
                columns=columns,
                count=count,
                run=run["id"],
                query=statement["query"],
                bindings=statement["bindings"],
                dependencies={data.table: data.id for data in data_inputs.values()},
                fingerprint=execution.fingerprints[key],
                source=node["parsed"]["kind"] == "source",
                storage=plan["storage"],
                column_map=column_map,
                witnesses=plan["witnesses"],
                groups=plan["groups"],
            )
        return staged

    def _publish(self, execution, key, staged):
        """Atomically replace a node's outputs; return the previous output set."""
        context = execution.context
        # A later edit must not turn a result for the old snapshot valid.
        with self.projects.lock:
            current = self._current_fingerprints(context.worktree, context.environment)
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

    def _retire(self, execution, key, previous):
        """Drop replaced outputs and their lineage tables once no lineage reader uses them."""
        context = execution.context
        for dataset in previous.values():
            # Readers acknowledge cancellation in their finally block.
            while any(dataset.node in r["nodes"] for r in list(context.lineage.values())):
                time.sleep(READER_POLL_INTERVAL)
            with context.lock:
                traces = [
                    d
                    for d in context.datasets.values()
                    if d.id.startswith("trace_") and d.node == key and d.run != execution.run["id"]
                ]
                cleanup = context.db.cursor()
                try:
                    for old in [dataset, *traces]:
                        drop_dataset(cleanup, old)
                        context.datasets.pop(old.id, None)
                finally:
                    cleanup.close()

    def wait(self, run_id, timeout=None):
        """Block until a run's worker has finished and released its worktree; return the record."""
        with self.lock:
            thread = next((t for t in self.threads if t.name == run_id), None)
        if thread:
            thread.join(timeout)
            if thread.is_alive():
                raise TimeoutError(f"Run {run_id} did not finish within {timeout} seconds")
        return self.store.get("run", run_id)

    def exports(self, worktree, environment):
        """Default directory for relative export destinations."""
        return self.store.home / "exports" / worktree / environment

    def export_result(self, worktree, environment, node):
        """Describe only the current export attempt in this exact execution context."""
        self.catalog.environment(environment)
        with self.projects.lock, self.lock:
            snapshot = self.projects.snapshot(worktree)
            if not snapshot["bundle"]:
                return {"status": "stale"}
            nodes, edges, _ = expand(snapshot["bundle"], tolerant=True)
            definition = nodes.get(node)
            if not definition:
                raise Problem("Node not found", 404)
            if definition.get("template") not in ("export_csv", "export_xlsx"):
                return {"status": "unsupported"}
            destination = definition.get("params", {}).get("destination", "")
            if URI.match(str(destination)):
                return {"status": "unsupported"}
            result = self.store.get("export_result", digest([worktree, environment, node]))
            if not result:
                return {"status": "not_run"}
            public = {k: result[k] for k in ("run", "commit", "started", "status")}
            active = self.active.get(worktree)
            if active and active["id"] == result["run"]:
                return {**public, "status": "running"}
            if result["status"] != "success":
                return {**public, "status": "stale" if result["status"] == "stale" else "failed"}
            if self.access:
                references = [
                    ref
                    for key in reachable({node}, edges, upstream=True)
                    for ref in connection_references(nodes[key])
                ]
                try:
                    self.access.connections(snapshot["worktree"]["project"], references)
                except Problem:
                    return {**public, "status": "stale"}
            current = self.fingerprints(snapshot["bundle"], environment)
            if current.get(node) != result["fingerprint"]:
                return {**public, "status": "stale"}
            if result["run_status"] in ("canceled", "interrupted"):
                return {**public, "status": "failed"}
            try:
                with self.artifacts.open(
                    result.get("artifact") or "", worktree, environment, node, result["run"]
                ) as (_, record):
                    return {
                        **public,
                        **{k: record[k] for k in ("filename", "size", "media_type")},
                        "status": "available",
                    }
            except Problem:
                return {**public, "status": "missing"}

    def open_export(self, worktree, environment, node, run):
        """Validate the selected run and pin its private artifact before streaming."""
        with self.projects.lock, self.lock:
            result = self.export_result(worktree, environment, node)
            if result.get("run") != run or result["status"] != "available":
                raise Problem(
                    "Export is unavailable. Refresh the result or run the export again.",
                    404 if result["status"] == "missing" else 409,
                )
            record = self.store.get("export_result", digest([worktree, environment, node]))
            return self.artifacts.open(record["artifact"], worktree, environment, node, run)

    def generation_valid(self, worktree, environment, dataset_id):
        """Whether a result generation is still current, so a lineage view may keep using it."""
        context = self.context(worktree, environment)
        with context.lock:
            dataset = context.datasets.get(dataset_id)
            return bool(dataset and dataset.status == "valid")

    def cancel(self, run_id):
        run = self.store.get("run", run_id)
        if not run:
            raise Problem("Execution not found", 404)
        with self.lock:
            token = self.active.get(run["worktree"])
            if not token or token["id"] != run_id:
                return self.store.get("run", run_id)
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
        return run

    def cleanup_column_docs(self, worktree, node, outputs, environment):
        """Prune only against a schema resolved by a successful publication."""
        with self.projects.lock:
            snapshot = self.projects.snapshot(worktree)
            bundle = snapshot["bundle"]
            if not bundle or not outputs:
                return
            current = self.fingerprints(bundle, environment).get(node)
            if any(data.fingerprint != current for data in outputs.values()):
                return
            documentation = bundle["documentation"].get("columns", {})
            schemas = {node + ":" + port: {c["name"] for c in data.columns} for port, data in outputs.items()}
            try:
                _, _, boundaries = expand(bundle, tolerant=True)
                for parent, boundary in boundaries.items():
                    for port, target in boundary["outputs"].items():
                        if target[0] == node and target[1] in outputs:
                            schemas[parent + ":" + port] = schemas[node + ":" + target[1]]
            except Problem:
                pass
            changed = False
            for key, columns in schemas.items():
                if key in documentation:
                    pruned = {name: text for name, text in documentation[key].items() if name in columns}
                    if pruned != documentation[key]:
                        documentation[key] = pruned
                        changed = True
            if changed:
                self.projects.write(
                    worktree,
                    snapshot["revision"],
                    bundle_to_files(bundle),
                    "docs(schema): remove documentation for removed columns",
                )

    def find_dataset(self, worktree, environment, node, port="result"):
        context = self.context(worktree, environment)
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
        worktree,
        environment,
        node,
        port="result",
        limit=100,
        offset=0,
        sort=None,
        descending=False,
        filters=None,
    ):
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
            cursor = context.db.cursor()
            projection = ", ".join(qi(dataset.stored(c)) for c in columns)
            try:
                count = cursor.execute(f"SELECT COUNT(*) FROM {relation}{condition}", values).fetchone()[0]
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
                    "commit": run["commit"],
                    "environment": environment,
                    "error": context.errors.get(dataset.node),
                }
            finally:
                cursor.close()

    def compile(self, worktree, environment, node_id):
        snapshot = self.projects.snapshot(worktree)
        self.catalog.environment(environment)
        if not snapshot["bundle"]:
            raise Problem("Project files are invalid", 422, snapshot["diagnostics"])
        nodes, edges, _ = expand(snapshot["bundle"])
        selected = [key for key in nodes if in_subtree(key, node_id)]
        if not selected:
            raise Problem("Node not found", 404)
        output = []
        for key in selected:
            node = nodes[key]
            captured, secrets = self.capture(worktree, connection_references(node), environment)
            inputs = {
                e["targetHandle"]: qi("input_" + e["source"].replace("::", "_") + "_" + e["sourceHandle"])
                for e in edges
                if e["target"] == key
            }
            for port in node["parsed"]["inputs"]:
                if port not in inputs:
                    raise Problem(f"Connect input {port} before compiling")
            input_schemas = {}
            context = self.contexts.get((worktree, environment))
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
                self.exports(worktree, environment),
                input_schemas=input_schemas,
            )
            for statement in statements:
                statement["sql"] = redact(statement["sql"], secrets)
            output.extend(statements)
        return output

    def close(self):
        with self.lock:
            tokens, threads = list(self.active.values()), list(self.threads)
        for token in tokens:
            self.cancel(token["id"])
        for thread in threads:
            thread.join()
        with self.lock:
            contexts = list(self.contexts.values())
            self.contexts.clear()
        for context in contexts:
            if context.db:
                context.db.close()
