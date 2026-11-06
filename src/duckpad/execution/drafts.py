"""Previews of a node's code on samples of its retained inputs, and the columns of those inputs.

A preview computes rows to show and keeps nothing: it records no run, publishes no result, changes
no status and skips export, test and message blocks. Its relations are temporary tables of its
own cursor, which disappear with it.
"""

from __future__ import annotations

import copy
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import duckdb

from .. import connection_probe, project_extensions, variables
from ..catalog import Catalog, redact
from ..components import expand_for
from ..datasets import Context, Dataset
from ..graph import connection_references, reachable
from ..node_code import code_path
from ..projects import Projects
from ..sql_errors import SqlSourceError
from ..store import Store
from ..templates import compile_template
from ..types import Connections, Record, RunToken, SQLCursor
from ..util import Problem, clean, qi, uid
from .contexts import ContextPool, interrupt
from .samples import reading

# Rows read from each input; None reads every row.
SAMPLE_SIZES = (100, 1_000, 10_000)
DEFAULT_SAMPLE = 1_000
# Rows kept of each output: later blocks of the node read at most these.
OUTPUT_ROWS = 10_000
# Rows returned for each output.
SHOWN_ROWS = 1_000
# A preview stops after this many seconds.
PREVIEW_TIMEOUT = 30.0


@dataclass
class Request:
    """A preview being computed, which a newer preview of the same node replaces."""

    cursor: SQLCursor | None = None
    replaced: threading.Event = field(default_factory=threading.Event)


@dataclass
class Located:
    """A node of the expanded flow, with the inputs a preview reads."""

    node: Record
    edges: list[Record]
    nodes: dict[str, Record]


def locate(bundle: Record, full_node: str) -> tuple[Record, str | None]:
    """The authored definition of a node, inside the component instances its ID names."""
    graph, parent = bundle["flow"], None
    ids = full_node.split("::")
    for instance in ids[:-1]:
        found = next((n for n in graph.get("nodes", []) if n["id"] == instance), None)
        if not found or not found.get("component") or found["component"] not in bundle["components"]:
            raise Problem("Node not found", 404)
        parent = found["component"]
        graph = bundle["components"][parent]
    node = next((n for n in graph.get("nodes", []) if n["id"] == ids[-1]), None)
    if node is None:
        raise Problem("Node not found", 404)
    return node, parent


def with_code(bundle: Record, full_node: str, code: str) -> Record:
    """A copy of the bundle where the node runs `code`: its own file or its shared template."""
    bundle = copy.deepcopy(bundle)
    node, parent = locate(bundle, full_node)
    if node.get("component"):
        raise Problem("A component instance has no code; open the component to edit its nodes", 422)
    if node.get("template"):
        bundle["templates"][node["template"]] = code
    else:
        bundle.setdefault("node_sql", {})[code_path(node["id"], parent, node.get("language", "sql"))] = code
    return bundle


