"""Follow one captured row down each consumer path, with explicit coverage boundaries."""

import threading
from pathlib import Path

import duckdb
import sqlglot
from sqlglot import exp

from .components import expand
from .node_names import node_name
from .row_impact_match import Matcher
from .trace import Coverage
from .util import Problem, clean, digest, qi, uid


def trace(engine, worktree, environment, dataset, row, *, choices=None, offsets=None, page_size=5):
    context = engine.context(worktree, environment)
    bundle = engine.projects.snapshot(worktree)["bundle"]
    if not bundle:
        raise Problem("Project files are invalid", 422)
    nodes, edges, _ = expand(bundle, tolerant=True)
    source = context.datasets.get(dataset)
    if source is None or source.status != "valid" or source.historical:
        raise Problem("This result generation is unavailable or stale. Recompute and select a new cell.", 409)
    engine.partitions.authorize(worktree, source.node)
    if source.partition or source.partition_context or source.origins or source.disk:
        raise Problem("Downstream row tracing across partitions is not yet supported.", 422)
    database = context.db
    cursor = database.cursor()
    request = uid("lineage_")
    canceled = threading.Event()
    # Include all graph nodes from registration: a downstream edit invalidates this trace too.
    with context.lock:
        if context.db is not database or source.status != "valid":
            cursor.close()
            raise Problem("Lineage interrupted by recalculation", 409)
        context.lineage[request] = {"cursor": cursor, "canceled": canceled, "nodes": set(nodes)}
    visited_data = {source.id: source}
    try:
        if cursor.execute(f"SELECT rowid FROM {qi(source.relation)} WHERE rowid=?", [row]).fetchone() is None:
            raise Problem("Row not found", 404)
        walker = Walk(
            engine,
            context,
            cursor,
            bundle,
            nodes,
            edges,
            choices or {},
            offsets or {},
            min(100, max(1, page_size)),
            visited_data,
        )
        roots = walker.children(source, row)
        entries = list(walker.steps.values())
        stops = [e for e in entries if e["state"] == "discarded"]
        reached = [
            e
            for e in entries
            if not e["children"] and e["state"] in {"kept", "grouped", "duplicated", "written"}
        ]
        unknown = [e for e in entries if e["state"] == "unknown"]
        verdicts = [f"Stops at {e['name']}: {reason_text(e['reason'])}." for e in stops]
        if reached:
            # A row written to an export leads with the outputs it reaches; side-branch filters follow.
            written = any(e["state"] == "written" for e in reached)
            verdicts.insert(
                0 if written else len(verdicts),
                "Reaches " + ", ".join(dict.fromkeys(e["name"] for e in reached)) + ".",
            )
        if unknown:
            verdicts.append("Cannot follow at " + ", ".join(e["name"] for e in unknown) + ".")
        evidence = engine.store.get("run", source.run) or {}
        if (
            canceled.is_set()
            or context.db is not database
            or any(
                d.status != "valid" or context.datasets.get(key) is not d for key, d in visited_data.items()
            )
        ):
            raise Problem("Lineage interrupted by recalculation. Select a cell in the new result.", 409)
        return {
            "dataset": dataset,
            "node": source.node,
            "row": row,
            "environment": environment,
            "execution": source.run,
            "commit": evidence.get("commit"),
            "roots": roots,
            "steps": entries,
            "complete": not unknown,
            "stops": [e["id"] for e in stops],
            "reached": [e["id"] for e in reached],
            "verdict": " ".join(verdicts) or "This output has no downstream consumers.",
        }
    except Exception as error:
        if canceled.is_set():
            raise Problem("Lineage interrupted by recalculation", 409) from error
        raise
    finally:
        with context.lock:
            context.lineage.pop(request, None)
        cursor.close()


def reason_text(reason):
    if reason["kind"] == "join":
        return f"no matching row in {reason['missing_node']} for {reason['evaluated']}"
    return f"{reason['evaluated']} is {'NULL' if reason['result'] is None else 'false'}"


