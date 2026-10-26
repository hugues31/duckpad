"""Embedded execution service with atomic admission and immutable launch snapshots."""

import copy
import threading
import time
from dataclasses import dataclass, field

import duckdb

from .components import expand
from .materialize import drop_dataset, plan_materialization, publish_view
from .projects import computational, topological
from .templates import compile_template
from .util import Problem, clean, digest, now, qi, uid


@dataclass
class Dataset:
    id: str
    node: str
    port: str
    table: str
    columns: list
    count: int
    run: str
    query: str
    bindings: dict
    dependencies: dict
    fingerprint: str
    source: bool = False
    status: str = "valid"
    created: str = field(default_factory=now)
    storage: str = ""
    column_map: dict = field(default_factory=dict)
    witnesses: dict = field(default_factory=dict)
    groups: dict = field(default_factory=dict)

    def public(self):
        return {
            key: getattr(self, key)
            for key in ("id", "node", "port", "columns", "count", "run", "status", "created")
        }


@dataclass
class Context:
    worktree: str
    environment: str
    db: object = field(default_factory=lambda: duckdb.connect(":memory:"))
    outputs: dict = field(default_factory=dict)
    datasets: dict = field(default_factory=dict)
    errors: dict = field(default_factory=dict)
    node_status: dict = field(default_factory=dict)
    lineage: dict = field(default_factory=dict)
    lock: object = field(default_factory=threading.RLock)
    trace_lock: object = field(default_factory=threading.RLock)


