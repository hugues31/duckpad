"""Compile hypothetical schemas in an empty, isolated database. Never execute a run."""

from copy import deepcopy

import duckdb
import sqlglot
from sqlglot import exp

from . import processing
from .bundle import files_to_bundle
from .catalog import redact
from .column_analysis import Incomplete, analyze
from .column_impact import inspect
from .column_lineage import static_nodes
from .column_references import query_tree
from .comparison import potential_impact
from .execution.statements import compile_node, statement_kind
from .graph import connection_references, reachable, topological
from .node_code import code_path, find_node, template_path
from .node_names import node_name
from .types import Record
from .util import Problem, digest, qi


def retained_schemas(engine, worktree, environment):
    context = engine.pool.find(worktree, environment)
    if context is None:
        return {}
    with context.lock:
        return {
            (key, port): deepcopy(output.columns)
            for key, outputs in context.outputs.items()
            for port, output in outputs.items()
        }


def location(bundle, key):
    node, parent = find_node(bundle, key)
    return {
        "node": key,
        "name": node_name(bundle, key),
        "file": template_path(node["template"])
        if node.get("template")
        else code_path(node["id"], parent, node.get("language", "sql")),
    }


def compile_schemas(engine, worktree, environment, bundle, retained, *, override=None):
    """Describe SQL against empty inputs; stop propagation at unknown or failed outputs.

    Retained metadata supplies external source schemas only. Downstream schemas
    always come from the definitions being inspected, including earlier outputs
    of the same node. COPY/INSERT destinations are never opened.
    """
    engine.catalog.environment(environment)
    computed = engine.pool.computed(worktree, environment, bundle)
    nodes, edges, boundaries = static_nodes(bundle, environment, computed)
    project = engine.projects.get(worktree)["project"]
    files = engine.store.paths.project_files(project, worktree, environment)
    names = {
        (key, port): "schema_" + digest([key, port])[:20]
        for key, node in nodes.items()
        for port in node["parsed"]["outputs"]
    }
    outputs: dict[tuple[str, str], list[Record]] = {}
    failures, unknown, signatures = [], [], {}
    dependencies, export_dependencies, export_nodes = {}, {}, set()
    targets = {name: target for target, name in names.items()}
    with duckdb.connect(
        config={
            "enable_external_access": False,
            "autoload_known_extensions": False,
            "autoinstall_known_extensions": False,
            "threads": 1,
        }
    ) as db:
        for key in topological(nodes, edges, tolerant=True):
            node = nodes[key]
            entry = location(bundle, key)
            incoming = [e for e in edges if e["target"] == key]
            inputs = {
                e["targetHandle"]: qi(names[(e["source"], e["sourceHandle"])])
                for e in incoming
                if (e["source"], e["sourceHandle"]) in names
            }
            if node.get("language") == "python" or node.get("error"):
                unknown.append(
                    {**entry, "reason": "python" if node.get("language") == "python" else "incomplete"}
                )
                continue
            secrets = []
            try:
                captured, secrets = engine.pool.connections.capture(
                    worktree, connection_references(node), environment
                )
                statements = compile_node(
                    node,
                    inputs,
                    {p: names[key, p] for p in node["parsed"]["outputs"]},
                    captured,
                    files,
                    {e["targetHandle"]: outputs.get((e["source"], e["sourceHandle"]), []) for e in incoming},
                )
            except (Problem, sqlglot.errors.SqlglotError, KeyError) as error:
                unknown.append({**entry, "reason": "incomplete", "error": redact(str(error), secrets)})
                continue
            for statement in statements:
                kind = statement_kind(statement)
                if kind == "exports":
                    export_nodes.add(key)
                port = statement["output"]
                detail = {**entry, "port": port, "label": statement.get("test_name") or port or kind}
                try:
                    query = query_tree(statement["sql"])
                except (Incomplete, sqlglot.errors.SqlglotError):
                    unknown.append({**detail, "reason": "incomplete"})
                    continue
                tables = list(query.find_all(exp.Table))
                ctes = {c.alias for c in query.find_all(exp.CTE)}
                external = any(
                    not isinstance(t.this, exp.Identifier) or t.name not in set(names.values()) | ctes
                    for t in tables
                )
                if external:
                    # An external reader can inspect files even during binding. Never bind it.
                    columns = retained.get((key, port)) if statement["source"] else None
                    if not columns or not all(c["type"] for c in columns):
                        unknown.append({**detail, "reason": "needs_run"})
                        continue
                    columns = deepcopy(columns)
                else:
                    unavailable = [
                        target
                        for target, name in names.items()
                        if name in {t.name for t in tables} and target not in outputs
                    ]
                    if unavailable:
                        unknown.append(
                            {**detail, "reason": "upstream", "upstream": [k for k, _ in unavailable]}
                        )
                        continue
                    try:
                        sql = query.sql(dialect="duckdb") if kind == "exports" else statement["sql"]
                        # Export bindings can include a destination removed with COPY/INSERT.
                        used = {p.name for p in query.find_all(exp.Placeholder)}
                        bindings = (
                            {k: v for k, v in statement["bindings"].items() if k in used}
                            if kind == "exports"
                            else statement["bindings"]
                        )
                        described = db.execute("DESCRIBE " + sql, bindings).fetchall()
                        columns = [{"name": c[0], "type": c[1]} for c in described]
                    except duckdb.Error as error:
                        failures.append({**detail, "error": redact(str(error), secrets)})
                        continue
                try:
                    analysis = analyze(
                        query.sql(dialect="duckdb"),
                        {
                            names[target]: {c["name"]: c["type"] for c in cols}
                            for target, cols in outputs.items()
                        },
                        bindings=statement["bindings"],
                    )
                    if kind == "output":
                        signatures[key, port] = {
                            c["name"]: (c["expression"], c["refs"], c["selection"]) for c in analysis
                        }
                    for c in analysis:
                        refs = set(c["refs"]) | {ref for s in c["selection"] for ref in s["refs"]}
                        linked = {(*targets[table], name) for table, name in refs}
                        if kind == "output":
                            dependencies[key, port, c["name"]] = linked
                        elif kind == "exports":
                            export_dependencies.setdefault(key, set()).update(linked)
                except (Incomplete, sqlglot.errors.SqlglotError, KeyError, IndexError):
                    pass
                if kind != "output":
                    continue
                if override and (key, port) == override[:2]:
                    columns = [{**c, "type": override[3]} if c["name"] == override[2] else c for c in columns]
                try:
                    db.execute(
                        f"CREATE TABLE {qi(names[key, port])} ("
                        + ", ".join(f"{qi(c['name'])} {c['type']}" for c in columns)
                        + ")"
                    )
                except duckdb.Error as error:
                    unknown.append({**detail, "reason": "incomplete", "error": redact(str(error), secrets)})
                    continue
                outputs[key, port] = columns
    return {
        "outputs": outputs,
        "failures": failures,
        "unknown": unknown,
        "signatures": signatures,
        "nodes": nodes,
        "edges": edges,
        "boundaries": boundaries,
        "dependencies": dependencies,
        "export_dependencies": export_dependencies,
        "export_nodes": export_nodes,
    }


