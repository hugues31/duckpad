"""Live DuckDB contexts per worktree and environment, and the SQL workers behind them."""

from __future__ import annotations

import copy
import logging
import re
import threading
import time
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path

import duckdb

from .. import project_extensions, value_sources
from ..access import Access
from ..catalog import Catalog, database_files, executable, redact
from ..components import expand
from ..datasets import Context
from ..materialize import drop_dataset
from ..projects import Projects
from ..python_policy import get_policy
from ..store import Store
from ..templates import URI
from ..types import Connections, Files, Record, SQLCursor, SQLDatabase
from ..util import Problem, digest, literal, qi, uid
from .connections import ConnectionConfig

logger = logging.getLogger(__name__)

# How often a writer waits for lineage readers to release results it drops.
READER_POLL_INTERVAL = 0.005
# URL prefixes that DuckDB scopes to each object storage secret type by default.
REMOTE_PREFIXES = {"s3": ("s3://", "s3a://", "s3n://"), "r2": ("r2://",), "gcs": ("gcs://", "gs://")}
SECRET_OPTIONS = re.compile(r"\bSECRET\s+\{\{\s*secret_name\s*\}\}\s*\(([^)]*)", re.IGNORECASE)
SECRET_TYPE = re.compile(r"\bTYPE\s+[\"']?(\w+)", re.IGNORECASE)
# Instance SQL resources; None leaves DuckDB's automatic sizing from the server's CPUs and memory.
SQL_RESOURCES: Record = {"threads": None, "memory_limit": None}


def remote_prefixes(captured: Connections) -> list[str]:
    """Remote URL prefixes covered by the connections' storage secret types, whatever their IDs,
    and the URI roots of their storage connections."""
    prefixes: list[str] = []
    for connection in captured.values():
        sql = re.sub(r"--[^\n]*|/\*.*?\*/", "", connection["definition"].get("init_sql", ""), flags=re.DOTALL)
        found = []
        for options in SECRET_OPTIONS.findall(sql):
            for kind in SECRET_TYPE.findall(options):
                found += REMOTE_PREFIXES.get(kind.lower(), ())
        root = connection["values"].get("root")
        if connection["definition"].get("family") == "storage" and isinstance(root, str) and URI.match(root):
            # A folder prefix: `s3://bucket/landing` must not also open `s3://bucket/landing-archive`.
            found.append(root if root.endswith("/") else root + "/")
        prefixes += [p for p in found if p not in prefixes]
    return prefixes


def resource_config(resources: Record) -> Record:
    """The DuckDB settings of explicit SQL resources."""
    return {key: resources[key] for key in SQL_RESOURCES if resources.get(key) is not None}


def automatic_resources() -> Record:
    """DuckDB's own sizing on this server, which sessions use without explicit resources."""
    with duckdb.connect() as db:
        row = db.execute("SELECT current_setting('threads'), current_setting('memory_limit')").fetchone()
    assert row is not None
    threads, memory_limit = row
    return {"threads": threads, "memory_limit": memory_limit}


def interrupt(cursor: SQLCursor) -> None:
    """Interrupt a cursor without waiting for its statement to stop.

    Cancellation persists in the cursor, and a cursor closed meanwhile has nothing left to stop.
    """

    def stop() -> None:
        with suppress(duckdb.Error, Problem):
            cursor.interrupt()

    threading.Thread(target=stop, name="interrupt", daemon=True).start()


def cancel_lineage(context: Context, affected: set[str] | None = None, *, dropping: bool = False) -> None:
    """Interrupt the lineage requests reading results of the affected nodes, or all of them.

    Display readers, such as samples and statistics, keep reading a result that turns stale;
    they stop when all requests stop, or when `dropping` announces that the results go away.
    """
    for request in list(context.lineage.values()):
        if request.get("display") and affected is not None and not dropping:
            continue
        if affected is None or request["nodes"] & affected:
            request["canceled"].set()
            interrupt(request["cursor"])


