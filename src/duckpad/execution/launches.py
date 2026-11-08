"""Admission and immutable launch snapshots, including cancellable preparation."""

from __future__ import annotations

import copy
import threading
import time
from dataclasses import dataclass, field

from .. import partitions, project_extensions, value_sources, variables
from ..bundle import files_to_bundle
from ..catalog import Catalog, redact
from ..components import expand, expand_for, in_subtree
from ..datasets import Context, Dataset
from ..graph import connection_references, reachable, topological
from ..node_names import node_name_parts
from ..partition_storage import PartitionStorage
from ..projects import Projects
from ..python_policy import get_policy
from ..store import Store
from ..types import Connections, Record, RunToken, SQLCursor
from ..util import Problem, now
from .contexts import ContextPool, cancel_lineage
from .exports import Exports
from .fingerprints import Fingerprints
from .journal import RunJournal


@dataclass
class Admission:
    """Definitions and options of a launch, checked before any setup."""

    bundle: Record
    nodes: dict[str, Record]
    edges: list[Record]
    boundaries: Record
    plan: Record
    selection: Record | None
    policy: Record | None
    scope: set[str]
    python: bool


def blocking_error(node: Record) -> str | None:
    """A node error that refuses a targeted run; values calculated during the run come later."""
    deferred = any(
        binding.get("source") == "node" and "error" in binding
        for binding in [*node.get("variables", {}).values(), *variables.expression_bindings(node)]
    ) or str(node.get("error", "")).startswith("Partition values not calculated")
    return None if deferred or not node.get("error") else str(node["error"])


def launch_scope(
    nodes: dict[str, Record], edges: list[Record], target: str | None = None, ancestors: bool = False
) -> set[str]:
    """The nodes a launch computes: the whole project, or a node subtree and its upstream nodes.

    `ancestors` computes only the upstream nodes, which a node's preview reads.
    """
    if not target:
        if ancestors:
            raise Problem("Choose the node whose ancestors to run", 422)
        return set(nodes)
    scope = {n for n in nodes if in_subtree(n, target)}
    if not scope:
        raise Problem("Node not found", 404)
    upstream = reachable(scope, edges, upstream=True)
    if not ancestors:
        return upstream
    if not upstream - scope:
        raise Problem("This node has no upstream nodes to run", 422)
    return upstream - scope


def pending_value(source: Record) -> Record:
    return {
        "type": source["type"],
        "from": source["from"],
        "source": "node",
        "state": "pending",
        "resolution": "calculated",
    }


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
    bundle: Record = field(default_factory=dict)
    sources: Record = field(default_factory=dict)
    values: Record = field(default_factory=dict)
    value_phase: set[str] = field(default_factory=set)
    validation_errors: Record = field(default_factory=dict)
    cursor: SQLCursor | None = None
    prepared: dict[str, Exception | None] = field(default_factory=dict)
    # Parallel partition keys share one database: each connection is attached once.
    preparing: threading.Lock = field(default_factory=threading.Lock)
    published: dict[str, dict[str, Dataset]] = field(default_factory=dict)
    partition_plan: Record = field(default_factory=dict)
    partition: Record | None = None
    schema_only: bool = False

    @property
    def canceled(self) -> bool:
        return self.token["cancel"].is_set()


