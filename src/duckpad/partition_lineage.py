"""Occurrence origins and retained evidence, without reopening external sources."""

import sqlglot

from .partition_storage import PartitionStorage
from .sqlast import sql
from .trace.normalize import rename_tables
from .util import Problem


class PartitionLineage:
    def __init__(self, engine):
        self.engine = engine

    def storage(self, context):
        return PartitionStorage(self.engine.store, context.worktree, context.environment)

    def restore_inputs(self, context, cursor, dataset, visited=None):
        """Rebind captured SQL to immutable generations; never substitute current inputs."""
        visited = set() if visited is None else visited
        if dataset.id in visited or dataset.origins:
            return []
        visited.add(dataset.id)
        storage = self.storage(context)
        replacements, dependencies, missing = {}, {}, []
        for table, identity in dataset.dependencies.items():
            data = context.datasets.get(identity)
            if data is None:
                cached = context.partition_cache.get("generation:" + identity)
                data = context.datasets.get(cached)
                if data is None:
                    artifact = storage.artifact(dataset=identity)
                    if not storage.available(artifact):
                        missing.append(identity)
                        dependencies[table] = identity
                        continue
                    data = storage.restore(cursor, artifact)
                    context.datasets[data.id] = data
                    context.partition_cache["generation:" + identity] = data.id
            replacements[table] = data.id
            dependencies[data.id] = data.id
            missing.extend(self.restore_inputs(context, cursor, data, visited))
        if replacements:
            dataset.query = sql(rename_tables(sqlglot.parse_one(dataset.query, read="duckdb"), replacements))
            dataset.dependencies = dependencies
            for witness in dataset.witnesses.values():
                witness["dataset"] = replacements.get(witness["dataset"], witness["dataset"])
        return missing

    def test_inputs(self, context, cursor, datasets):
        """Restore captured test inputs and map the original output relation names."""
        replacements = {}
        storage = self.storage(context)
        for dataset in datasets:
            artifact = storage.artifact(dataset.artifact_id)
            if artifact:
                replacements[artifact["dataset"]["id"]] = dataset.id
            before = dict(dataset.dependencies)
            if self.restore_inputs(context, cursor, dataset):
                raise Problem("Intermediate results not retained; run this key to inspect failing rows", 409)
            replacements.update(
                {
                    table: context.partition_cache.get("generation:" + identity, identity)
                    for table, identity in before.items()
                }
            )
        return replacements

    def selection(self, dataset):
        run = self.engine.store.get("run", dataset.run) or {}
        manifest = run.get("partitions", {}).get("manifest")
        return (
            {"manifest": manifest, "partition_id": dataset.partition["partition_id"]}
            if manifest and dataset.partition
            else None
        )

    def origin(self, context, dataset, row):
        if dataset.origins:
            found = next((o for o in dataset.origins if o["start"] <= row < o["start"] + o["count"]), None)
            if found:
                data = context.datasets.get(found["dataset"])
                return {
                    "partition": found["partition"],
                    "run": found["run"],
                    "row": row - found["start"],
                    "node": data.node if data else dataset.node,
                    "dataset": found["dataset"],
                }
        if dataset.partition:
            return {
                "partition": dataset.partition,
                "run": dataset.run,
                "row": row,
                "node": dataset.node,
                "dataset": dataset.id,
            }
        return None

    def origin_response(self, context, cursor, dataset, row, column, response):
        origin = self.origin(context, dataset, row)
        if not origin:
            return None
        response["origin"] = origin
        response["variables"].update(
            {
                "partition": origin["partition"]["key"],
                **{"partition." + k: v for k, v in origin["partition"]["attributes"].items()},
            }
        )
        target = context.datasets.get(origin["dataset"])
        with context.lock:
            missing = self.restore_inputs(context, cursor, target) if target else [origin["dataset"]]
        if missing:
            key = origin["partition"]["key"]
            response.update(
                complete=False,
                kind="partition_origin",
                total=0,
                contributions=[],
                context=[],
                context_total=0,
                warnings=[f"Origin available; intermediate results for {key['value']} are not retained"],
                replay={
                    "node": origin["node"],
                    "partitions": {
                        "mode": "selected",
                        "keys": [{"type": key["type"], "value": key["value"]}],
                    },
                },
            )
            return response
        if dataset.origins:
            response.update(
                kind="partition_origin",
                expression=column,
                total=1,
                context_total=0,
                context=[],
                contributions=[
                    {
                        "dataset": target.id,
                        "node": target.node,
                        "port": target.port,
                        "row": origin["row"],
                        "column": column,
                        "value": response["value"],
                        "source": target.source,
                        "origin": origin,
                        "partition_context": self.selection(target),
                    }
                ],
            )
            return response
        return None

    def annotate(self, context, response):
        for item in [*response.get("contributions", []), *response.get("context", [])]:
            dataset = context.datasets.get(item["dataset"])
            if dataset:
                origin = self.origin(context, dataset, item["row"])
                if origin:
                    item["origin"] = origin
                if selection := self.selection(dataset):
                    item["partition_context"] = selection

    def groups(self, context, cursor, query, sources):
        origins = [(data.id, origin) for data in sources.values() for origin in data.origins]
        if not query or not origins:
            return []
        bindings = [
            value
            for index, (identity, origin) in enumerate(origins)
            for value in (identity, origin["start"], origin["start"] + origin["count"], index)
        ]
        ranges = ",".join("(?,?,?,?)" for _ in origins)
        rows = cursor.execute(
            f"SELECT o.ordinal, count(DISTINCT (c.dataset, c.row_id)) FROM ({query}) c JOIN (VALUES {ranges}) o(dataset, first_row, last_row, ordinal) ON c.dataset=o.dataset AND c.row_id>=o.first_row AND c.row_id<o.last_row GROUP BY o.ordinal ORDER BY o.ordinal",
            bindings,
        ).fetchall()
        return [
            {"partition": origins[index][1]["partition"], "run": origins[index][1]["run"], "rows": count}
            for index, count in rows
        ]