class Walk:
    def __init__(self, engine, context, cursor, bundle, nodes, edges, choices, offsets, size, visited):
        self.engine, self.context, self.cursor, self.bundle = engine, context, cursor, bundle
        self.nodes, self.edges = nodes, edges
        self.choices, self.offsets, self.size, self.visited = choices, offsets, size, visited
        self.steps = {}
        with context.lock:
            self.outputs = {d.id: d for ports in context.outputs.values() for d in ports.values()}

    def entry(self, identity, node, port=None):
        return {
            "id": identity,
            "node": node,
            "name": node_name(self.bundle, node),
            "port": port,
            "children": [],
        }

    def children(self, parent, row, stopped=""):
        result = []
        covered = set()
        for data in self.outputs.values():
            if parent.id not in data.dependencies.values():
                continue
            # dependencies also include earlier, unused outputs of this same node.
            if not data.opaque_python and not any(
                t.name == parent.id for t in sqlglot.parse_one(data.query, read="duckdb").find_all(exp.Table)
            ):
                continue
            covered.add(data.node)
            result.append(self.visit(data, parent, row, stopped))
        for edge in self.edges:
            if edge["source"] != parent.node or edge["sourceHandle"] != parent.port:
                continue
            node = edge["target"]
            if node in covered:
                continue
            covered.add(node)
            if self.nodes[node]["parsed"].get("writes_external"):
                result.append(self.export(node, parent, row, stopped))
            else:
                result.append(self.unavailable(node, stopped))

        # Keep the route to an export on the trunk; auxiliary summaries become branches.
        def priority(identity):
            entry = self.steps[identity]
            children = [priority(child) for child in entry["children"]]
            return (
                int(bool(self.nodes[entry["node"]]["parsed"].get("writes_external")))
                + sum(value[0] for value in children),
                1 + max((value[1] for value in children), default=0),
            )

        return sorted(dict.fromkeys(result), key=priority, reverse=True)

    def unavailable(self, node, stopped):
        identity = f"unavailable:{node}:{stopped}"
        if identity not in self.steps:
            entry = self.steps[identity] = self.entry(identity, node)
            entry.update(
                state="unreached" if stopped == "discarded" else "unknown",
                warning="No current downstream row mapping is available.",
            )
            entry["children"] = [
                self.unavailable(e["target"], stopped) for e in self.edges if e["source"] == node
            ]
        return identity

    def visit(self, data, parent, row, stopped):
        identity = f"{data.id}:{parent.id}:{row}:{stopped}"
        if identity in self.steps:
            return identity
        entry = self.steps[identity] = self.entry(identity, data.node, data.port)
        entry["dataset"] = data.id
        self.visited[data.id] = data
        if stopped:
            entry["state"] = "unreached" if stopped == "discarded" else "unknown"
            if stopped == "unknown":
                entry["warning"] = "An upstream row mapping is unavailable."
        else:
            try:
                self.engine.partitions.authorize(self.context.worktree, data.node)
                if data.status != "valid":
                    raise Coverage("This downstream result is stale. Run it again before tracing.")
                for dependency in data.dependencies.values():
                    captured = self.context.datasets.get(dependency)
                    if not captured or captured.status != "valid":
                        raise Coverage("A captured input is unavailable or stale.")
                    if captured.disk or captured.origins or captured.partition or captured.partition_context:
                        raise Coverage("Downstream row tracing across partitions is not yet supported.")
                    self.visited[captured.id] = captured
                matcher = Matcher(self.context, self.cursor, data, parent, row)
                query, parameters, metadata = matcher.match()
                total = self.cursor.execute(f"SELECT count(*) FROM ({query}) matched", parameters).fetchone()[
                    0
                ]
                if total:
                    selected = self.choices.get(identity)
                    if selected is None:
                        selected = self.cursor.execute(
                            query + " ORDER BY rowid LIMIT 1", parameters
                        ).fetchone()[0]
                    elif not self.cursor.execute(
                        f"SELECT rowid FROM ({query}) matched WHERE rowid=?", [*parameters, selected]
                    ).fetchone():
                        raise Problem("The chosen row does not belong to this impact step", 422)
                    offset = max(0, self.offsets.get(identity, 0))
                    projection = ", ".join(f"o.{qi(data.stored(c['name']))}" for c in data.columns)
                    records = self.cursor.execute(
                        f"SELECT o.rowid, {projection} FROM {qi(data.relation)} o WHERE o.rowid IN ({query}) ORDER BY o.rowid LIMIT ? OFFSET ?",
                        [*parameters, self.size, offset],
                    ).fetchall()
                    entry.update(
                        state="duplicated" if total > 1 else "grouped" if metadata.get("grouped") else "kept",
                        row=selected,
                        total=total,
                        offset=offset,
                        columns=[c["name"] for c in data.columns],
                        rows=[{"row": r[0], "values": clean(r[1:])} for r in records],
                        next_offset=offset + len(records) if offset + len(records) < total else None,
                    )
                    entry.update(
                        matcher.group_details(selected)
                        if metadata.get("grouped")
                        else matcher.join_details(selected)
                    )
                else:
                    reason = metadata.get("reason") or matcher.rejection()
                    entry.update(state="discarded", reason=reason)
            except (Coverage, duckdb.Error, sqlglot.errors.SqlglotError) as error:
                entry.update(state="unknown", warning=str(error))
        entry["children"] = self.children(
            data,
            entry.get("row", 0),
            (
                "discarded"
                if entry["state"] in {"discarded", "unreached"}
                else "unknown"
                if entry["state"] == "unknown"
                else ""
            ),
        )
        return identity

    def export(self, node, parent, row, stopped):
        identity = f"export:{node}:{parent.id}:{row}:{stopped}"
        if identity in self.steps:
            return identity
        entry = self.steps[identity] = self.entry(identity, node)
        if stopped:
            entry["state"] = "unreached" if stopped == "discarded" else "unknown"
            if stopped == "unknown":
                entry["warning"] = "An upstream row mapping is unavailable."
            return identity
        entry.update(state="unknown", warning="This export has no exact captured row mapping.")
        record = self.engine.store.get(
            "export_result", digest([self.context.worktree, self.context.environment, node])
        )
        if not record or record["status"] != "success":
            return identity
        run = self.engine.store.get("run", record["run"]) or {}
        state = run.get("nodes", {}).get(node, {})
        if state.get("external_outcome") != "completed":
            return identity
        destinations = []
        for statement in state.get("statements", []):
            if statement.get("test_name") or statement.get("message_block") or statement.get("output"):
                continue
            tree = sqlglot.parse_one(statement["sql"], read="duckdb")
            if isinstance(tree, exp.Copy) and tree.args.get("kind"):
                return identity
            if isinstance(tree, exp.Insert) and any(
                tree.args.get(key) for key in ("conflict", "where", "overwrite", "alternative", "ignore")
            ):
                return identity
            query = (
                tree.this.unnest()
                if isinstance(tree, exp.Copy)
                else tree.expression
                if isinstance(tree, exp.Insert)
                else None
            )
            if isinstance(query, exp.Table):
                query = exp.select("*").from_(query.copy())
            if not isinstance(query, exp.Select) or any(
                value for key, value in query.args.items() if key not in {"expressions", "from_"}
            ):
                return identity
            tables = list(query.find_all(exp.Table))
            if len(tables) != 1 or tables[0].name != parent.id or query.find(exp.AggFunc, exp.Window):
                return identity
            # Only a plain full-row export proves membership without executing the write.
            if len(query.expressions) != 1 or not isinstance(query.expressions[0], exp.Star):
                return identity
            destination = statement.get("export_file", {}).get("filename")
            if not destination:
                destination = (
                    tree.args["files"][0].name
                    if isinstance(tree, exp.Copy)
                    else tree.this.sql(dialect="duckdb")
                )
            destinations.append(Path(destination).name if isinstance(tree, exp.Copy) else destination)
        if destinations:
            entry.update(state="written", destinations=destinations)
            entry.pop("warning")
        return identity