class DraftPreviews:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        catalog: Catalog,
        pool: ContextPool,
        lock: threading.RLock,
        active: dict[str, RunToken],
        *,
        isolated: bool,
    ) -> None:
        self.store, self.projects, self.catalog, self.pool = store, projects, catalog, pool
        # The engine lock and the active runs it guards.
        self.lock, self.active = lock, active
        self.isolated = isolated
        self.requests: dict[tuple[str, ...], Request] = {}
        self.requests_lock = threading.Lock()

    def preview(
        self,
        worktree: str,
        environment: str,
        full_node: str,
        code: str | None = None,
        rows: int | None = DEFAULT_SAMPLE,
        requester: str = "",
    ) -> Record:
        """Compute a node's outputs from the first `rows` rows of each retained input.

        `code` replaces the node's saved code, or its template's, for this preview only.
        """
        if rows is not None and rows not in SAMPLE_SIZES:
            raise Problem("Choose a sample of 100, 1,000 or 10,000 rows, or every row", 422)
        self.catalog.environment(environment)
        self._require_idle(worktree)
        located = self._locate(worktree, environment, full_node, code)
        node = located.node
        self._previewable(node)
        context = self.pool.find(worktree, environment)
        inputs, missing = self._inputs(context, located)
        if missing:
            raise Problem(
                "Run the ancestors of this node: "
                + ", ".join(item["input"] for item in missing)
                + (" has" if len(missing) == 1 else " have")
                + " no results yet",
                409,
                {"code": "inputs_not_materialized", "missing": missing},
            )
        context = self._started(context, worktree, environment)
        request = Request()
        key = (worktree, environment, full_node, requester)
        with self.requests_lock:
            previous = self.requests.get(key)
            self.requests[key] = request
        if previous:
            previous.replaced.set()
            if previous.cursor is not None:
                interrupt(previous.cursor)
        started = time.monotonic()
        secrets: list[str] = list(context.secrets)
        try:
            with reading(context, inputs.values(), PREVIEW_TIMEOUT) as cursor:
                request.cursor = cursor
                if request.replaced.is_set():
                    raise Problem("A newer preview of this node replaced this one", 409)
                # A run admitted meanwhile changes the inputs: it has priority.
                self._require_idle(worktree)
                try:
                    outputs, skipped = self._compute(
                        cursor, context, worktree, environment, node, inputs, rows, secrets
                    )
                except Exception as error:
                    if request.replaced.is_set():
                        raise Problem("A newer preview of this node replaced this one", 409) from None
                    if isinstance(error, duckdb.Error):
                        # A stopped worker or interrupted setup; a timeout is reported by `reading`.
                        raise Problem(redact(str(error), secrets), 422, {"code": "preview_failed"}) from None
                    raise
        finally:
            with self.requests_lock:
                if self.requests.get(key) is request:
                    del self.requests[key]
        return {
            "node": full_node,
            "environment": environment,
            "rows": rows,
            "inputs": [
                {
                    "input": port,
                    "node": dataset.node,
                    "port": dataset.port,
                    "status": dataset.status,
                    "count": dataset.count,
                    "sampled": dataset.count if rows is None else min(rows, dataset.count),
                }
                for port, dataset in inputs.items()
            ],
            "outputs": outputs,
            "skipped": skipped,
            "duration": time.monotonic() - started,
        }

    def input_columns(self, worktree: str, environment: str, full_node: str) -> Record:
        """The columns of each input of a node: from its retained result, or described from the
        code of upstream nodes when they have no result yet."""
        self.catalog.environment(environment)
        located = self._locate(worktree, environment, full_node)
        context = self.pool.find(worktree, environment)
        edges = {e["targetHandle"]: e for e in located.edges if e["target"] == full_node}
        entries: dict[str, Record] = {}
        described: dict[str, Record] = {}
        for port in located.node["parsed"]["inputs"]:
            edge = edges.get(port)
            if edge is None:
                entries[port] = {"input": port, "columns": None, "origin": None, "reason": "not_connected"}
                continue
            dataset = self._retained(context, edge["source"], edge["sourceHandle"])
            entry = {"input": port, "node": edge["source"], "port": edge["sourceHandle"]}
            if dataset is not None:
                entries[port] = {
                    **entry,
                    "columns": dataset.columns,
                    "origin": "result",
                    "status": dataset.status,
                }
            else:
                entries[port] = {**entry, "columns": None, "origin": None, "reason": "not_materialized"}
                described[port] = edge
        with self.lock:
            idle = worktree not in self.active
        if described and idle:
            # Reading columns never starts a database where reads do not open one.
            context = self.pool.get(worktree, environment)
            live = context.db is not None and not getattr(context.db, "closed", False)
            try:
                columns = self._describe(context, worktree, environment, located, described) if live else {}
            except Problem:
                columns = {}
            for port, value in columns.items():
                if value is not None:
                    entries[port].update(columns=value, origin="description", reason=None)
        return {"node": full_node, "environment": environment, "inputs": list(entries.values())}

    def _require_idle(self, worktree: str) -> None:
        with self.lock:
            token = self.active.get(worktree)
        if token:
            raise Problem(
                "Wait for the active run of this branch to finish before previewing",
                409,
                {"code": "run_active", "run": token["id"]},
            )

    def _locate(self, worktree: str, environment: str, full_node: str, code: str | None = None) -> Located:
        snapshot = self.projects.snapshot(worktree)
        bundle = snapshot["bundle"]
        if bundle is None:
            raise Problem("Correct the project files before previewing", 422, snapshot["diagnostics"])
        if code is not None:
            bundle = with_code(bundle, full_node, code)
        nodes, edges, boundaries = expand_for(
            bundle, environment, computed=self.pool.computed(worktree, environment, bundle)
        )
        if full_node in boundaries:
            raise Problem("A component instance has no code; open the component to preview its nodes", 422)
        node = nodes.get(full_node)
        if node is None:
            raise Problem("Node not found", 404)
        return Located(node, edges, nodes)

    @staticmethod
    def _previewable(node: Record) -> None:
        """Refuse a node whose preview would not compute what its run computes."""
        if node.get("language") == "python":
            raise Problem(
                "Previews run SQL nodes; run this Python node to see its output",
                422,
                {"code": "python_preview"},
            )
        if node.get("error"):
            raise Problem(node["error"], 422)
        if node.get("partitioned") or node.get("partition_collect_inputs"):
            raise Problem(
                "Previews do not read partitions yet; run this node to see its output",
                422,
                {"code": "partitioned_preview"},
            )

    @staticmethod
    def _retained(context: Context | None, node: str, port: str) -> Dataset | None:
        if context is None or context.db is None or getattr(context.db, "closed", False):
            return None
        with context.lock:
            return context.outputs.get(node, {}).get(port)

    def _inputs(self, context: Context | None, located: Located) -> tuple[dict[str, Dataset], list[Record]]:
        """The retained result read by each input port, and the inputs without one."""
        node = located.node
        edges = {e["targetHandle"]: e for e in located.edges if e["target"] == node["id"]}
        inputs: dict[str, Dataset] = {}
        missing = []
        for port in node["parsed"]["inputs"]:
            edge = edges.get(port)
            if edge is None:
                raise Problem(f"Connect input {port} before previewing", 422)
            dataset = self._retained(context, edge["source"], edge["sourceHandle"])
            if dataset is None:
                missing.append({"input": port, "node": edge["source"], "port": edge["sourceHandle"]})
            else:
                inputs[port] = dataset
        return inputs, missing

    def _started(self, context: Context | None, worktree: str, environment: str) -> Context:
        """The context's database, started when the branch has none yet in this environment.

        A live context is never replaced here: only a run may restart it with new settings.
        """
        if context is not None and context.db is not None and not getattr(context.db, "closed", False):
            return context
        return self.pool.get(worktree, environment, create=True)

    def _connections(
        self,
        cursor: SQLCursor,
        context: Context,
        worktree: str,
        environment: str,
        node: Record,
        secrets: list[str],
        setup: bool = True,
    ) -> Connections:
        """The connections a node reads, set up the way a run sets them up.

        An attached database is used as it is: setting it up again would detach it from the
        run that may be reading it. Without `setup`, a connection that is not attached fails.
        """
        references = connection_references(node)
        if not references:
            return {}
        if self.isolated:
            missing = [r for r in references if r not in context.connections]
            if missing:
                # The worker attaches connections when it starts: check why this one is missing.
                self.pool.capture(worktree, missing, environment)
                raise Problem("Run this node once to attach its connection, then preview it again", 409)
            return {r: context.connections[r] for r in references}
        captured, hidden = self.pool.capture(worktree, references, environment)
        secrets.extend(hidden)
        offline = self.store.get("settings", "offline_extensions", {})
        for reference, connection in captured.items():
            if connection_probe.attached(cursor, connection["alias"]):
                continue
            if not setup:
                raise Problem("Run this node once to attach its connection, then preview it again", 409)
            try:
                connection_probe.check_extensions(self.pool.probe_config(), connection, offline, secrets)
                self.catalog.prepare(cursor, {reference: connection})
            except (Problem, duckdb.Error) as error:
                raise Problem(
                    f"Cannot set up connection {connection['name']}: {redact(str(error), secrets)}", 422
                ) from None
        return captured

    def _statements(
        self,
        cursor: SQLCursor,
        context: Context,
        worktree: str,
        environment: str,
        node: Record,
        relations: dict[str, str],
        columns: dict[str, list[dict[str, str]]],
        secrets: list[str],
        setup: bool = True,
    ) -> tuple[list[Record], list[Record]]:
        """Compile a node against temporary relations; return its statements and source locations."""
        captured = self._connections(cursor, context, worktree, environment, node, secrets, setup)
        project = self.projects.get(worktree)["project"]
        statements = compile_template(
            node["parsed"],
            node.get("params", {}),
            relations,
            {port: uid("data_") for port in node["parsed"]["outputs"]},
            captured,
            self.store.paths.project_files(project, worktree, environment),
            input_schemas=columns,
            variables=variables.expression_values(node),
            bound=node.get("variables"),
        )
        return statements, [statement.pop("source_location") for statement in statements]

    def _compute(
        self,
        cursor: SQLCursor,
        context: Context,
        worktree: str,
        environment: str,
        node: Record,
        inputs: dict[str, Dataset],
        rows: int | None,
        secrets: list[str],
    ) -> tuple[list[Record], Record]:
        relations = {}
        for port, dataset in inputs.items():
            if rows is None:
                relations[port] = qi(dataset.table)
                continue
            # Copy the sample once, so that every reference of the input reads the same rows.
            relations[port] = qi(uid("data_"))
            try:
                cursor.execute(
                    f"CREATE TEMPORARY TABLE {relations[port]} AS "
                    f"SELECT * FROM {qi(dataset.table)} LIMIT {int(rows)}"
                )
            except duckdb.InterruptException:
                raise
            except duckdb.Error as error:
                raise Problem(f"Cannot read input {port}: {error}", 409) from None
        try:
            statements, locations = self._statements(
                cursor,
                context,
                worktree,
                environment,
                node,
                relations,
                {port: dataset.columns for port, dataset in inputs.items()},
                secrets,
            )
        except SqlSourceError as error:
            raise self._failure(error, node, secrets) from None
        except Problem as error:
            # Invalid parameters and data access are errors of the previewed code.
            if error.status != 400:
                raise
            raise Problem(redact(str(error), secrets), 422, {"code": "preview_failed"}) from None
        skipped = {"exports": 0, "tests": 0, "messages": 0}
        outputs = []
        for statement, location in zip(statements, locations, strict=True):
            if statement.get("test_name"):
                skipped["tests"] += 1
                continue
            if statement.get("message_block"):
                skipped["messages"] += 1
                continue
            if not statement["output"]:
                skipped["exports"] += 1
                continue
            table = qi(statement["table"])
            executed = (
                f"CREATE TEMPORARY TABLE {table} AS SELECT * FROM ({statement['query']}) AS preview "
                f"LIMIT {OUTPUT_ROWS + 1}"
            )
            try:
                cursor.execute(executed, statement["bindings"])
                described = cursor.execute(f"DESCRIBE {table}").fetchall()
                count_row = cursor.execute(f"SELECT count(*) FROM {table}").fetchone()
                shown = cursor.execute(f"SELECT * FROM {table} LIMIT {SHOWN_ROWS}").fetchall()
            except duckdb.InterruptException:
                raise
            except duckdb.Error as error:
                raise self._failure(SqlSourceError(error, location, executed), node, secrets) from None
            assert count_row is not None
            outputs.append(
                {
                    "port": statement["output"],
                    "columns": [{"name": c[0], "type": c[1]} for c in described],
                    "rows": clean(shown),
                    "count": min(count_row[0], OUTPUT_ROWS),
                    "truncated": count_row[0] > OUTPUT_ROWS,
                }
            )
        return outputs, skipped

    @staticmethod
    def _failure(error: SqlSourceError, node: Record, secrets: list[str]) -> Problem:
        """A preview error, located in the code it previewed."""
        message = project_extensions.explain_missing(redact(str(error), secrets))
        diagnostic = {**error.diagnostic, "message": message, "source": node["template_sql"]}
        return Problem(message, 422, {"code": "preview_failed", "diagnostic": diagnostic})

    def _describe(
        self,
        context: Context,
        worktree: str,
        environment: str,
        located: Located,
        wanted: dict[str, Record],
    ) -> dict[str, list[dict[str, str]] | None]:
        """Describe the outputs of upstream nodes without results, compiled down to retained
        results or sources. Their queries are planned and return no rows."""
        secrets: list[str] = list(context.secrets)
        # Expanded output -> relation holding its (empty) rows, or None when it cannot be described.
        relations: dict[tuple[str, str], tuple[str, list[dict[str, str]]] | None] = {}

        def relation(cursor: SQLCursor, source: str, port: str, seen: tuple[str, ...]) -> Any:
            key = (source, port)
            if key in relations:
                return relations[key]
            dataset = self._retained(context, source, port)
            if dataset is not None:
                relations[key] = (qi(dataset.table), dataset.columns)
                return relations[key]
            node = located.nodes.get(source)
            relations[key] = None
            if (
                node is None
                or source in seen
                or node.get("error")
                or node.get("language") == "python"
                or node.get("partitioned")
                or node.get("partition_collect_inputs")
            ):
                return None
            inputs, columns = {}, {}
            for edge in located.edges:
                if edge["target"] != source:
                    continue
                found = relation(cursor, edge["source"], edge["sourceHandle"], (*seen, source))
                if found is None:
                    return None
                inputs[edge["targetHandle"]], columns[edge["targetHandle"]] = found
            if set(inputs) != set(node["parsed"]["inputs"]):
                return None
            try:
                statements, _ = self._statements(
                    cursor, context, worktree, environment, node, inputs, columns, secrets, setup=False
                )
                for statement in statements:
                    if (
                        not statement["output"]
                        or statement.get("test_name")
                        or statement.get("message_block")
                    ):
                        continue
                    table = qi(statement["table"])
                    cursor.execute(
                        f"CREATE TEMPORARY TABLE {table} AS SELECT * FROM ({statement['query']}) AS preview LIMIT 0",
                        statement["bindings"],
                    )
                    described = [
                        {"name": c[0], "type": c[1]} for c in cursor.execute(f"DESCRIBE {table}").fetchall()
                    ]
                    relations[(source, statement["output"])] = (table, described)
            except (duckdb.Error, Problem):
                return None
            return relations.get(key)

        result: dict[str, list[dict[str, str]] | None] = {}
        # Runs that replace the upstream results stop this reader first.
        upstream = reachable({located.node["id"]}, located.edges, upstream=True)
        with context.lock:
            retained = [d for n in upstream for d in context.outputs.get(n, {}).values()]
        try:
            with reading(context, retained, PREVIEW_TIMEOUT) as cursor:
                for port, edge in wanted.items():
                    found = relation(cursor, edge["source"], edge["sourceHandle"], ())
                    result[port] = found[1] if found else None
        except (duckdb.Error, Problem):
            return result
        return result