def schema_changes(before, after, keys):
    changes = []
    for key in sorted(keys):
        # Unknown schemas are not empty schemas and must never look like dropped columns.
        if any(
            key not in value["outputs"]
            and key[0] in value["nodes"]
            and key[1] in value["nodes"][key[0]]["parsed"]["outputs"]
            for value in (before, after)
        ):
            continue
        old = {c["name"]: c["type"] for c in before["outputs"].get(key, [])}
        new = {c["name"]: c["type"] for c in after["outputs"].get(key, [])}
        removed, added = set(old) - set(new), set(new) - set(old)
        renamed = []
        a, b = (value["signatures"].get(key, {}) for value in (before, after))
        for name in sorted(removed):
            candidates = [
                n for n in added if name in a and n in b and a[name] == b[n] and old[name] == new[n]
            ]
            if len(candidates) == 1 and sum(a.get(n) == a[name] for n in removed) == 1:
                replacement = candidates[0]
                renamed.append({"before": name, "after": replacement})
                added.remove(replacement)
        removed -= {c["before"] for c in renamed}
        retyped = [
            {"name": n, "before": old[n], "after": new[n]}
            for n in sorted(old.keys() & new.keys())
            if old[n] != new[n]
        ]
        if added or removed or renamed or retyped:
            changes.append(
                {
                    "node": key[0],
                    "port": key[1],
                    "added": sorted(added),
                    "removed": sorted(removed),
                    "renamed": renamed,
                    "retyped": retyped,
                }
            )
    return changes


