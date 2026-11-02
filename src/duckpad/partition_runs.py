"""Partition-major execution inside the ordinary Runner and SQL session."""

import copy
import threading
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import replace

from . import partitions, variables
from .bundle import topological
from .catalog import redact
from .components import expand_for
from .datasets import Dataset
from .graph import reachable
from .materialize import drop_dataset
from .native import Cursor as NativeCursor
from .partition_storage import PartitionStorage
from .templates import compile_template
from .types import Record
from .util import Problem, digest, now, qi, uid


class PartitionRun:
    def __init__(self, runner, execution):
        self.runner, self.execution = runner, execution
        self.storage = PartitionStorage(
            runner.store.paths, execution.context.worktree, execution.context.environment
        )
        self.plan = execution.partition_plan
        self.dimension = self.plan["dimension"]
        self.entries = []
        self.manifest: Record | None = None
        self.lock = threading.RLock()
        self.active = set()
        self.stopped = False
        self.schemas = {}
        self.saved = {}
        self.root = execution.run
        self.selection = self.root.get("partition_selection", {"mode": "all"})
        self.policy = {
            **(self.dimension or {}).get("execution", {}),
            **self.root.get("partition_execution", {}),
        }
        self.preview_bytes = 0
        self.partitioned = {k for k in execution.order if execution.nodes[k].get("partitioned")}
        self.required = {
            (e["source"], e["sourceHandle"])
            for e in execution.edges
            if e["target"] in execution.order
            and e["targetHandle"] in execution.nodes[e["target"]].get("partition_collect_inputs", [])
        }
        self.root["partitions"] = {
            "dimension": self.dimension,
            "phase": "values",
            "total": 0,
            "selected": 0,
            "completed": 0,
            "failed": 0,
            "not_started": 0,
            "execution": self.policy,
        }
        for key in self.partitioned:
            self.root["nodes"][key]["partitioned"] = True

    def resolve(self):
        execution, source = self.execution, self.plan["source"]
        if not source or not self.dimension:
            raise Problem("partition_definition: partition values have no valid source")
        signature = digest({k: self.dimension.get(k) for k in ("type", "values", "attributes")})
        if source["node"] in execution.order:
            if self.root["nodes"][source["node"]]["status"] != "success":
                raise Problem("partition_not_calculated: the partition value source failed")
            dataset = execution.published[source["node"]][source["port"]]
            self.entries, schema = partitions.extract(
                execution.cursor, dataset, self.dimension, source, self.root
            )
            self.manifest = {
                "id": uid("manifest_"),
                "signature": signature,
                "run": self.root["id"],
                "source": source,
                "dimension": self.dimension,
                "schema": schema,
                "count": len(self.entries),
                "created": now(),
            }
            self.storage.publish_manifest(self.manifest, self.entries)
        else:
            self.manifest = self.storage.manifest(signature=signature)
            if self.manifest is None:
                raise Problem(
                    f"partition_not_calculated: Partition values not calculated; run {source['from']['node']}"
                )
            self.entries = self.storage.entries(self.manifest["id"])
        self.root["partitions"].update(
            manifest=self.manifest["id"], total=len(self.entries), phase="consumers", source=source
        )
        execution.fingerprints = self.runner.fingerprints.of(
            execution.bundle,
            execution.context.environment,
            execution.captured,
            execution.values,
            manifest=self.entries,
        )
        for key in execution.order:
            self.root["nodes"][key]["fingerprint"] = execution.fingerprints.get(key)
        self.runner.fingerprints.invalidate(execution.context)
        self.selected = self.select() if self.partitioned else []
        self.root["partitions"]["selected"] = len(self.selected)
        self.preflight()

    def select(self):
        mode = self.selection["mode"]
        if mode == "all":
            return self.entries
        if mode == "selected":
            wanted = {partitions.identity(k) for k in self.selection["keys"]}
            available = {e["key_hash"] for e in self.entries}
            if wanted - available:
                raise Problem("partition_selection: selected keys are absent from the refreshed manifest")
            return [e for e in self.entries if e["key_hash"] in wanted]
        selected = []
        for entry in self.entries:
            results = {k: self.storage.result(k, entry["key_hash"]) for k in self.partitioned}
            if mode == "failed":
                included = any(
                    r.get("attempt", {}).get("status") in ("failed", "blocked", "interrupted", "canceled")
                    for r in results.values()
                )
            else:
                included = any(
                    not r.get("success")
                    or r.get("attempt", {}).get("status") in ("interrupted", "not_started", "canceled")
                    or any(
                        not self.storage.available(r["success"].get("artifacts", {}).get(port))
                        for node, port in self.required
                        if node == k
                    )
                    for k, r in results.items()
                )
            if included:
                selected.append(entry)
        return selected

    def preflight(self):
        """Resolve all file destinations against the whole manifest before any export."""
        execution = self.execution
        destinations = {}
        for entry in self.entries:
            nodes, _, _ = expand_for(
                execution.bundle, execution.context.environment, computed=execution.values, partition=entry
            )
            for key in self.partitioned:
                node = nodes[key]
                if node["parsed"]["kind"] != "export" or node.get("error"):
                    continue
                statements = compile_template(
                    node["parsed"],
                    node.get("params", {}),
                    {p: qi("preflight_" + p) for p in node["parsed"]["inputs"]},
                    {},
                    execution.captured,
                    self.runner.store.paths.project_files(
                        self.root["project"], execution.context.worktree, execution.context.environment
                    ),
                    variables=variables.expression_values(node),
                    bound=node.get("variables"),
                )
                for statement in statements:
                    file = statement.get("export_file")
                    if file:
                        path = file["path"]
                        previous = destinations.get(path)
                        owner = (key, entry["key_hash"])
                        if previous is not None and previous != owner:
                            raise Problem(
                                f"partition_destination: distinct partition exports resolve to the same destination on {key}"
                            )
                        destinations[path] = owner

    def units(self):
        """Contract each partition zone, leaving explicit collection barriers between zones."""
        execution = self.execution
        parent = {k: k for k in self.partitioned}

        def root(key):
            while parent[key] != key:
                parent[key] = parent[parent[key]]
                key = parent[key]
            return key

        for edge in execution.edges:
            a, b = edge["source"], edge["target"]
            if (
                a in parent
                and b in parent
                and edge["targetHandle"] not in execution.nodes[b].get("partition_collect_inputs", [])
            ):
                parent[root(b)] = root(a)
        owners = {k: root(k) if k in parent else k for k in execution.order}
        groups = {}
        for key in execution.order:
            groups.setdefault(owners[key], []).append(key)
        edges = [
            {"source": owners[e["source"]], "target": owners[e["target"]]}
            for e in execution.edges
            if e["source"] in owners and e["target"] in owners and owners[e["source"]] != owners[e["target"]]
        ]
        return [groups[k] for k in topological(groups, edges)]

    def execute(self):
        execution = self.execution
        try:
            self.resolve()
        except Problem as error:
            self.root["partitions"].update(error=str(error), phase="failed")
            for key in self.partitioned:
                execution.nodes[key]["error"] = str(error)
            self.runner._execute_nodes(
                execution, [k for k in execution.order if k not in execution.value_phase]
            )
            return
        if not self.selected and self.entries:
            self.root["partitions"].update(phase="finished", reason="No partitions match the selection")
            for key in execution.order:
                if key not in execution.value_phase:
                    self.root["nodes"][key].update(
                        status="success", skipped=True, reason="Empty partition selection"
                    )
            return
        # Inputs used only by empty zones need schema binding, never data evaluation.
        terminals = set(execution.order) - {e["source"] for e in execution.edges}
        ordinary = reachable(
            terminals - self.partitioned,
            [
                e
                for e in execution.edges
                if e["source"] not in self.partitioned and e["target"] not in self.partitioned
            ],
            upstream=True,
        )
        only_empty = (
            reachable(self.partitioned, execution.edges, upstream=True) - execution.value_phase - ordinary
        )
        for unit in self.units():
            if all(k in execution.value_phase for k in unit):
                continue
            if unit[0] in self.partitioned:
                self.execute_zone(unit)
            else:
                key = unit[0]
                try:
                    self.collect_inputs(execution, key)
                    execution.schema_only = not self.entries and key in only_empty
                    self.runner._execute_nodes(execution, unit)
                except Problem as error:
                    self.root["nodes"][key].update(status="blocked", error=str(error))
                finally:
                    execution.schema_only = False
        self.summarize()
        self.prune()

    def execute_zone(self, unit):
        if not self.entries:
            self.empty_zone(unit)
            return
        # All cursors belong to the same database and its scheduler, buffer manager,
        # memory limit and spill directory. No per-key session multiplies resources.
        threads = self.execution.cursor.execute("SELECT current_setting('threads')").fetchone()[0]
        workers = max(1, min(self.policy.get("parallelism", 1), threads))
        self.root["partitions"]["effective_parallelism"] = workers
        queued = iter(self.selected)
        pending = {}

        def admit(pool):
            if self.stopped or self.execution.canceled:
                return False
            entry = next(queued, None)
            if entry is None:
                return False
            pending[pool.submit(self.execute_key, entry, unit)] = entry
            return True

        if workers == 1:
            while not self.stopped and not self.execution.canceled:
                entry = next(queued, None)
                if entry is None:
                    break
                if self.execute_key(entry, unit) and self.policy.get("on_error", "stop") == "stop":
                    self.stopped = True
                self.summarize(finished=False)
        else:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="partition") as pool:
                for _ in range(workers):
                    if not admit(pool):
                        break
                while pending:
                    done, _ = wait(pending, return_when=FIRST_COMPLETED)
                    for future in done:
                        pending.pop(future)
                        if future.result() and self.policy.get("on_error", "stop") == "stop":
                            self.stopped = True
                    self.summarize(finished=False)
                    for _ in done:
                        if not admit(pool):
                            break
        for entry in queued:
            for key in unit:
                state = {
                    "status": "canceled" if self.execution.canceled else "not_started",
                    "kind": self.execution.nodes[key]["parsed"]["kind"],
                    "run": self.root["id"],
                }
                self.storage.attempt(self.root["id"], entry["partition_id"], key, state)
                self.storage.record(key, entry, state)

    def execute_key(self, entry, unit):
        execution = self.for_entry(entry, unit)
        owns_cursor = self.root["partitions"]["effective_parallelism"] > 1
        if owns_cursor:
            cursor = execution.context.db.cursor()
            execution.cursor = cursor if self.runner.isolated else NativeCursor(cursor)
            with self.runner.lock:
                execution.token.setdefault("cursors", []).append(execution.cursor)
        with self.lock:
            self.active.add(entry["partition_id"])
            self.root["partitions"]["active"] = sorted(self.active)
            self.runner._persist(self.root, execution.secrets)
        remaining = Counter(
            (e["source"], e["sourceHandle"])
            for e in execution.edges
            if e["source"] in unit and e["target"] in unit
        )
        try:
            for key in unit:
                try:
                    self.collect_inputs(execution, key)
                    old = self.storage.result(key, entry["key_hash"]).get("success", {})
                    if (
                        self.selection["mode"] != "all"
                        and execution.nodes[key]["parsed"]["kind"] == "export"
                        and old.get("fingerprint") == execution.fingerprints[key]
                    ):
                        execution.run["nodes"][key] = {
                            **old,
                            "status": "success",
                            "skipped": True,
                            "reason": "Export already succeeded for this key and fingerprint",
                        }
                    else:
                        self.runner._execute_nodes(execution, [key])
                except Problem as error:
                    execution.run["nodes"][key].update(status="blocked", error=str(error))
                state = execution.run["nodes"][key]
                with self.lock:
                    saved = self.saved.pop((entry["partition_id"], key), {})
                state["partition_artifacts"] = {port: artifact["id"] for port, artifact in saved.items()}
                state["run"] = self.root["id"]
                self.storage.record(key, entry, self.safe(state), saved)
                self.persist(execution.run)
                for edge in execution.edges:
                    if edge["target"] == key and edge["source"] in unit:
                        remaining[edge["source"], edge["sourceHandle"]] -= 1
                if not execution.canceled:
                    self.release(execution, unit, remaining)
            return any(execution.run["nodes"][k]["status"] != "success" for k in unit)
        finally:
            # Cancellation makes the active cursor permanently unusable. Cleanup uses
            # a fresh cursor in the same session after all of this key's work stopped.
            cleanup = execution.context.db.cursor() if execution.canceled else execution.cursor
            try:
                self.release(replace(execution, cursor=cleanup), unit, Counter())
            finally:
                if cleanup is not execution.cursor:
                    cleanup.close()
                if owns_cursor:
                    execution.cursor.close()
                    with self.runner.lock:
                        execution.token["cursors"].remove(execution.cursor)
                with self.lock:
                    self.active.discard(entry["partition_id"])
                    self.root["partitions"]["active"] = sorted(self.active)

    def for_entry(self, entry, unit):
        execution = self.execution
        nodes, _, _ = expand_for(
            execution.bundle, execution.context.environment, computed=execution.values, partition=entry
        )
        fingerprints = self.runner.fingerprints.of(
            execution.bundle,
            execution.context.environment,
            execution.captured,
            execution.values,
            partition=entry,
        )
        states = {
            **execution.run["nodes"],
            **{
                key: {
                    "status": "pending",
                    "kind": nodes[key]["parsed"]["kind"],
                    "label": nodes[key].get("label", key),
                    "fingerprint": fingerprints[key],
                    "results": [],
                    "partitioned": True,
                }
                for key in unit
            },
        }
        run = {
            **execution.run,
            "nodes": states,
            "partition_attempt": entry["partition_id"],
            "partition_nodes": unit,
        }
        return replace(
            execution,
            nodes=nodes,
            fingerprints=fingerprints,
            run=run,
            partition=entry,
            published={k: dict(v) for k, v in execution.published.items()},
            prepared=execution.prepared,
        )

    def persist(self, run):
        for key in run["partition_nodes"]:
            state = run["nodes"][key]
            state["run"] = run["id"]
            if state["status"] != "pending":
                self.storage.attempt(run["id"], run["partition_attempt"], key, self.safe(state))

    def safe(self, value):
        if isinstance(value, str):
            return redact(value, self.execution.secrets)
        if isinstance(value, dict):
            return {k: self.safe(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.safe(v) for v in value]
        return value

    def publish(self, execution, key, staged) -> dict[str, Dataset]:
        with self.lock:
            return self._publish(execution, key, staged)

    def _publish(self, execution, key, staged) -> dict[str, Dataset]:
        entry = execution.partition
        saved = {}
        preview = self.dimension["preview"]
        keep = preview["keep"] != "none"
        for port, data in staged.items():
            previous = self.schemas.setdefault((key, port), data.columns)
            if previous != data.columns:
                raise Problem(f"partition_schema: {key}.{port} changes columns or types between keys")
            data.partition = copy.deepcopy(entry)
            mandatory = (key, port) in self.required
            if mandatory or keep:
                try:
                    # The optional writer can be interrupted at its byte cap without
                    # canceling the key's execution cursor or its later nodes.
                    copy_cursor = execution.cursor if mandatory else execution.context.db.cursor()
                    try:
                        artifact = self.storage.save(
                            copy_cursor, data, entry, mandatory, preview["max_bytes"], self.root["started"]
                        )
                    finally:
                        if not mandatory:
                            copy_cursor.close()
                    if artifact:
                        saved[port] = artifact
                        if not mandatory:
                            with execution.context.lock:
                                pinned = (
                                    {
                                        d.artifact_id
                                        for d in execution.context.datasets.values()
                                        if d.artifact_id
                                    }
                                    if execution.context.lineage
                                    else set()
                                )
                            self.storage.trim_optional(preview, pinned)
                    else:
                        execution.run["nodes"][key]["preview_reason"] = "Preview not retained: size limit"
                except Exception as error:
                    if mandatory:
                        raise Problem(f"partition_storage: cannot persist {key}.{port}: {error}") from error
                    execution.run["nodes"][key]["preview_reason"] = (
                        "Preview not retained: storage unavailable"
                    )
        self.saved[entry["partition_id"], key] = saved
        execution.published[key] = staged
        with execution.context.lock:
            execution.context.datasets.update({d.id: d for d in staged.values()})
        return {}

    def release(self, execution, unit, remaining):
        for key in unit:
            for port, data in list(execution.published.get(key, {}).items()):
                if remaining[key, port] <= 0:
                    drop_dataset(execution.cursor, data)
                    execution.published[key].pop(port)
                    with execution.context.lock:
                        execution.context.datasets.pop(data.id, None)

    def collect_inputs(self, execution, key):
        for edge in execution.edges:
            if edge["target"] != key or edge["targetHandle"] not in execution.nodes[key].get(
                "partition_collect_inputs", []
            ):
                continue
            source, port = edge["source"], edge["sourceHandle"]
            artifacts, missing = [], []
            for entry in self.entries:
                record = self.storage.result(source, entry["key_hash"])
                result = record.get("success", {})
                fingerprint = self.runner.fingerprints.of(
                    execution.bundle,
                    execution.context.environment,
                    execution.captured,
                    execution.values,
                    partition=entry,
                ).get(source)
                artifact = result.get("artifacts", {}).get(port)
                if (
                    record.get("attempt", {}).get("status") in ("failed", "blocked")
                    or result.get("fingerprint") != fingerprint
                    or not self.storage.available(artifact)
                ):
                    missing.append(entry["key"]["value"])
                else:
                    artifacts.append(artifact)
            if missing:
                raise Problem(f"partition_incomplete: {source}.{port} lacks valid results for {missing}")
            data, inputs = self.storage.collect(
                execution.cursor, source, port, artifacts, self.schemas.get((source, port))
            )
            execution.published.setdefault(source, {})[port] = data
            execution.run["nodes"][source]["status"] = "success"
            with execution.context.lock:
                execution.context.datasets.update({d.id: d for d in [data, *inputs]})

    def empty_zone(self, unit):
        assert self.manifest is not None
        sample = {"text": "", "number": 0, "date": "2000-01-01", "boolean": False}
        entry = {
            "partition_id": "empty",
            "key_hash": "empty",
            "key": {"type": self.dimension["type"], "value": sample[self.dimension["type"]]},
            "attributes": {
                name: {"type": column["scalar_type"], "value": sample[column["scalar_type"]]}
                for name, column in zip(
                    self.dimension["attributes"], self.manifest["schema"][1:], strict=True
                )
            },
        }
        execution = self.for_entry(entry, unit)
        execution.schema_only = True
        try:
            for key in unit:
                node = execution.nodes[key]
                if node["parsed"]["kind"] == "export":
                    self.root["nodes"][key].update(
                        status="success", skipped=True, reason="Empty partition manifest"
                    )
                    continue
                tables = []
                staged = self.runner._compute(execution, key, tables)
                execution.published[key] = staged
                for port, dataset in staged.items():
                    self.schemas[key, port] = dataset.columns
                self.root["nodes"][key].update(
                    status="success", outputs={}, reason="Empty partition manifest"
                )
        finally:
            self.release(execution, unit, Counter())

    def summarize(self, finished=True):
        summary = self.root["partitions"]
        completed = failed = not_started = 0
        for entry in self.selected:
            attempts = self.storage.attempts(self.root["id"], entry["partition_id"])
            states = [attempts.get(k, {}).get("status", "not_started") for k in self.partitioned]
            if all(s == "success" for s in states):
                completed += 1
            elif any(s in ("failed", "blocked", "canceled", "interrupted") for s in states):
                failed += 1
            else:
                not_started += 1
        summary.update(
            completed=completed, failed=failed, not_started=not_started, active=sorted(self.active)
        )
        if finished:
            summary["phase"] = "finished"
            for key in self.partitioned:
                states = [
                    self.storage.attempts(self.root["id"], e["partition_id"])
                    .get(key, {})
                    .get("status", "not_started")
                    for e in self.selected
                ]
                self.root["nodes"][key]["status"] = (
                    "success"
                    if all(s == "success" for s in states)
                    else "failed"
                    if "failed" in states
                    else "blocked"
                )
        self.runner._persist(self.root, self.execution.secrets)

    def prune(self):
        context = self.execution.context
        with context.lock:
            if context.lineage:
                return
            needed = {d.id for outputs in context.outputs.values() for d in outputs.values()}
            pending = list(needed)
            while pending:
                dataset = context.datasets.get(pending.pop())
                if dataset:
                    for dependency in dataset.dependencies.values():
                        if dependency not in needed:
                            needed.add(dependency)
                            pending.append(dependency)
            for identity, dataset in list(context.datasets.items()):
                if dataset.disk and identity not in needed:
                    drop_dataset(self.execution.cursor, dataset)
                    del context.datasets[identity]
            pinned = {d.artifact_id for d in context.datasets.values() if d.artifact_id}
            self.storage.prune(self.entries, self.dimension["preview"], pinned)
