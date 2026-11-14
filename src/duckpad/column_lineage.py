"""Cached column origins over saved definitions and schema metadata, without data reads."""

from collections import OrderedDict
from contextlib import suppress
from copy import deepcopy
from threading import RLock

import duckdb
import sqlglot
from sqlglot import exp

from .column_analysis import Incomplete, analyze
from .components import expand_for
from .execution.statements import compile_node, statement_kind
from .graph import connection_references, topological
from .types import Record
from .util import Problem, digest, qi


def identity(node, port, column):
    return f"{node}/{port}/{column}"


def retained_schemas(engine, worktree, environment):
    """Columns of every retained output, keyed by (node, port)."""
    context = engine.pool.find(worktree, environment)
    if context is None:
        return {}
    with context.lock:
        return {
            (key, port): deepcopy(output.columns)
            for key, outputs in context.outputs.items()
            for port, output in outputs.items()
        }


def stale_outputs(engine, worktree, environment):
    """Retained outputs computed from other definitions than the saved ones."""
    context = engine.pool.find(worktree, environment)
    if context is None:
        return frozenset()
    with context.lock:
        return frozenset(
            (key, port)
            for key, outputs in context.outputs.items()
            for port, output in outputs.items()
            if output.status != "valid"
        )


def static_nodes(bundle, environment, computed):
    """A partition filter does not change a schema; unresolved partition expressions do."""
    nodes, edges, boundaries = expand_for(bundle, environment, computed=computed)
    for node in nodes.values():
        if node.get("partition_error") == "partition_not_calculated":
            node.pop("error", None)
    return nodes, edges, boundaries


