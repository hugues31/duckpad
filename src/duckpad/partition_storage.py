"""Partition metadata in the instance Store, with private immutable Parquet artifacts."""

import copy
import os
import re
import threading
from dataclasses import asdict

from sqlalchemy.dialects.sqlite import insert
from sqlmodel import col, select

from . import models as m
from .artifacts import Artifacts, open_regular, signature
from .datasets import Dataset
from .util import Problem, clean, digest, literal, qi, uid


def run_manifest(run, *, detail=None):
    """Require the immutable partition evidence retained by a run."""
    manifest = run.get("partitions", {}).get("manifest")
    if not manifest:
        raise Problem("This run has no partition manifest", 404, detail)
    return manifest


class PartitionStorage:
    def __init__(self, store, worktree, environment):
        self.store, self.worktree, self.environment = store, worktree, environment
        self.data = store.paths.partition_artifacts(worktree, environment)
        self.temporary = store.paths.exports(worktree, environment) / ".temporary"

    def scoped(self, model):
        return select(model).where(model.worktree == self.worktree, model.environment == self.environment)

    def manifest(self, identity=None, signature=None):
        statement = self.scoped(m.PartitionManifest)
        statement = (
            statement.where(m.PartitionManifest.id == identity)
            if identity
            else statement.where(m.PartitionManifest.signature == signature).order_by(
                col(m.PartitionManifest.created).desc()
            )
        )
        with self.store.session() as session:
            row = session.exec(statement.limit(1)).first()
            return row.evidence if row else None

    def publish_manifest(self, metadata, entries):
        content = digest(
            [
                metadata["source"],
                metadata["dimension"],
                metadata["schema"],
                [
                    {
                        "key": {k: entry["key"][k] for k in ("type", "value")},
                        "attributes": {
                            name: {k: value[k] for k in ("type", "value")}
                            for name, value in entry["attributes"].items()
                        },
                    }
                    for entry in entries
                ],
            ]
        )
        metadata = {**metadata, "digest": content}
        with self.store.transaction() as session:
            previous = self.manifest(signature=metadata["signature"])
            if previous and previous["digest"] == content:
                return previous, self.entries(previous["id"])
            session.add(
                m.PartitionManifest(
                    id=metadata["id"],
                    worktree=self.worktree,
                    environment=self.environment,
                    signature=metadata["signature"],
                    run=metadata["run"],
                    created=metadata["created"],
                    evidence=metadata,
                )
            )
            session.flush()
            if entries:
                session.execute(
                    insert(m.PartitionEntry),
                    [
                        {
                            "manifest": metadata["id"],
                            "ordinal": e["ordinal"],
                            "partition_id": e["partition_id"],
                            "key_hash": e["key_hash"],
                            "evidence": e,
                        }
                        for e in entries
                    ],
                )

        return metadata, entries

    def entries(self, manifest, offset=0, limit=None):
        with self.store.session() as session:
            statement = (
                select(m.PartitionEntry)
                .where(
                    m.PartitionEntry.manifest == manifest,
                    m.PartitionEntry.ordinal >= offset,
                )
                .order_by(col(m.PartitionEntry.ordinal))
            )
            if limit is not None:
                statement = statement.limit(limit)
            return [r.evidence for r in session.exec(statement)]

    def entry(self, manifest, partition_id):
        with self.store.session() as session:
            row = session.exec(
                select(m.PartitionEntry).where(
                    m.PartitionEntry.manifest == manifest,
                    m.PartitionEntry.partition_id == partition_id,
                )
            ).first()
            if row is None:
                raise Problem("Partition does not belong to this manifest", 404)
            return row.evidence

    def attempt(self, run, partition_id, node, state):
        statement = insert(m.PartitionAttempt).values(
            run=run, partition_id=partition_id, node=node, state=clean(state)
        )
        with self.store.session() as session:
            session.execute(
                statement.on_conflict_do_update(
                    index_elements=["run", "partition_id", "node"],
                    set_={"state": statement.excluded.state},
                )
            )

    def attempts(self, run, partition_id):
        with self.store.session() as session:
            return {
                row.node: row.state
                for row in session.exec(
                    select(m.PartitionAttempt).where(
                        m.PartitionAttempt.run == run,
                        m.PartitionAttempt.partition_id == partition_id,
                    )
                )
            }

    def result(self, node, key_hash):
        with self.store.session() as session:
            row = session.get(m.PartitionResult, (self.worktree, self.environment, node, key_hash))
            return row.state if row else {}

    def record(self, node, entry, state, outputs=None):
        replaced = None
        with self.store.transaction() as session:
            previous = self.result(node, entry["key_hash"])
            record = {**previous, "attempt": copy.deepcopy(state)}
            if state["status"] == "success":
                record["success"] = {**copy.deepcopy(state), "artifacts": outputs or {}}
                replaced = previous.get("success", {}).get("artifact")
            statement = insert(m.PartitionResult).values(
                worktree=self.worktree,
                environment=self.environment,
                node=node,
                key_hash=entry["key_hash"],
                state=clean(record),
            )
            session.execute(
                statement.on_conflict_do_update(
                    index_elements=["worktree", "environment", "node", "key_hash"],
                    set_={"state": statement.excluded.state},
                )
            )
        # A key keeps one export download copy, like an ordinary export node.
        if replaced and replaced != state.get("artifact"):
            self.remove(replaced)

    def save(self, cursor, dataset, entry, mandatory, budget, retention_run=None):
        self.temporary.mkdir(parents=True, exist_ok=True)
        temporary = self.temporary / (uid("partition_") + ".partial")
        ordinal = uid("__dp_order_")
        finished, exceeded = threading.Event(), threading.Event()

        def bound_write():
            while not finished.wait(0.01):
                try:
                    if temporary.stat().st_size > budget:
                        exceeded.set()
                        cursor.interrupt()
                        return
                except FileNotFoundError:
                    pass

        monitor = (
            threading.Thread(target=bound_write, name="partition-preview-cap") if not mandatory else None
        )
        if monitor:
            monitor.start()
        identity = None
        try:
            # Materialization already defines rowid order. COPY preserves insertion
            # order; a second sort costs a full partition's memory and spill I/O.
            cursor.execute(
                f"COPY (SELECT rowid AS {qi(ordinal)}, * FROM {qi(dataset.storage)}) TO {literal(str(temporary))} (FORMAT PARQUET)"
            )
            if not mandatory and temporary.stat().st_size > budget:
                return None
            run = self.store.get("run", dataset.run)
            artifacts = Artifacts(self.store)
            identity = artifacts.capture(
                {"path": str(temporary), "format": "parquet"},
                run,
                dataset.node,
                [self.temporary],
                storage_kind="partition",
            )
            record = self.store.get("artifact", identity)
            metadata = {
                "id": identity,
                "dataset": clean(asdict(dataset)),
                "ordinal_column": ordinal,
                "bytes": record["size"],
                "signature": record["signature"],
                "partition": copy.deepcopy(entry),
                "retention_run": retention_run or dataset.created,
            }
            with self.store.session() as session:
                session.add(
                    m.PartitionOutput(
                        id=identity,
                        worktree=self.worktree,
                        environment=self.environment,
                        node=dataset.node,
                        key_hash=entry["key_hash"],
                        dataset=dataset.id,
                        mandatory=mandatory,
                        evidence=metadata,
                    )
                )
            return metadata
        except Exception:
            if identity:
                self.remove(identity)
            if exceeded.is_set():
                return None
            raise
        finally:
            finished.set()
            if monitor:
                monitor.join()
            temporary.unlink(missing_ok=True)

    def artifact(self, identity=None, *, dataset=None):
        with self.store.session() as session:
            statement = self.scoped(m.PartitionOutput)
            statement = (
                statement.where(m.PartitionOutput.dataset == dataset)
                if dataset
                else statement.where(m.PartitionOutput.id == identity)
            )
            row = session.exec(statement).first()
            return row.evidence if row else None

    def available(self, metadata):
        if not metadata or not re.fullmatch(r"artifact_[0-9a-f]{16}", metadata.get("id", "")):
            return False
        try:
            # Constant-time identity check. The SQL worker cannot mutate this directory.
            with open_regular(self.data / metadata["id"]) as stream:
                return signature(os.fstat(stream.fileno())) == metadata["signature"]
        except OSError:
            return False

    def remove(self, identity):
        Artifacts(self.store).remove(identity)

    def forget(self, session, row):
        """Delete a key's result and the export download copy it owns."""
        session.delete(row)
        download = row.state.get("success", {}).get("artifact")
        if download:
            self.remove(download)

    def restore(self, cursor, metadata):
        if not self.available(metadata):
            raise Problem("partition_not_retained: partition data is missing or has changed", 409)
        data = Dataset(**copy.deepcopy(metadata["dataset"]))
        data.disk = True
        data.artifact_id = metadata["id"]
        data.partition = copy.deepcopy(metadata["partition"])
        data.id = uid("data_")
        data.storage = data.id + "_storage"
        marker = qi(metadata["ordinal_column"])
        path = literal(str(self.data / (metadata["id"])))
        cursor.execute(
            f"CREATE VIEW {qi(data.storage)} AS SELECT * EXCLUDE ({marker}), {marker} AS rowid FROM read_parquet({path})"
        )
        projection = ", ".join(f"{qi(data.stored(c['name']))} AS {qi(c['name'])}" for c in data.columns)
        cursor.execute(f"CREATE VIEW {qi(data.table)} AS SELECT {projection} FROM {qi(data.storage)}")
        return data

    def collect(self, cursor, node, port, artifacts, columns=None):
        """UNION ALL preserves branch order; each branch restores its private row order."""
        inputs = [self.restore(cursor, a) for a in artifacts]
        columns = inputs[0].columns if inputs else columns
        if columns is None:
            raise Problem("partition_schema_unavailable: no typed output is available")
        if any(data.columns != columns for data in inputs):
            raise Problem("partition_schema: output columns or types differ between keys")
        identity = uid("data_")
        mapping = {c["name"]: uid("__dp_user_") for c in columns if c["name"].casefold() == "rowid"}
        statements, origins, offset = [], [], 0
        for data in inputs:
            projection = ", ".join(
                f"{qi(data.stored(c['name']))} AS {qi(mapping.get(c['name'], c['name']))}" for c in columns
            )
            statements.append(f"(SELECT {projection}, rowid + {offset} AS rowid FROM {qi(data.storage)})")
            origins.append(
                {
                    "start": offset,
                    "count": data.count,
                    "partition": data.partition,
                    "run": data.run,
                    "dataset": data.id,
                }
            )
            offset += data.count
        query = (
            " UNION ALL ".join(statements)
            if statements
            else "SELECT "
            + ", ".join(
                f"CAST(NULL AS {c['type']}) AS {qi(mapping.get(c['name'], c['name']))}" for c in columns
            )
            + ", 0::BIGINT AS rowid WHERE FALSE"
        )
        data = Dataset(
            id=identity,
            node=node,
            port=port,
            columns=columns,
            count=offset,
            run=inputs[0].run if inputs else "",
            query=query,
            bindings={},
            dependencies={d.table: d.id for d in inputs},
            fingerprint=digest([a["dataset"]["fingerprint"] for a in artifacts]),
            storage=identity + "_storage",
            column_map=mapping,
            disk=True,
            origins=origins,
        )
        cursor.execute(f"CREATE VIEW {qi(data.storage)} AS {query}")
        projection = ", ".join(f"{qi(data.stored(c['name']))} AS {qi(c['name'])}" for c in columns)
        cursor.execute(f"CREATE VIEW {qi(data.table)} AS SELECT {projection} FROM {qi(data.storage)}")
        return data, inputs

    def outputs(self, *, optional=False):
        with self.store.session() as session:
            statement = self.scoped(m.PartitionOutput)
            if optional:
                statement = statement.where(col(m.PartitionOutput.mandatory).is_(False))
            return [(row.id, row.mandatory, row.evidence) for row in session.exec(statement)]

    def needs_optional(self, node, port, entry, retention_run, preview):
        """Do not copy an older parallel result after enough newer keys are retained."""
        if preview["keep"] == "none":
            return False
        if preview["keep"] == "all":
            return True
        newer = sum(
            metadata["dataset"]["node"] == node
            and metadata["dataset"]["port"] == port
            and metadata["retention_run"] == retention_run
            and metadata["partition"]["ordinal"] > entry["ordinal"]
            and self.available(metadata)
            for _, _, metadata in self.outputs(optional=True)
        )
        return newer < preview["count"]

    def trim_optional(self, preview, pinned):
        """Retain successful keys by run/ordinal, independent of completion order."""
        rows = [meta for _, mandatory, meta in self.outputs(optional=True) if not mandatory]
        rows.sort(
            key=lambda a: (a["retention_run"], a["partition"]["ordinal"], a["dataset"]["created"]),
            reverse=True,
        )
        used = sum(a["bytes"] for a in rows if a["id"] in pinned)
        counts, seen = {}, set()
        for artifact in rows:
            output = (artifact["dataset"]["node"], artifact["dataset"]["port"])
            key = (*output, artifact["partition"]["key_hash"])
            keep = key not in seen and (
                preview["keep"] == "all" or counts.get(output, 0) < preview.get("count", 1)
            )
            seen.add(key)
            if artifact["id"] in pinned:
                counts[output] = counts.get(output, 0) + 1
            elif keep and used + artifact["bytes"] <= preview["max_bytes"]:
                used += artifact["bytes"]
                counts[output] = counts.get(output, 0) + 1
            else:
                self.remove(artifact["id"])

    def prune(self, entries, preview, pinned, required):
        current = {entry["key_hash"] for entry in entries}
        with self.store.session() as session:
            successes = []
            for row in session.exec(self.scoped(m.PartitionResult)):
                if row.key_hash in current:
                    successes.append(row.state.get("success", {}))
                else:
                    self.forget(session, row)
        live = {a["id"] for state in successes for a in state.get("artifacts", {}).values()}
        for identity, mandatory, metadata in self.outputs():
            if identity in pinned:
                continue
            output = (metadata["dataset"]["node"], metadata["dataset"]["port"])
            if identity not in live or (mandatory and output not in required):
                self.remove(identity)
        self.trim_optional(preview, pinned)

    def forget_removed(self, partitioned, pinned):
        """Release the data of deleted nodes and of nodes that are no longer partitioned."""
        for identity, _, metadata in self.outputs():
            if metadata["dataset"]["node"] not in partitioned and identity not in pinned:
                self.remove(identity)
        with self.store.session() as session:
            for row in session.exec(
                self.scoped(m.PartitionResult).where(col(m.PartitionResult.node).not_in(partitioned))
            ):
                self.forget(session, row)