def simulate(engine, worktree, environment, node, port, column, new_type):
    try:
        normalized = str(duckdb.sqltype(new_type))
    except duckdb.Error:
        raise Problem("Enter a valid DuckDB type.", 422) from None
    snapshot = engine.projects.snapshot(worktree)
    if snapshot["bundle"] is None:
        raise Problem("Fix project definitions before simulating a type change.", 422)
    bundle = snapshot["bundle"]
    retained = retained_schemas(engine, worktree, environment)
    before = compile_schemas(engine, worktree, environment, bundle, retained)
    target = (
        tuple(before["boundaries"][node]["outputs"].get(port, ()))
        if node in before["boundaries"]
        else (node, port)
    )
    current = next((c for c in before["outputs"].get(target, []) if c["name"] == column), None)
    if current is None:
        raise Problem("The column schema is unavailable. Run its source before simulating.", 422)
    after = compile_schemas(
        engine, worktree, environment, bundle, retained, override=(*target, column, normalized)
    )
    downstream = reachable({target[0]}, before["edges"], upstream=False)
    old_errors = {(f["node"], f["label"]) for f in before["failures"]}
    impact, _ = inspect(engine, worktree, environment, node, port, column, snapshot=snapshot)
    return {
        "revision": snapshot["revision"],
        "before": current["type"],
        "after": normalized,
        "changes": schema_changes(before, after, {k for k in after["outputs"] if k[0] in downstream}),
        "failures": [
            {**f, "existing": (f["node"], f["label"]) in old_errors}
            for f in after["failures"]
            if f["node"] in downstream
        ],
        "unknown": [f for f in after["unknown"] if f["node"] in downstream],
        "exports": [{**e, **location(bundle, e["node"])} for e in impact["exports"]],
    }


def review_impact(engine, worktree, environment, current, proposed):
    before_bundle, after_bundle = files_to_bundle(current), files_to_bundle(proposed)
    retained = retained_schemas(engine, worktree, environment)
    before = compile_schemas(engine, worktree, environment, before_bundle, retained)
    after_nodes, _, _ = static_nodes(
        after_bundle, environment, engine.pool.computed(worktree, environment, after_bundle)
    )
    # A changed external source definition cannot borrow the old source's schema.
    candidate_schemas = {
        k: v
        for k, v in retained.items()
        if k[0] in before["nodes"]
        and k[0] in after_nodes
        and processing.inputs(before_bundle, before["nodes"][k[0]])
        == processing.inputs(after_bundle, after_nodes[k[0]])
    }
    after = compile_schemas(engine, worktree, environment, after_bundle, candidate_schemas)
    impact = potential_impact(before_bundle, after_bundle)
    direct = set(impact["direct"])
    affected = reachable(direct, before["edges"] + after["edges"], upstream=False)
    changes = schema_changes(
        before, after, {k for k in before["outputs"].keys() | after["outputs"].keys() if k[0] in affected}
    )
    old_errors = {(f["node"], f["label"]) for f in before["failures"]}
    # Follow the same SQLGlot column dependencies as column Impact. Row-selection
    # inputs also affect export contents, even when their output types are stable.
    tainted = set()
    for value, other in ((before, after), (after, before)):
        for (key, port), columns in value["outputs"].items():
            if key not in direct:
                continue
            other_types = {c["name"]: c["type"] for c in other["outputs"].get((key, port), [])}
            signatures = value["signatures"].get((key, port), {})
            other_signatures = other["signatures"].get((key, port), {})
            for column in columns:
                name = column["name"]
                if (
                    name not in signatures
                    or signatures[name] != other_signatures.get(name)
                    or column["type"] != other_types.get(name)
                ):
                    tainted.add((key, port, name))
    while True:
        extra = {
            key for value in (before, after) for key, refs in value["dependencies"].items() if refs & tainted
        }
        if extra <= tainted:
            break
        tainted |= extra
    affected_exports = direct | {
        key
        for value in (before, after)
        for key, refs in value["export_dependencies"].items()
        if refs & tainted
    }
    exports = []
    for key in sorted(affected_exports & after["nodes"].keys()):
        n = after["nodes"][key]
        if key not in after["export_nodes"]:
            continue
        exports.append(
            {
                **location(after_bundle, key),
                "resource": {
                    p["name"]: n.get("params", {}).get(p["name"], p.get("default"))
                    for p in n["parsed"]["parameters"]
                    if p["type"].split("(")[0] in {"destination", "table_name", "schema_name"}
                },
            }
        )
    return {
        "changes": [
            {
                **c,
                **location(after_bundle if c["node"] in after["nodes"] else before_bundle, c["node"]),
                "direct": c["node"] in direct,
            }
            for c in changes
        ],
        "failures": [
            {**f, "existing": (f["node"], f["label"]) in old_errors, "direct": f["node"] in direct}
            for f in after["failures"]
            if f["node"] in affected
        ],
        "unknown": [f for f in after["unknown"] if f["node"] in affected],
        "exports": exports,
    }
