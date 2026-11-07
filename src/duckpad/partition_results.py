"""Explicit manifest contexts for partition inspection; reads never refresh sources."""

from __future__ import annotations

import base64
import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .engine import Engine

from . import partitions
from .components import expand
from .datasets import Context, Dataset
from .graph import connection_references, reachable
from .partition_storage import PartitionStorage
from .util import Problem, digest


class PartitionResults:
    def __init__(self, engine: Engine):
        self.engine = engine

    def describe(self, worktree, environment):
        self.engine.catalog.environment(environment)
        bundle = self.engine.projects.snapshot(worktree)["bundle"]
        if not bundle:
            return {"dimension": None, "manifest": None, "nodes": {}}
        nodes, edges, boundaries = expand(bundle, tolerant=True)
        plan = partitions.plan(bundle, nodes, edges, boundaries)
        dimension = plan["dimension"]
        manifest = None
        if dimension:
            manifest = PartitionStorage(self.engine.store, worktree, environment).manifest(
                signature=partitions.signature(dimension)
            )
        return {
            "dimension": dimension,
            "manifest": manifest,
            "nodes": {
                k: {
                    "partitioned": n.get("partitioned", False),
                    "dimension": n.get("partition_dimension"),
                    "origin": n.get("partition_origin"),
                    "filters": n.get("partition_filters", {}),
                    "collect": n.get("partition_collect_inputs", []),
                    "error": n.get("partition_error"),
                }
                for k, n in nodes.items()
            },
            "errors": plan["errors"],
        }

    def selected(self, worktree, environment, context):
        if not context or not isinstance(context.get("manifest"), str):
            raise Problem("An explicit partition manifest is required", 422)
        if bool(context.get("partition_id")) == (context.get("partition_mode") == "all"):
            raise Problem("Select one partition_id or partition_mode=all", 422)
        storage = PartitionStorage(self.engine.store, worktree, environment)
        manifest = storage.manifest(identity=context["manifest"])
        if manifest is None:
            raise Problem("Partition manifest does not belong to this worktree and environment", 404)
        return (
            storage,
            manifest,
            storage.entry(manifest["id"], context["partition_id"]) if context.get("partition_id") else None,
        )

    def fingerprints(self, worktree, environment):
        bundle = self.engine.projects.snapshot(worktree, committed=True)["bundle"]
        if not bundle:
            return {}
        return self.engine.fingerprints.batch(
            bundle,
            environment,
            computed=self.engine.pool.computed(worktree, environment, bundle),
            manifest=self.engine.fingerprints.manifest(worktree, environment, bundle),
        )[1]

    def validity(self, node, entry, result, fingerprints):
        if result.get("attempt", {}).get("status") in ("failed", "blocked"):
            return "failed"
        success = result.get("success")
        if not success:
            return "missing"
        current = fingerprints.get(partitions.identity(entry["key"]), {})
        return "valid" if success.get("fingerprint") == current.get(node) else "stale"

    def page(
        self,
        worktree,
        environment,
        *,
        manifest=None,
        node=None,
        port="result",
        cursor=None,
        limit=50,
        search="",
        status=None,
        run=None,
        key_hash=None,
    ):
        description = self.describe(worktree, environment)
        manifest = manifest or (description.get("manifest") or {}).get("id")
        if not manifest:
            return {**description, "entries": [], "next_cursor": None, "total": 0}
        storage = PartitionStorage(self.engine.store, worktree, environment)
        metadata = storage.manifest(identity=manifest)
        if not metadata:
            raise Problem("Partition manifest not found", 404)
        signature = digest([manifest, node, port, search, status, run, key_hash])
        offset = 0
        if cursor:
            try:
                token = json.loads(base64.urlsafe_b64decode(cursor.encode()))
                if token["signature"] != signature or type(token["offset"]) is not int or token["offset"] < 0:
                    raise ValueError
                offset = token["offset"]
            except (ValueError, KeyError, TypeError) as error:
                raise Problem("Invalid or outdated partition cursor", 422) from error
        selected = [node] if node else [k for k, n in description["nodes"].items() if n["partitioned"]]
        if run and not node:
            record = self.engine.store.get("run", run) or {}
            selected = [k for k, value in record.get("nodes", {}).items() if value.get("partitioned")]
        fingerprints = self.fingerprints(worktree, environment)
        page, next_offset = [], offset
        limit = max(1, min(int(limit), 200))
        # Bound each database read; filters scan pages, never inline all node/key logs.
        while len(page) < limit:
            entries = storage.entries(manifest, next_offset, 200)
            if not entries:
                break
            for entry in entries:
                next_offset = entry["ordinal"] + 1
                if key_hash and entry["key_hash"] != key_hash:
                    continue
                if (
                    search.casefold()
                    not in json.dumps(
                        [entry["key"]["value"], entry["attributes"]], ensure_ascii=False
                    ).casefold()
                ):
                    continue
                attempts = storage.attempts(run, entry["partition_id"]) if run else {}
                states = {}
                for key in selected:
                    result = storage.result(key, entry["key_hash"])
                    evidence = attempts.get(key, {}) if run else result.get("attempt", {})
                    success = result.get("success", {})
                    artifact = (
                        storage.artifact(evidence.get("partition_artifacts", {}).get(port))
                        if run
                        else success.get("artifacts", {}).get(port)
                    )
                    states[key] = {
                        "status": evidence.get("status", "not_started"),
                        "validity": self.validity(key, entry, result, fingerprints),
                        "preview_available": storage.available(artifact),
                        "rows": evidence.get("outputs", {}).get(port, {}).get("count"),
                        "duration": evidence.get("duration"),
                        "error": evidence.get("error"),
                        "run": evidence.get("outputs", {}).get(port, {}).get("run"),
                        "skipped": evidence.get("skipped", False),
                        "attempt": evidence if node else None,
                    }
                validity = (
                    "failed"
                    if any(s["validity"] == "failed" for s in states.values())
                    else "missing"
                    if any(s["validity"] == "missing" for s in states.values())
                    else "stale"
                    if any(s["validity"] == "stale" for s in states.values())
                    else "valid"
                )
                if status and validity != status:
                    continue
                page.append({**entry, "validity": validity, "nodes": states})
                if len(page) == limit:
                    break
        next_cursor = (
            base64.urlsafe_b64encode(
                json.dumps({"signature": signature, "offset": next_offset}).encode()
            ).decode()
            if next_offset < metadata["count"]
            else None
        )
        return {
            **description,
            "manifest": metadata,
            "dimension": metadata["dimension"],
            "entries": page,
            "total": metadata["count"],
            "next_cursor": next_cursor,
        }

    def load(self, worktree, environment, node, port, selection) -> tuple[Context, Dataset] | None:
        # Every preview reads through here: flows without partitions skip expansion.
        bundle = self.engine.projects.snapshot(worktree)["bundle"]
        if not bundle or not bundle["flow"].get("partitions"):
            if selection:
                self.selected(worktree, environment, selection)
            return None
        description = self.describe(worktree, environment)
        _nodes, _, boundaries = expand(bundle, tolerant=True)
        node, port = boundaries.get(node, {}).get("outputs", {}).get(port, (node, port))
        if not description["nodes"].get(node, {}).get("partitioned"):
            if selection:
                self.selected(worktree, environment, selection)
            return None
        self.authorize(worktree, node)
        if not selection and description["manifest"] is None:
            raise Problem("partition_not_calculated: Partition values not calculated; run the pipeline", 409)
        storage, manifest, entry = self.selected(worktree, environment, selection)
        entries = [entry] if entry else storage.entries(manifest["id"])
        fingerprints = self.fingerprints(worktree, environment)
        artifacts, validities = [], []
        for key in entries:
            result = storage.result(node, key["key_hash"])
            artifact = result.get("success", {}).get("artifacts", {}).get(port)
            if storage.available(artifact):
                artifacts.append(artifact)
                validities.append(self.validity(node, key, result, fingerprints))
        if entry and not artifacts:
            attempt = storage.result(node, entry["key_hash"]).get("attempt", {})
            if attempt.get("error"):
                raise Problem(attempt["error"], 409)
            raise Problem(
                "partition_not_retained: this partition's result is not retained; run this key to inspect it",
                409,
            )
        if not artifacts:
            raise Problem("partition_not_retained: no partition output is retained", 409)
        context = self.engine.pool.ensure_started(worktree, environment)
        cache_key = digest([selection, node, port, [a["id"] for a in artifacts]])
        with context.lock:
            cached = context.partition_cache.get(cache_key)
            if cached and cached in context.datasets:
                dataset = context.datasets[cached]
            else:
                assert context.db is not None
                cursor = context.db.cursor()
                try:
                    if entry:
                        dataset = storage.restore(cursor, artifacts[0])
                    else:
                        dataset, inputs = storage.collect(cursor, node, port, artifacts)
                        context.datasets.update({d.id: d for d in inputs})
                    dataset.partition_context = selection
                    if len(artifacts) != len(entries):
                        dataset.incomplete = {"available": len(artifacts), "total": len(entries)}
                    context.datasets[dataset.id] = dataset
                    context.partition_cache[cache_key] = dataset.id
                finally:
                    cursor.close()
            dataset.status = (
                "valid" if all(v == "valid" for v in validities) and not dataset.incomplete else "stale"
            )
        return context, dataset

    def compile_entry(self, worktree, environment, selection):
        _, manifest, entry = self.selected(worktree, environment, selection)
        if entry:
            return entry
        dimension = manifest["dimension"]

        def parameter(kind):
            return {"type": kind, "value": None, "state": "parameter", "plan": True}

        return {
            "plan": True,
            "key": parameter(dimension["type"]),
            "attributes": {
                name: parameter(column["scalar_type"])
                for name, column in zip(dimension["attributes"], manifest["schema"][1:], strict=True)
            },
        }

    def evidence(self, worktree, environment, dataset):
        storage = PartitionStorage(self.engine.store, worktree, environment)
        return storage.attempts(dataset.run, dataset.partition["partition_id"]).get(dataset.node, {})

    def attempt(self, worktree, environment, node, selection):
        storage, _, entry = self.selected(worktree, environment, selection)
        if entry is None:
            raise Problem("Choose one key to inspect its executed statements", 422)
        state = storage.result(node, entry["key_hash"]).get("attempt", {})
        run = self.engine.store.get("run", state.get("run", ""))
        if not run:
            raise Problem("No attempt for this key", 404)
        return {**run, "nodes": {node: state}, "partition": entry}

    def authorize(self, worktree, node):
        if self.engine.access:
            snapshot = self.engine.projects.snapshot(worktree)
            nodes, edges, _ = expand(snapshot["bundle"], tolerant=True)
            references = [
                r
                for k in reachable({node}, edges, upstream=True)
                if k in nodes
                for r in connection_references(nodes[k])
            ]
            self.engine.access.connections(snapshot["worktree"]["project"], references)

    def export_result(self, worktree, environment, node, selection):
        self.authorize(worktree, node)
        storage, _, entry = self.selected(worktree, environment, selection)
        if entry is None:
            return {"status": "unsupported"}
        result = storage.result(node, entry["key_hash"])
        success = result.get("success", {})
        valid = self.validity(node, entry, result, self.fingerprints(worktree, environment))
        if valid != "valid":
            return {"status": "not_run" if valid == "missing" else valid}
        record = self.engine.store.get("artifact", success.get("artifact", ""))
        if not record:
            return {"status": "missing"}
        with self.engine.exports.artifacts.open(record["id"], worktree, environment, node, record["run"]):
            return {
                "status": "available",
                **{k: record[k] for k in ("run", "filename", "size", "media_type")},
            }

    def open_export(self, worktree, environment, node, run, selection):
        info = self.export_result(worktree, environment, node, selection)
        if info.get("run") != run or info["status"] != "available":
            raise Problem("This partition export is unavailable or has changed", 409)
        storage, _, entry = self.selected(worktree, environment, selection)
        artifact = storage.result(node, entry["key_hash"])["success"]["artifact"]
        return self.engine.exports.artifacts.open(artifact, worktree, environment, node, run)