class LaunchPlanner:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        catalog: Catalog,
        pool: ContextPool,
        exports: Exports,
        fingerprints: Fingerprints,
        lock: threading.RLock,
        journal: RunJournal,
    ) -> None:
        self.store, self.projects, self.catalog = store, projects, catalog
        self.pool, self.exports, self.fingerprints = pool, exports, fingerprints
        self.lock, self.journal = lock, journal

    def check_launch(
        self,
        worktree: str,
        environment: str,
        target: str | None,
        entry_point: str,
        selection: Record | None,
        policy: Record | None,
        ancestors: bool,
    ) -> Admission:
        """Refuse an invalid request before recording a run, without starting any setup.

        Preparation checks the definitions again once pending saves are flushed.
        """
        self.catalog.environment(environment)
        snapshot = self.projects.snapshot(worktree, committed=True)
        admission = self.validate(
            snapshot, worktree, environment, target, entry_point, selection, policy, ancestors
        )
        self.check_conflicts(snapshot["conflicts"], admission.scope, environment)
        if target:
            values = self.pool.computed(worktree, environment, admission.bundle)
            nodes, _, _ = expand_for(admission.bundle, environment, computed=values)
            for key in admission.scope:
                try:
                    self.pool.connections.capture(worktree, connection_references(nodes[key]), environment)
                except Problem as error:
                    raise Problem(str(error), 422) from error
                if error := blocking_error(nodes[key]):
                    raise Problem(error, 422)
        return admission

    def validate(
        self,
        snapshot: Record,
        worktree: str,
        environment: str,
        target: str | None,
        entry_point: str,
        partition_selection: Record | None,
        partition_execution: Record | None,
        ancestors: bool,
    ) -> Admission:
        """Refuse definitions, options or settings a launch cannot run; reads no worker state."""
        if snapshot["bundle"] is None:
            raise Problem(
                "Project files are invalid; correct them before execution", 422, snapshot["diagnostics"]
            )
        bundle = copy.deepcopy(snapshot["bundle"])
        nodes, edges, boundaries = expand(bundle, tolerant=True)
        plan = partitions.plan(bundle, nodes, edges, boundaries)
        # Refuse invalid options before marking any result stale.
        selection, policy = partitions.launch_options(
            plan.get("dimension"), partition_selection, partition_execution
        )
        scope = self.partition_scope(
            worktree, environment, nodes, edges, launch_scope(nodes, edges, target, ancestors), plan
        )
        missing_inputs = []
        for diagnostic in snapshot["diagnostics"]:
            if diagnostic.get("code") != "missing_input":
                continue
            # A component input names its instance; the run needs the node behind it.
            exposed = boundaries.get(diagnostic["node"], {}).get("inputs", {}).get(diagnostic["port"])
            if (exposed[0] if exposed else diagnostic["node"]) in scope:
                missing_inputs.append(diagnostic)
        if entry_point == "ui" and missing_inputs:
            raise Problem(missing_inputs[0]["message"], 422, missing_inputs)
        python = any(nodes[key].get("language") == "python" for key in scope)
        if python and not get_policy(self.store, snapshot["worktree"]["project"]).get("enabled"):
            raise Problem("Python execution is disabled; ask an instance administrator to enable it", 403)
        return Admission(bundle, nodes, edges, boundaries, plan, selection, policy, scope, python)

    @staticmethod
    def check_canceled(token: RunToken) -> None:
        if token["cancel"].is_set():
            raise Problem("Execution canceled", 409)

    def start(
        self,
        token: RunToken,
        run: Record,
        target: str | None,
        partition_selection: Record | None,
        partition_execution: Record | None,
        ancestors: bool,
    ) -> Execution | None:
        from ..python_environment import preparation_cancellation

        started = time.monotonic()
        try:
            with preparation_cancellation(token["cancel"]):
                self.check_canceled(token)
                execution = self.prepare(
                    token,
                    run["worktree"],
                    run["environment"],
                    target,
                    run["entry_point"],
                    partition_selection,
                    partition_execution,
                    ancestors,
                )
                self.check_canceled(token)
            for key in ("started", "requester", "trigger", "job", "tag", "external_trigger"):
                if key in run:
                    execution.run[key] = run[key]
            self.journal.persist(execution.run, execution.secrets)
        except Exception as error:
            context = self.pool.find(run["worktree"], run["environment"])
            secrets = context.secrets if context else []
            with self.lock:
                try:
                    run.update(
                        status="canceled" if token["cancel"].is_set() else "failed",
                        error=redact(str(error), secrets),
                        finished=now(),
                        duration=time.monotonic() - started,
                    )
                    if isinstance(error, Problem):
                        run["error_detail"] = error.detail
                    self.journal.persist(run, secrets)
                finally:
                    self.journal.active.pop(run["worktree"], None)
            return None
        return execution

    def partition_scope(
        self,
        worktree: str,
        environment: str,
        nodes: dict[str, Record],
        edges: list[Record],
        scope: set[str],
        plan: Record,
    ) -> set[str]:
        """A targeted run in a zone also calculates the key list while none is retained."""
        source, dimension = plan.get("source"), plan.get("dimension")
        if (
            not source
            or not dimension
            or source["node"] in scope
            or not any(nodes[k].get("partitioned") or nodes[k].get("partition_collect_inputs") for k in scope)
            or PartitionStorage(self.store, worktree, environment).manifest(
                signature=partitions.signature(dimension)
            )
        ):
            return scope
        return scope | reachable({source["node"]}, edges, upstream=True)

    def prepare(
        self,
        token: RunToken,
        worktree: str,
        environment: str,
        target: str | None,
        entry_point: str,
        partition_selection: Record | None = None,
        partition_execution: Record | None = None,
        ancestors: bool = False,
    ) -> Execution:
        """Capture the committed definitions and connection settings the run will use."""
        self.check_canceled(token)
        snapshot = self.projects.flush(worktree)
        self.check_canceled(token)
        admission = self.validate(
            snapshot,
            worktree,
            environment,
            target,
            entry_point,
            partition_selection,
            partition_execution,
            ancestors,
        )
        bundle, partition_plan, needs_python = admission.bundle, admission.plan, admission.python
        sources = value_sources.sources(bundle, admission.nodes, admission.boundaries)
        phase, validation_errors = value_sources.dependencies(admission.nodes, admission.edges, sources)
        phase |= partition_plan["value_phase"]
        if needs_python:
            snapshot = self.lock_python(snapshot, bundle, token)
        context = self.open_context(worktree, environment, bundle, token, needs_python)
        values = self.pool.computed(worktree, environment, bundle)
        nodes, edges, _ = expand_for(bundle, environment, computed=values)
        scope = self.partition_scope(
            worktree, environment, nodes, edges, launch_scope(nodes, edges, target, ancestors), partition_plan
        )
        order = [n for n in topological(nodes, edges, tolerant=True) if n in scope]
        self.check_conflicts(snapshot["conflicts"], scope, environment)
        captured, secrets = self.capture_connections(context, nodes, scope, strict=bool(target))
        fingerprints = self.fingerprints.of(bundle, environment, captured, values)
        affected = reachable(scope, edges, upstream=False)
        self.exports.mark_stale(worktree, environment, affected - scope)
        with context.lock:
            cancel_lineage(context, affected)
            for dataset in context.datasets.values():
                if dataset.node in affected:
                    dataset.status = "stale"
                    dataset.value_stale = False
        execution = Execution(
            token,
            context,
            {},
            nodes,
            edges,
            order,
            captured,
            secrets,
            fingerprints,
            bundle=bundle,
            sources=sources,
            values=values,
            value_phase=phase & scope,
            validation_errors=validation_errors,
            partition_plan=partition_plan,
        )
        execution.run = self.snapshot_run(
            execution, snapshot, admission, scope, target, entry_point, ancestors
        )
        return execution

    @staticmethod
    def snapshot_run(
        execution: Execution,
        snapshot: Record,
        admission: Admission,
        scope: set[str],
        target: str | None,
        entry_point: str,
        ancestors: bool,
    ) -> Record:
        token, context, bundle = execution.token, execution.context, execution.bundle
        worktree, environment = context.worktree, context.environment
        nodes, order, values = execution.nodes, execution.order, execution.values
        captured, fingerprints, sources = execution.captured, execution.fingerprints, execution.sources
        run = LaunchPlanner.pending(
            snapshot["worktree"],
            admission,
            token,
            worktree,
            environment,
            target,
            entry_point,
            None,
            None,
            None,
            ancestors,
        )
        run.update(
            {
                "commit": snapshot["commit"],
                "revision": snapshot["revision"],
                "nodes": {
                    n: {
                        "status": "pending",
                        "label": nodes[n]["display_name"],
                        "writes_external": nodes[n]["parsed"]["writes_external"],
                        "fingerprint": fingerprints[n],
                        "results": [],
                        **variables.run_usages(nodes[n]),
                    }
                    for n in order
                },
                "variables": variables.used(bundle, nodes, scope, environment, values),
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
        )
        for name, source in sources.items():
            if source.get("node") in scope:
                run["variables"][name] = pending_value(source)
        return run

    def scope_variables(
        self, worktree: str, environment: str, target: str | None = None, ancestors: bool = False
    ) -> Record:
        """Variables a launch would use, with their values and sources in this environment."""
        self.catalog.environment(environment)
        snapshot = self.projects.snapshot(worktree)
        if snapshot["bundle"] is None:
            return {}
        bundle = snapshot["bundle"]
        values = self.pool.computed(worktree, environment, bundle)
        nodes, edges, boundaries = expand_for(bundle, environment, computed=values)
        plan = partitions.plan(bundle, nodes, edges, boundaries)
        scope = self.partition_scope(
            worktree, environment, nodes, edges, launch_scope(nodes, edges, target, ancestors), plan
        )
        result = variables.used(bundle, nodes, scope, environment, values)
        for name, source in value_sources.sources(bundle, nodes, boundaries).items():
            if source.get("node") in scope:
                result[name] = pending_value(source)
        dimension = partitions.definition(bundle["flow"])
        if dimension:
            manifest = PartitionStorage(self.store, worktree, environment).manifest(
                signature=partitions.signature(dimension)
            )
            source = plan.get("source")
            pending = bool(source and source["node"] in scope)
            result["$partition"] = {
                "type": dimension["type"],
                "from": source.get("from") if source else dimension["values"],
                "source": "node",
                "state": "pending" if pending else "ready" if manifest else "unavailable",
                "resolution": "calculated" if pending else "retained",
                "manifest": manifest["id"] if manifest else None,
                "count": manifest["count"] if manifest else None,
            }
        return result

    def check_conflicts(self, conflicts: list[Record], scope: set[str], environment: str) -> None:
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

    def capture_connections(
        self, context: Context, nodes: dict[str, Record], scope: set[str], strict: bool
    ) -> tuple[Connections, list[str]]:
        """Freeze connection settings for the scope; invalid ones block their nodes (or the run if strict).

        An isolated run uses the settings its worker attached, which its fingerprints then describe.
        """
        captured: Connections = {}
        secrets: list[str] = list(context.secrets)
        for key in scope:
            node = nodes[key]
            references = connection_references(node)
            try:
                captured.update(self.pool.connections.for_context(context, references, secrets))
            except Problem as error:
                node["error"] = str(error)
                if strict:
                    raise Problem(str(error), 422) from error
            if strict and (error := blocking_error(node)):
                raise Problem(error, 422)
        return captured, secrets

    @staticmethod
    def pending(
        record: Record,
        admission: Admission,
        token: RunToken,
        worktree: str,
        environment: str,
        target: str | None,
        entry_point: str,
        requester: Record | None,
        job: Record | None,
        external_trigger: Record | None,
        ancestors: bool,
    ) -> Record:
        run: Record = {
            "id": token["id"],
            "worktree": worktree,
            "project": record["project"],
            "branch": record["branch"],
            "environment": environment,
            "commit": "",
            "revision": "",
            "scope": target or "project",
            "scope_name": node_name_parts(admission.bundle, target) if target else [],
            "trigger": "manual",
            "entry_point": entry_point,
            "status": "preparing",
            "started": now(),
            "nodes": {},
            "variables": {},
            "connections": {},
            "requester": copy.deepcopy(requester),
            **({"ancestors": True} if ancestors else {}),
            **({"partition_selection": admission.selection} if admission.selection else {}),
            **({"partition_execution": admission.policy} if admission.policy else {}),
        }
        if job is not None:
            run.update(trigger="job", job=copy.deepcopy(job), tag=job.get("tag"))
            run["commit"] = job["commit"]
            run["external_trigger"] = copy.deepcopy(external_trigger)
        return run

    def lock_python(self, snapshot: Record, bundle: Record, token: RunToken) -> Record:
        worktree = snapshot["worktree"]["id"]
        from ..python_environment import lock_files

        settings = get_policy(self.store, snapshot["worktree"]["project"])
        files = snapshot["files"]
        locked = lock_files(
            files,
            self.store.home,
            read_only=bool(snapshot["worktree"].get("read_only")),
            project=snapshot["worktree"]["project"],
            allow_builds=settings.get("allow_builds", False),
        )
        self.check_canceled(token)
        if locked != files.get("uv.lock"):
            snapshot = self.projects.write(
                worktree,
                snapshot["revision"],
                {**files, "uv.lock": locked},
                message="build(project): lock Python dependencies",
            )
        bundle["python_lock"] = snapshot["files"].get("uv.lock")
        return snapshot

    def open_context(
        self, worktree: str, environment: str, bundle: Record, token: RunToken, needs_python: bool
    ) -> Context:
        requirements = project_extensions.enabled(bundle.get("extensions"))
        self.check_canceled(token)
        context = self.pool.restart_for_run(
            worktree, environment, requirements=requirements, python=needs_python
        )
        self.check_canceled(token)
        self.pool.renew(context, python=needs_python)
        self.check_canceled(token)
        if getattr(context.db, "closed", False):
            # The results could not move to a worker with the new connections or environment.
            context = self.pool.restart_for_run(
                worktree, environment, requirements=requirements, python=needs_python
            )
        self.check_canceled(token)
        return context

    def reserve(self, worktree: str, environment: str, token: RunToken) -> None:
        """Reserve admission under the runner lock, before publishing the preparing record."""
        with self.lock:
            self.catalog.environment(environment)
            if worktree in self.journal.active:
                raise Problem(
                    "This worktree already has an active execution. Wait or stop it before running again.",
                    409,
                    {"run": self.journal.active[worktree]["id"]},
                )
            self.journal.active[worktree] = token