class ColumnLineage:
    def __init__(self, engine):
        self.engine = engine
        self.cache = OrderedDict()
        self.lock = RLock()

    def analysis(self, worktree, environment, *, snapshot=None):
        engine = self.engine
        snapshot = snapshot or engine.projects.snapshot(worktree)
        bundle = snapshot["bundle"]
        if bundle is None:
            raise Problem("Project files are invalid", 422)
        engine.catalog.environment(environment)
        schemas = retained_schemas(engine, worktree, environment)
        stale = stale_outputs(engine, worktree, environment)
        computed = engine.pool.computed(worktree, environment, bundle)
        key = (worktree, environment, digest([bundle, sorted(schemas.items()), sorted(stale), computed]))
        with self.lock:
            analysis = self.cache.get(key)
            if analysis is None:
                analysis = self._build(worktree, environment, snapshot, schemas, computed, stale)
                self.cache[key] = analysis
                while len(self.cache) > 8:
                    self.cache.popitem(last=False)
            self.cache.move_to_end(key)
        return analysis

    def simulate(self, worktree, environment, snapshot, schemas, pinned=()):
        """Analyze definitions that are not saved yet. Every output that can be described
        from its code is; the others, and the `pinned` ones, keep the columns of `schemas`."""
        computed = self.engine.pool.computed(worktree, environment, snapshot["bundle"])
        stale = frozenset(schemas) - frozenset(pinned)
        return self._build(worktree, environment, snapshot, schemas, computed, stale)

    def describe(self, worktree, environment, node, port=None, column=None, *, snapshot=None):
        outputs, steps, boundaries = self.analysis(worktree, environment, snapshot=snapshot)
        if node in boundaries:
            ports = boundaries[node]["outputs"]
            chosen = {
                name: outputs.get(tuple(target)) for name, target in ports.items() if not port or name == port
            }
        else:
            chosen = {
                name: value
                for (key, name), value in outputs.items()
                if key == node and (not port or name == port)
            }
        written = {}
        if not chosen:
            # A node without output, an export, writes what it reads: like its results,
            # its columns are those of each input, carried as they are.
            for name, target in self._inputs(worktree, environment, node, snapshot).items():
                upstream = outputs.get(target)
                if upstream is None or (port and name != port):
                    continue
                columns = []
                for item in upstream["columns"]:
                    read = steps[item["id"]]
                    id_ = identity(node, name, item["name"])
                    written[id_] = {
                        **read,
                        "id": id_,
                        "node": node,
                        "port": name,
                        "kind": "carried",
                        "expression": None,
                        "inputs": [{k: read[k] for k in ("id", "node", "port", "column")}],
                        "selection": [],
                        "tables": [{"node": target[0], "port": target[1]}],
                        "description": "",
                        "resource": {},
                    }
                    columns.append({**item, "id": id_, "kind": "carried"})
                chosen[name] = {**upstream, "columns": columns, "written": True}
        if not chosen:
            raise Problem("Node or output not found", 404)
        result = {
            "node": node,
            "outputs": [{"port": name, **value} for name, value in chosen.items() if value],
        }
        if column is None:
            return deepcopy(result)
        if not port and len(chosen) != 1:
            raise Problem("Choose an output for this column", 422)
        output = next(iter(chosen.values()))
        root = next((c["id"] for c in output["columns"] if c["name"] == column), None)
        if root is None:
            if output["status"] != "complete":
                return {**result, "root": None, "steps": [], "complete": False}
            raise Problem("Column not found", 404)
        selected = {}

        def visit(key):
            step = written.get(key) or steps.get(key)
            if key in selected or step is None:
                return
            selected[key] = step
            for ref in step["inputs"]:
                visit(ref["id"])

        visit(root)
        return deepcopy(
            {
                **result,
                "root": root,
                "steps": list(selected.values()),
                "complete": all(s["status"] == "complete" for s in selected.values()),
            }
        )

    def _inputs(self, worktree, environment, node, snapshot=None):
        """The upstream output read by each input of a node which has no output of its own."""
        bundle = (snapshot or self.engine.projects.snapshot(worktree))["bundle"]
        computed = self.engine.pool.computed(worktree, environment, bundle)
        nodes, edges, _ = static_nodes(bundle, environment, computed)
        if node not in nodes or nodes[node]["parsed"]["outputs"]:
            return {}
        return {e["targetHandle"]: (e["source"], e["sourceHandle"]) for e in edges if e["target"] == node}

    def _build(self, worktree, environment, snapshot, schemas, computed, stale=frozenset()):
        engine = self.engine
        bundle = snapshot["bundle"]
        nodes, edges, boundaries = static_nodes(bundle, environment, computed)
        project = snapshot["worktree"]["project"]
        files = engine.store.paths.project_files(project, worktree, environment)
        outputs, steps, relations = {}, {}, {}
        # An isolated empty database can describe literal queries and typed empty inputs.
        # It cannot open files, attach connections, install extensions or read any project rows.
        with duckdb.connect(
            config={
                "enable_external_access": False,
                "autoload_known_extensions": False,
                "autoinstall_known_extensions": False,
                "threads": 1,
            }
        ) as db:
            for index, key in enumerate(topological(nodes, edges, tolerant=True)):
                node = nodes[key]
                incoming = [e for e in edges if e["target"] == key]
                inputs = {
                    e["targetHandle"]: qi(relations[(e["source"], e["sourceHandle"])])
                    for e in incoming
                    if (e["source"], e["sourceHandle"]) in relations
                }
                names = {port: f"relation_{index}_{i}" for i, port in enumerate(node["parsed"]["outputs"])}
                relations.update({(key, port): name for port, name in names.items()})
                dependencies = {
                    relations[(e["source"], e["sourceHandle"])]: (e["source"], e["sourceHandle"])
                    for e in incoming
                    if (e["source"], e["sourceHandle"]) in relations
                }
                columns = {
                    e["targetHandle"]: outputs.get((e["source"], e["sourceHandle"]), {}).get("columns", [])
                    for e in incoming
                }
                statements = {}
                reason = "python" if node.get("language") == "python" else "incomplete"
                if not node.get("error") and reason != "python":
                    try:
                        captured, _ = engine.pool.connections.capture(
                            worktree, connection_references(node), environment
                        )
                        statements = {
                            s["output"]: s
                            for s in compile_node(node, inputs, names, captured, files, columns)
                            if statement_kind(s) == "output"
                        }
                    except (Problem, sqlglot.errors.SqlglotError, KeyError):
                        pass
                for port, relation in names.items():
                    statement = statements.get(port)
                    known = schemas.get((key, port))
                    analyzed = None
                    source = False
                    status = reason
                    missing = list(
                        dict.fromkeys(
                            n
                            for target in dependencies.values()
                            for n in outputs.get(target, {}).get("run_nodes", [])
                        )
                    )
                    schema = {
                        name: {c["name"]: c["type"] or "UNKNOWN" for c in outputs[target]["columns"]}
                        for name, target in dependencies.items()
                        if target in outputs and outputs[target]["columns"]
                    }
                    if statement:
                        query = sqlglot.parse_one(statement["sql"], read="duckdb")
                        if not isinstance(query, exp.Query):
                            raise Problem("An output must be a query", 422)
                        # A block reading an earlier output remains a link, even on a source node.
                        reads = [t for t in query.find_all(exp.Table) if t.name in dependencies]
                        source = bool(statement["source"] and not reads)
                        try:
                            labels = {
                                relations[(e["source"], e["sourceHandle"])]: e["targetHandle"]
                                for e in incoming
                                if (e["source"], e["sourceHandle"]) in relations
                            }
                            labels.update({value: name for name, value in names.items()})
                            analyzed = (
                                analyze(statement["sql"], schema, labels, statement["bindings"])
                                if not source
                                else None
                            )
                            status = "complete"
                        except (Incomplete, sqlglot.errors.SqlglotError, KeyError, IndexError):
                            status = "incomplete"
                        # Columns retained from other definitions describe an older query: the
                        # saved code is the reference whenever DuckDB can describe it.
                        if known is None or (key, port) in stale:
                            try:
                                described = db.execute(
                                    "DESCRIBE " + statement["sql"], statement["bindings"]
                                ).fetchall()
                                # Duplicate names are renamed when stored: only a run knows them.
                                if len({c[0].casefold() for c in described}) == len(described):
                                    known = [{"name": c[0], "type": c[1]} for c in described]
                            except duckdb.Error:
                                # Explicit output names are still useful without a type. Stars
                                # with unknown schemas must name the node to run instead.
                                selected = [a["name"] for a in analyzed] if analyzed else query.named_selects
                                if known is None and selected and "*" not in selected:
                                    known = [{"name": name, "type": ""} for name in selected]
                    if not known:
                        known = []
                        status = "python" if reason == "python" else "needs_run"
                        missing = missing or [key]
                    elif analyzed is not None and [c["name"].casefold() for c in known] != [
                        a["name"].casefold() for a in analyzed
                    ]:
                        # Retained columns may belong to an older definition. Never align by position.
                        analyzed = None
                        status = "incomplete"
                    descriptions = bundle.get("documentation", {}).get("columns", {}).get(f"{key}:{port}", {})
                    entries = []

                    def reference(ref, dependencies=dependencies):
                        target, output = dependencies[ref[0]]
                        return {
                            "id": identity(target, output, ref[1]),
                            "node": target,
                            "port": output,
                            "column": ref[1],
                        }

                    for col in known:
                        id_ = identity(key, port, col["name"])
                        # DuckDB keeps the written case of a name and compares names without it.
                        analysis = next(
                            (a for a in analyzed or [] if a["name"].casefold() == col["name"].casefold()),
                            None,
                        )
                        refs = [reference(ref) for ref in analysis["refs"]] if analysis else []
                        kind = (
                            "source"
                            if source
                            else "carried"
                            if analysis and analysis["passthrough"]
                            else "computed"
                        )
                        item: Record = {
                            "id": id_,
                            "node": key,
                            "port": port,
                            "column": col["name"],
                            "type": col["type"],
                            "kind": kind,
                            "status": status,
                            "expression": analysis["expression"] if analysis else None,
                            "inputs": refs,
                            "selection": [
                                {**s, "inputs": [reference(ref) for ref in s["refs"]]}
                                for s in analysis["selection"]
                            ]
                            if analysis
                            else [],
                            "tables": [{"node": e["source"], "port": e["sourceHandle"]} for e in incoming],
                            "description": descriptions.get(col["name"], ""),
                            "resource": {
                                p["name"]: node.get("params", {}).get(p["name"], p.get("default"))
                                for p in node["parsed"]["parameters"]
                                if p["name"] in {"file", "path", "table", "filename"}
                                or p["type"] == "connection"
                            }
                            if source
                            else {},
                            "run_nodes": missing,
                        }
                        for condition in item["selection"]:
                            condition.pop("refs")
                        steps[id_] = item
                        origin = item
                        visited = set()
                        while (
                            origin["kind"] == "carried"
                            and len(origin["inputs"]) == 1
                            and origin["id"] not in visited
                        ):
                            visited.add(origin["id"])
                            origin = steps.get(origin["inputs"][0]["id"], origin)
                        entries.append(
                            {
                                **col,
                                "id": id_,
                                "kind": kind,
                                "status": status,
                                "origin": {
                                    k: origin[k] for k in ("node", "port", "column", "kind", "status")
                                },
                            }
                        )
                    outputs[(key, port)] = {
                        "columns": entries,
                        "status": status,
                        "run_nodes": missing,
                        "tables": [{"node": e["source"], "port": e["sourceHandle"]} for e in incoming]
                        if reason == "python"
                        else [],
                    }
                    if known and all(c["type"] for c in known):
                        with suppress(duckdb.Error):
                            db.execute(
                                f"CREATE TABLE {qi(relation)} ("
                                + ", ".join(f"{qi(c['name'])} {c['type']}" for c in known)
                                + ")"
                            )
                    dependencies[relation] = (key, port)
        return outputs, steps, boundaries