def transfer(database: SQLDatabase, path: Path, *, save: bool) -> None:
    """Copy every table and view of a worker's database to a DuckDB file in its sandbox, or back.

    Results are immutable, so their row identifiers, which lineage and samples use, stay unchanged.
    """
    cursor = database.cursor()
    try:
        cursor.execute(f"ATTACH {literal(str(path))} AS handoff{'' if save else ' (READ_ONLY)'}")
        try:
            cursor.execute(
                "COPY FROM DATABASE memory TO handoff" if save else "COPY FROM DATABASE handoff TO memory"
            )
        finally:
            cursor.execute("DETACH handoff")
    finally:
        cursor.close()


def attached(connections: Connections) -> str:
    """What the setup of a worker's connections depends on, without names and descriptions."""
    return digest(
        {reference: [executable(c["definition"]), c["values"]] for reference, c in connections.items()}
    )


def wait_for_readers(context: Context, nodes: set[str]) -> None:
    """Wait until no lineage request reads results of these nodes.

    Readers acknowledge cancellation in their finally block.
    """
    while any(request["nodes"] & nodes for request in list(context.lineage.values())):
        time.sleep(READER_POLL_INTERVAL)


class ContextPool:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        catalog: Catalog,
        access: Access,
        isolated: bool,
        lock: threading.RLock,
        *,
        enforce_access: bool,
    ) -> None:
        self.store, self.projects, self.catalog, self.access = store, projects, catalog, access
        self.isolated = isolated
        self.enforce_access = enforce_access
        self.connections = ConnectionConfig(
            store, projects, catalog, access, isolated=isolated, enforce_access=enforce_access
        )
        # The engine lock, which guards the pool's mapping.
        self.lock = lock
        self.contexts: dict[tuple[str, str], Context] = {}

    def get(self, worktree: str, environment: str, create: bool = False) -> Context:
        return self._get(worktree, environment, create=create)

    def ensure_started(self, worktree: str, environment: str) -> Context:
        """Start an absent or dead context without replacing a live reader or run's results."""
        return self._get(worktree, environment, create=True)

    def restart_for_run(
        self,
        worktree: str,
        environment: str,
        requirements: list[Record] | None = None,
        python_files: Files | None = None,
    ) -> Context:
        """Apply current settings; only the run holding the worktree reservation may call this."""
        return self._get(
            worktree,
            environment,
            create=True,
            requirements=requirements,
            python_files=python_files,
            restart=True,
        )

    def _get(
        self,
        worktree: str,
        environment: str,
        create: bool = False,
        requirements: list[Record] | None = None,
        python_files: Files | None = None,
        restart: bool = False,
    ) -> Context:
        """The live DuckDB context of an existing worktree in a configured environment.

        Its database starts outside the engine lock, so status and cancellation requests
        never wait for a worker, extension installation or connection setup.
        """
        key = (worktree, environment)
        opening = create or not self.enforce_access
        with self.lock:
            existing = self.contexts.get(key)
        partition_artifacts = existing.partition_artifacts if existing else False
        if opening and (
            restart or existing is None or existing.db is None or getattr(existing.db, "closed", False)
        ):
            bundle = self.projects.snapshot(worktree, committed=True)["bundle"]
            partition_artifacts = bool((bundle or {}).get("flow", {}).get("partitions"))
            if requirements is None:
                requirements = project_extensions.enabled((bundle or {}).get("extensions"))
        elif opening and requirements is None and existing:
            requirements = existing.extensions
        resources = self.sql_resources() if opening else {}
        python_files = self._python_files(worktree, python_files, existing) if opening else None
        python_signature = digest(python_files) if python_files is not None else ""
        while True:
            self.projects.get(worktree)
            if environment not in self.catalog.environment_names():
                raise Problem("Unknown environment", 404)
            with self.lock:
                context, stopped = self.contexts.get(key), None
                if (
                    context is None
                    or getattr(context.db, "closed", False)
                    or (
                        (restart or (opening and context.db is None))
                        and (
                            context.extensions != requirements
                            or context.resources != resources
                            or context.partition_artifacts != partition_artifacts
                        )
                    )
                ):
                    if context is not None:
                        with context.lock:
                            cancel_lineage(context)
                    stopped = context.db if context is not None else None
                    context = self.contexts[key] = Context(
                        *key,
                        db=None,
                        extensions=requirements or [],
                        resources=resources,
                        partition_artifacts=partition_artifacts,
                        python_signature=python_signature,
                        python_files=python_files,
                    )
            if stopped:
                # Reap the replaced worker's process and release its descriptors.
                stopped.close()
            if context.db is not None or (self.enforce_access and not create):
                return context
            database, connections, secrets = self._open(
                worktree,
                environment,
                requirements or [],
                resources,
                partition_artifacts,
                python_files=python_files,
            )
            with self.lock:
                if self.contexts.get(key) is context and context.db is None:
                    context.db, context.connections, context.secrets = database, connections, secrets
                    context.python_signature, context.python_files = python_signature, python_files
                    return context
            # Another request published its database first, or the context was discarded meanwhile.
            database.close()
            if self.contexts.get(key) is context:
                return context

    def find(self, worktree: str, environment: str) -> Context | None:
        """The context of a worktree in an environment if one was started, without starting it."""
        return self.contexts.get((worktree, environment))

    def computed(self, worktree: str, environment: str, bundle: Record) -> Record:
        """Snapshot live scalar values without starting a database or reading run history."""
        declarations = bundle.get("variables")
        if not isinstance(declarations, dict) or not any(
            isinstance(v, dict) and "from" in v for v in declarations.values()
        ):
            return {}
        nodes, _, boundaries = expand(bundle, tolerant=True)
        sources = value_sources.sources(bundle, nodes, boundaries)
        context = self.find(worktree, environment)
        cache = {}
        if context and context.db is not None and not getattr(context.db, "closed", False):
            with context.lock:
                cache = copy.deepcopy(context.retained_values)
        result = value_sources.retained(sources, cache)
        if context:
            with context.lock:
                for name, source in sources.items():
                    entry = result[name]
                    attempt = context.value_attempts.get(value_sources.identity(source), {})
                    if attempt.get("error"):
                        entry["last_error"] = attempt["error"]
                    if entry["state"] != "ready":
                        continue
                    dataset = context.outputs.get(source.get("node"), {}).get(source.get("port"))
                    entry["source_stale"] = dataset is None or dataset.status != "valid"
        return result

    def all(self, worktree: str | None = None) -> list[Context]:
        """Started contexts, of one worktree when given."""
        with self.lock:
            return [c for c in self.contexts.values() if worktree is None or c.worktree == worktree]

    def sql_resources(self) -> Record:
        """DuckDB threads and memory limit of new SQL sessions; None leaves DuckDB's automatic sizing."""
        return {**SQL_RESOURCES, **self.store.get("settings", "sql_resources", {})}

    def _python_files(self, worktree: str, files: Files | None, existing: Context | None) -> Files | None:
        """The captured dependencies a worker runs on: requested by Python runs, kept by others."""
        record = self.projects.get(worktree)
        if not get_policy(self.store, record["project"]).get("enabled"):
            return None
        if files is not None:
            return dict(files)
        if existing and not getattr(existing.db, "closed", False):
            return existing.python_files
        return None

    def renew(self, context: Context, python_files: Files | None = None) -> None:
        """Move a context's results to a new worker when its connections or Python environment changed.

        A worker attaches its connections once, then locks its configuration: new settings or
        credentials need a new worker, as does a run that needs another project environment. The
        old worker keeps serving its results until the new one has started, so a connection that
        fails to start, such as a wrong password, leaves them untouched. Only the run that owns
        the worktree may call this.
        """
        previous = context.db
        if previous is None or getattr(previous, "closed", False):
            return
        python_files = self._python_files(context.worktree, python_files, context)
        python_signature = digest(python_files) if python_files is not None else ""
        connections, secrets = context.connections, context.secrets
        changed = python_signature != context.python_signature
        if self.isolated:
            project = self.projects.get(context.worktree)["project"]
            connections, secrets = self.connections.configured(project, context.environment)
            # Secret values only reach this in-memory comparison, never a stored fingerprint.
            if attached(connections) == attached(context.connections):
                # A new name or description changes no setup: runs only report it.
                context.connections, context.secrets = connections, secrets
            else:
                changed = True
        if not changed:
            return
        files = {r for r, c in context.connections.items() if database_files(c["definition"], c["values"])}
        if files and self.isolated:
            # DuckDB locks an attached database file: the old worker releases it for the new one.
            cursor = previous.cursor()
            try:
                for reference in files:
                    cursor.execute(f"DETACH DATABASE IF EXISTS {qi(context.connections[reference]['alias'])}")
            finally:
                cursor.close()
            context.connections = {r: c for r, c in context.connections.items() if r not in files}
        candidate, _, _ = self._open(
            context.worktree,
            context.environment,
            context.extensions,
            context.resources,
            context.partition_artifacts,
            (connections, secrets) if self.isolated else None,
            python_files=python_files,
        )
        handoff = self.store.paths.exports(context.worktree, context.environment) / ".temporary"
        handoff = handoff / f"handoff-{uid()}.duckdb"
        try:
            try:
                # Readers keep reading the old worker meanwhile; only the owning run writes.
                transfer(previous, handoff, save=True)
            except (duckdb.Error, Problem) as error:
                candidate.close()
                raise Problem(
                    "Cannot move the results to a new execution worker: "
                    f"{redact(str(error), context.secrets)}. Check the free disk space of the Duckpad server.",
                    503,
                ) from None
            with context.lock:
                cancel_lineage(context)
                context.db, context.connections, context.secrets = candidate, connections, secrets
                context.python_signature = python_signature
                context.python_files = python_files
                # Release the old worker's memory before the new one loads the results.
                previous.close()
                try:
                    transfer(candidate, handoff, save=False)
                except (duckdb.Error, Problem):
                    logger.warning(
                        "Cannot load the results of worktree %s in %s into its new SQL session; "
                        "they will be recalculated",
                        context.worktree,
                        context.environment,
                        exc_info=True,
                    )
                    # A closed database makes the next request start the context without results.
                    candidate.close()
        finally:
            for path in (handoff, handoff.with_name(handoff.name + ".wal")):
                path.unlink(missing_ok=True)

    def _open(
        self,
        worktree: str,
        environment: str,
        requirements: list[Record],
        resources: Record,
        partition_artifacts: bool,
        connections: tuple[Connections, list[str]] | None = None,
        python_files: Files | None = None,
    ) -> tuple[SQLDatabase, Connections, list[str]]:
        """Start a context's database, with the connections an isolated worker attached."""
        extensions = self.store.paths.extensions
        extensions.mkdir(exist_ok=True)
        allow_unsigned = self.connections.extension_settings()["allow_unsigned_extensions"]
        imports = self.store.get("settings", "offline_extensions", {})
        from ..sandbox import Database

        project = self.projects.get(worktree)["project"]
        captured, secrets = connections or self.connections.configured(project, environment)
        roots, writable = self.access.local_roots(project, captured) if self.enforce_access else ([], [])
        runtime = {}
        policy = get_policy(self.store, project)
        if policy.get("enabled") and python_files is not None:
            from ..python_environment import prepare

            runtime = prepare(
                python_files,
                self.store.home,
                project,
                worktree=worktree,
                allow_builds=policy.get("allow_builds", False),
            )
        directory = self.store.paths.exports(worktree, environment)
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / ".temporary"
        temporary.mkdir(exist_ok=True)
        if connections is None:
            # Results that a stopped server was moving between workers are gone with their context.
            for leftover in temporary.glob("handoff-*"):
                leftover.unlink(missing_ok=True)
        if partition_artifacts:
            partition_data = self.store.paths.partition_artifacts(worktree, environment)
            partition_data.mkdir(parents=True, exist_ok=True, mode=0o700)
            roots = [*roots, partition_data]
        self.connections.check_extensions(captured, secrets)
        try:
            database = Database(
                {
                    "isolated": self.isolated,
                    **runtime,
                    "captured": captured,
                    "extensions": str(extensions),
                    "allow_unsigned_extensions": allow_unsigned,
                    "offline_extensions": imports,
                    "project_extensions": requirements,
                    "read_paths": [str(p) for p in roots],
                    "write_paths": [str(p) for p in [*writable, directory]],
                    "temporary": str(temporary),
                    "remote_paths": remote_prefixes(captured),
                    "resources": resource_config(resources),
                }
            )
            return database, captured, secrets
        except Problem as error:
            message = redact(str(error), secrets)
            if requirements:
                names = ", ".join(item["name"] for item in requirements)
                message += f" Project extensions: {names}. Check their binaries, server CPU and native dependencies in Instance settings → Extensions."
            raise Problem(message, error.status, error.detail) from None

    def mark_stale(
        self, context: Context, fingerprints: dict[str, str], generations: dict[str, str] | None = None
    ) -> None:
        """Mark results whose fingerprint changed stale, and interrupt lineage requests reading them."""
        with context.lock:
            changed = set()
            for dataset in context.datasets.values():
                if (generations or {}).get(dataset.id, fingerprints.get(dataset.node)) != dataset.fingerprint:
                    dataset.status = "stale"
                    changed.add(dataset.node)
            cancel_lineage(context, changed)

    def forget_removed(self, context: Context, nodes: Mapping[str, Record]) -> None:
        """Drop the results and states of nodes absent from the definitions, once no lineage
        request reads them. Only the run that owns the worktree may call this."""
        from ..partition_storage import PartitionStorage

        partitioned = {key for key, node in nodes.items() if node.get("partitioned")}
        with context.lock:
            removed = {d.node for d in context.datasets.values()}
            removed |= {*context.outputs, *context.errors, *context.node_status, *context.result_runs}
            removed -= set(nodes)
            if not removed:
                PartitionStorage(self.store, context.worktree, context.environment).forget_removed(
                    partitioned,
                    {d.artifact_id for d in context.datasets.values() if d.artifact_id},
                )
                return
            for dataset in context.datasets.values():
                if dataset.node in removed:
                    dataset.status = "stale"
            cancel_lineage(context, removed, dropping=True)
        wait_for_readers(context, removed)
        with context.lock:
            assert context.db is not None
            cleanup = context.db.cursor()
            try:
                for dataset in [d for d in context.datasets.values() if d.node in removed]:
                    drop_dataset(cleanup, dataset)
                    del context.datasets[dataset.id]
            finally:
                cleanup.close()
            for node in removed:
                for states in (context.outputs, context.errors, context.node_status, context.result_runs):
                    states.pop(node, None)
            PartitionStorage(self.store, context.worktree, context.environment).forget_removed(
                partitioned,
                {d.artifact_id for d in context.datasets.values() if d.artifact_id},
            )

    def discard(self, worktree: str) -> None:
        """Close every environment context of a worktree, even after the worktree was removed."""
        with self.lock:
            for key, context in list(self.contexts.items()):
                if context.worktree == worktree:
                    with context.lock:
                        cancel_lineage(context)
                        if context.db:
                            context.db.close()
                        del self.contexts[key]

    def close(self) -> None:
        with self.lock:
            contexts = list(self.contexts.values())
            self.contexts.clear()
        for context in contexts:
            if context.db:
                context.db.close()