class Engine:
    def __init__(self, store, projects, catalog, access=None):
        self.access = access
        self.store, self.projects, self.catalog = store, projects, catalog
        self.lock = threading.RLock()
        self.contexts, self.active = {}, {}
        self.threads = []
        for run in store.all("run"):
            if run["status"] in ("preparing", "running", "canceling"):
                run["status"] = "interrupted"
                run["error"] = (
                    "The backend stopped before completion was confirmed. Manual recomputation is required."
                )
                for node in run.get("nodes", {}).values():
                    if node["status"] == "running":
                        node["status"] = "interrupted"
                        if node.get("kind") == "export":
                            node["external_outcome"] = "unknown"
                store.put("run", run["id"], run)

    def context(self, worktree, environment, create=False):
        with self.lock:
            key = (worktree, environment)
            if key not in self.contexts or getattr(self.contexts[key].db, "closed", False):
                self.contexts[key] = Context(*key, db=None)
            if self.contexts[key].db is None and (create or not self.access):
                extensions = self.store.home / "extensions"
                extensions.mkdir(exist_ok=True)
                if self.access:
                    from .sandbox import Database

                    project = self.projects.get(worktree)["project"]
                    references = self.access.record(project)["connections"]
                    available = [
                        r
                        for r in references
                        if environment in self.store.get("connection", r, {}).get("environments", {})
                    ]
                    captured, _ = self.catalog.capture(available, environment)
                    roots, writable = self.access.local_roots(project, captured)
                    directory = self.store.home / "exports" / worktree / environment
                    directory.mkdir(parents=True, exist_ok=True)
                    temporary = directory / ".temporary"
                    temporary.mkdir(exist_ok=True)
                    # Provision only trusted administrator-declared extensions,
                    # before giving the worker read-only access to their cache.
                    if any(c["definition"].get("extensions") for c in captured.values()):
                        with duckdb.connect(config={"extension_directory": str(extensions)}) as setup:
                            self.catalog.prepare(setup, captured)
                    database = Database(
                        {
                            "captured": captured,
                            "extensions": str(extensions),
                            "read_paths": [str(p) for p in roots],
                            "write_paths": [str(p) for p in [*writable, directory]],
                            "temporary": str(temporary),
                            "remote_paths": ["s3://"]
                            if any(c["definition"]["id"] == "s3" for c in captured.values())
                            else [],
                        }
                    )
                else:
                    database = duckdb.connect(":memory:", config={"extension_directory": str(extensions)})
                self.contexts[key].db = database
            return self.contexts[key]

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
            worktrees = {w["id"] for w in self.store.all("worktree") if w["project"] == project}
            if worktrees & self.active.keys():
                raise Problem(
                    "Stop active executions before changing project connections or deleting the project", 409
                )
            for key, context in list(self.contexts.items()):
                if context.worktree in worktrees:
                    with context.lock:
                        self.cancel_lineage(context, {d.node for d in context.datasets.values()})
                        if context.db:
                            context.db.close()
                        del self.contexts[key]

    def fingerprints(self, bundle, environment, captured=None):
        nodes, edges, _ = expand(bundle, tolerant=True)
        fingerprints = {}
        for key in topological(nodes, edges, tolerant=True):
            node = nodes[key]
            connections = {}
            for p in node["parsed"]["parameters"]:
                if p["type"] == "connection":
                    ref = node.get("params", {}).get(p["name"], p.get("default"))
                    try:
                        values = captured or self.catalog.capture([ref], environment)[0]
                        connections[ref] = values[ref]["fingerprint"]
                    except (Problem, KeyError) as error:
                        connections[ref] = "invalid:" + str(error)
            executable = computational(
                {"flow": {}, "components": {}, "templates": {"sql": node["template_sql"]}}
            )["templates"]["sql"]
            fingerprints[key] = digest(
                {
                    "sql": executable,
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

    def invalidate(self, worktree=None):
        with self.lock:
            contexts = list(self.contexts.values())
        for context in contexts:
            if worktree and context.worktree != worktree:
                continue
            snapshot = self.projects.snapshot(context.worktree, committed=True)
            try:
                fingerprints = self.fingerprints(snapshot["bundle"], context.environment)
            except Exception:
                fingerprints = {}
            with context.lock:
                changed = set()
                for dataset in context.datasets.values():
                    if fingerprints.get(dataset.node) != dataset.fingerprint:
                        dataset.status = "stale"
                        changed.add(dataset.node)
                self.cancel_lineage(context, changed)

    def cancel_lineage(self, context, affected):
        for request in list(context.lineage.values()):
            if request["nodes"] & affected:
                request["canceled"].set()
                request["cursor"].interrupt()

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

    def launch(self, worktree_id, environment, target=None, entry_point="api"):
        if environment not in self.store.get("settings", "environments", []):
            raise Problem("Unknown environment")
        run_id = uid("run_")
        token = {"id": run_id, "cancel": threading.Event(), "cursor": None}
        with self.lock:
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
            nodes, edges, boundaries = expand(bundle, tolerant=True)
            order = topological(nodes, edges, tolerant=True)
            if target:
                scope = {n for n in nodes if n == target or n.startswith(target + "::")}
                if not scope:
                    raise Problem("Node not found", 404)
                while True:
                    extended = scope | {e["source"] for e in edges if e["target"] in scope}
                    if extended == scope:
                        break
                    scope = extended
                order = [n for n in order if n in scope]
            else:
                scope = set(nodes)
            for conflict in snapshot["conflicts"]:
                from .projects import files_to_bundle

                try:
                    current = self.fingerprints(files_to_bundle(conflict["current"]), environment)
                    proposed = self.fingerprints(files_to_bundle(conflict["proposal"]), environment)
                    computation_conflict = any(current.get(n) != proposed.get(n) for n in scope)
                except Exception:
                    computation_conflict = True
                if computation_conflict:
                    raise Problem("Resolve computation-affecting edit conflicts before running", 409)
            captured, secrets = {}, []
            for key in scope:
                node = nodes[key]
                references = [
                    node.get("params", {}).get(p["name"], p.get("default"))
                    for p in node["parsed"]["parameters"]
                    if p["type"] == "connection"
                ]
                try:
                    values, hidden = self.capture(worktree_id, references, environment)
                    captured.update(values)
                    secrets.extend(hidden)
                except Problem as error:
                    node["error"] = str(error)
                if target and node.get("error"):
                    raise Problem(node["error"], 422)
            fingerprints = self.fingerprints(bundle, environment, captured)
            context = self.context(worktree_id, environment, create=True)
            affected = set(scope)
            while True:
                extended = affected | {e["target"] for e in edges if e["source"] in affected}
                if extended == affected:
                    break
                affected = extended
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
            thread = threading.Thread(
                target=self._execute,
                args=(token, context, run, nodes, edges, order, captured, secrets, fingerprints),
                name=run_id,
                daemon=True,
            )
            self.threads = [t for t in self.threads if t.is_alive()] + [thread]
            thread.start()
            return self.store.get("run", run_id)
        except Exception:
            with self.lock:
                self.active.pop(worktree_id, None)
            raise

    def _persist(self, run, secrets):
        token = self.active.get(run["worktree"])
        if token and token["cancel"].is_set() and run["status"] in ("preparing", "running"):
            run["status"] = "canceling"

        def sanitize(value):
            if isinstance(value, str):
                return self.catalog.redact(value, secrets)
            if isinstance(value, dict):
                return {key: sanitize(item) for key, item in value.items()}
            if isinstance(value, list):
                return [sanitize(item) for item in value]
            return value

        self.store.put("run", run["id"], sanitize(run))
        context = self.contexts.get((run["worktree"], run["environment"]))
        if context:
            with context.lock:
                context.node_status.update({key: state["status"] for key, state in run["nodes"].items()})

    def _execute(self, token, context, run, nodes, edges, order, captured, secrets, fingerprints):
        started = time.monotonic()
        cursor = None
        published = {}
        prepared = {}
        try:
            cursor = context.db.cursor()
            token["cursor"] = cursor
            run["status"] = "running"
            self._persist(run, secrets)
            for key in order:
                node, state = nodes[key], run["nodes"][key]
                incoming = [e for e in edges if e["target"] == key]
                if token["cancel"].is_set():
                    state["status"] = "canceled"
                    self._persist(run, secrets)
                    continue
                if node.get("error"):
                    state.update(status="blocked", error=node["error"])
                    context.errors[key] = node["error"]
                    self._persist(run, secrets)
                    continue
                failed = [e["source"] for e in incoming if run["nodes"][e["source"]]["status"] != "success"]
                if failed:
                    state.update(status="blocked", error="Blocked by " + ", ".join(failed))
                    context.errors[key] = state["error"]
                    self._persist(run, secrets)
                    continue
                state.update(status="running", started=now(), parameters=node.get("params", {}))
                if node["parsed"]["kind"] == "export":
                    state["external_outcome"] = "unknown"
                self._persist(run, secrets)
                node_start = time.monotonic()
                staged = {}
                created_tables = []
                try:
                    for parameter in node["parsed"]["parameters"]:
                        if parameter["type"] == "connection":
                            reference = node.get("params", {}).get(
                                parameter["name"], parameter.get("default")
                            )
                            if reference not in prepared:
                                try:
                                    if not self.access:
                                        self.catalog.prepare(cursor, {reference: captured[reference]})
                                    prepared[reference] = None
                                except Exception as error:
                                    prepared[reference] = error
                            if prepared[reference]:
                                raise prepared[reference]
                    input_datasets = {
                        e["targetHandle"]: published[e["source"]][e["sourceHandle"]] for e in incoming
                    }
                    physical = {port: uid("data_") for port in node["parsed"]["outputs"]}
                    directory = self.store.home / "exports" / context.worktree / context.environment
                    directory.mkdir(parents=True, exist_ok=True)
                    statements = compile_template(
                        node["parsed"],
                        node.get("params", {}),
                        {port: qi(data.table) for port, data in input_datasets.items()},
                        physical,
                        captured,
                        directory,
                    )
                    state["statements"] = statements
                    self._persist(run, secrets)
                    for statement in statements:
                        if token["cancel"].is_set():
                            raise Problem("Execution canceled")
                        if statement["output"]:
                            table = statement["table"]
                            data_inputs = {
                                data.table: data for data in [*input_datasets.values(), *staged.values()]
                            }
                            plan = plan_materialization(
                                cursor, statement, data_inputs, instrument=node["parsed"]["kind"] != "source"
                            )
                            statement["materialization_sql"] = [plan["sql"]]
                            self._persist(run, secrets)
                            cursor.execute(plan["sql"], statement["bindings"])
                            created_tables.append((table, plan["storage"]))
                            columns, column_map, view_sql = publish_view(cursor, table, plan)
                            statement["materialization_sql"].extend(view_sql)
                            count = cursor.execute(f"SELECT count(*) FROM {qi(table)}").fetchone()[0]
                            dependencies = {data.table: data.id for data in data_inputs.values()}
                            staged[statement["output"]] = Dataset(
                                table,
                                key,
                                statement["output"],
                                table,
                                columns,
                                count,
                                run["id"],
                                statement["query"],
                                statement["bindings"],
                                dependencies,
                                fingerprints[key],
                                source=node["parsed"]["kind"] == "source",
                                storage=plan["storage"],
                                column_map=column_map,
                                witnesses=plan["witnesses"],
                                groups=plan["groups"],
                            )
                        else:
                            state["external_started"] = True
                            cursor.execute(statement["sql"], statement["bindings"])
                            state["external_outcome"] = "completed"
                    if token["cancel"].is_set():
                        raise Problem("Execution canceled after the active SQL operation ended")
                    # A later edit must not turn a result for the old snapshot valid.
                    with self.projects.lock:
                        latest = self.projects.snapshot(context.worktree, committed=True)
                        try:
                            current_fingerprints = self.fingerprints(latest["bundle"], context.environment)
                        except Exception:
                            current_fingerprints = {}
                        with self.lock, context.lock:
                            if token["cancel"].is_set():
                                raise Problem("Execution canceled before publication")
                            previous = context.outputs.get(key, {})
                            for dataset in staged.values():
                                if current_fingerprints.get(key) != dataset.fingerprint:
                                    dataset.status = "stale"
                                context.datasets[dataset.id] = dataset
                            context.outputs[key] = staged
                            context.errors.pop(key, None)
                            published[key] = staged
                            created_tables.clear()
                    # Old tables are retained only until no active lineage reader can
                    # access them. Readers acknowledge cancellation in their finally.
                    for dataset in previous.values():
                        while any(dataset.node in r["nodes"] for r in list(context.lineage.values())):
                            time.sleep(0.005)
                        with context.lock:
                            retired = [
                                dataset,
                                *[
                                    d
                                    for d in context.datasets.values()
                                    if d.id.startswith("trace_") and d.node == key and d.run != run["id"]
                                ],
                            ]
                            cleanup = context.db.cursor()
                            try:
                                for old in retired:
                                    drop_dataset(cleanup, old)
                                    context.datasets.pop(old.id, None)
                            finally:
                                cleanup.close()
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
                                    cleanup.execute(f"DROP VIEW IF EXISTS {qi(table)}")
                                    cleanup.execute(f"DROP TABLE IF EXISTS {qi(storage)}")
                            finally:
                                cleanup.close()
                        except (duckdb.Error, Problem):
                            # A dead worker has already discarded its tables.
                            pass
                    message = self.catalog.redact(str(error), secrets)
                    state.update(status="canceled" if token["cancel"].is_set() else "failed", error=message)
                    context.errors[key] = message
                    if state.get("kind") == "export" and state.get("external_outcome") != "completed":
                        state["external_outcome"] = (
                            "partial or unknown" if state.get("external_started") else "failed"
                        )
                state.update(finished=now(), duration=time.monotonic() - node_start)
                self._persist(run, secrets)
            outcomes = {n["status"] for n in run["nodes"].values()}
            run["status"] = (
                "canceled"
                if token["cancel"].is_set()
                else "partial_failure"
                if outcomes & {"failed", "blocked"} and "success" in outcomes
                else "failed"
                if outcomes & {"failed", "blocked"}
                else "success"
            )
        except Exception as error:
            run.update(
                status="canceled" if token["cancel"].is_set() else "failed",
                error=self.catalog.redact(str(error), secrets),
            )
            for state in run["nodes"].values():
                if state["status"] in ("pending", "running"):
                    state["status"] = "canceled" if token["cancel"].is_set() else "blocked"
        finally:
            with self.lock:
                if cursor:
                    try:
                        cursor.close()
                    except (duckdb.Error, Problem):
                        pass
                token["cursor"] = None
                if token["cancel"].is_set():
                    run["status"] = "canceled"
                run.update(finished=now(), duration=time.monotonic() - started)
                self._persist(run, secrets)
                self.active.pop(context.worktree, None)

    def cancel(self, run_id):
        with self.lock:
            run = self.store.get("run", run_id)
            if not run:
                raise Problem("Execution not found", 404)
            token = self.active.get(run["worktree"])
            if token and token["id"] == run_id:
                token["cancel"].set()
                if token["cursor"]:
                    token["cursor"].interrupt()
                run["status"] = "canceling"
                self.store.put("run", run_id, run)
        return run

    def cleanup_column_docs(self, worktree, node, outputs, environment):
        """Prune only against a schema resolved by a successful publication."""
        from .projects import bundle_to_files

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
            where.append(f"CAST({qi(dataset.column_map.get(column, column))} AS VARCHAR) ILIKE ?")
            values.append("%" + str(value) + "%")
        condition = " WHERE " + " AND ".join(where) if where else ""
        order = (
            f"{qi(dataset.column_map.get(sort, sort))} {'DESC' if descending else 'ASC'}, rowid"
            if sort
            else "rowid"
        )
        with context.lock:
            cursor = context.db.cursor()
            projection = ", ".join(qi(dataset.column_map.get(c, c)) for c in columns)
            try:
                count = cursor.execute(
                    f"SELECT COUNT(*) FROM {qi(dataset.storage or dataset.table)}{condition}", values
                ).fetchone()[0]
                rows = cursor.execute(
                    f"SELECT rowid, {projection} FROM {qi(dataset.storage or dataset.table)}{condition} ORDER BY {order} LIMIT ? OFFSET ?",
                    [*values, max(1, min(limit, 10000)), max(0, offset)],
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
        if not snapshot["bundle"]:
            raise Problem("Project files are invalid")
        nodes, edges, _ = expand(snapshot["bundle"])
        selected = [key for key in nodes if key == node_id or key.startswith(node_id + "::")]
        if not selected:
            raise Problem("Node not found", 404)
        output = []
        for key in selected:
            node = nodes[key]
            refs = [
                node.get("params", {}).get(p["name"], p.get("default"))
                for p in node["parsed"]["parameters"]
                if p["type"] == "connection"
            ]
            captured, secrets = self.capture(worktree, refs, environment)
            inputs = {
                e["targetHandle"]: qi("input_" + e["source"].replace("::", "_") + "_" + e["sourceHandle"])
                for e in edges
                if e["target"] == key
            }
            for port in node["parsed"]["inputs"]:
                if port not in inputs:
                    raise Problem(f"Connect input {port} before compiling")
            statements = compile_template(
                node["parsed"],
                node.get("params", {}),
                inputs,
                {p: "output_" + p for p in node["parsed"]["outputs"]},
                captured,
                self.store.home / "exports" / worktree / environment,
            )
            for statement in statements:
                statement["sql"] = self.catalog.redact(statement["sql"], secrets)
            output.extend(statements)
        return output

    def close(self):
        for token in list(self.active.values()):
            self.cancel(token["id"])
        for thread in self.threads:
            thread.join()
        for context in self.contexts.values():
            if context.db:
                context.db.close()
