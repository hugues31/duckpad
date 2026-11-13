"""Column impact and reviewed, atomic renames over saved project definitions."""

from collections import defaultdict
from copy import deepcopy
from difflib import SequenceMatcher

import sqlglot
from sqlglot import exp

from .bundle import bundle_to_files
from .column_analysis import Incomplete
from .column_lineage import identity, static_nodes
from .column_references import export_inputs, local_alias, references, replace_spans
from .components import expand
from .execution.statements import compile_node
from .graph import connection_references, reachable, topological
from .node_code import code_path, find_node, template_path
from .templates import IDENTIFIER, REFERENCE, VARIABLE_REFERENCE
from .types import Record
from .util import Problem, digest, qi


def parameter_owner(bundle, key, name):
    """Follow an exposed parameter back to its instance, including nested components."""
    while "::" in key:
        parent, local = key.rsplit("::", 1)
        instance, _ = find_node(bundle, parent)
        definition = bundle["components"][instance["component"]]
        exposed = next(
            (
                p
                for p, v in definition.get("parameters", {}).items()
                if {"node": local, "param": name} in v.get("targets", [])
            ),
            None,
        )
        if exposed is None:
            break
        key, name = parent, exposed
    return key, name


def rendered(block, code):
    """Render a compiler source map with a location for each character."""
    source = block["source_location"]
    raw = source["sql"]
    lines = code.splitlines(keepends=True)
    offsets = []
    for index, line in enumerate(raw.splitlines(keepends=True)):
        start = sum(len(s) for s in lines[: source["lines"][index] - 1])
        if index == 0:
            start += source["column"] - 1
        offsets.extend(range(start, start + len(line)))
    parts, locations, start = [], [], 0
    for match in REFERENCE.finditer(raw):
        parts.append(raw[start : match.start()])
        locations.extend((None, i) for i in offsets[start : match.start()])
        value = source["values"][match[1]]
        parts.append(value)
        locations.extend((match[1], i) for i in range(len(value)))
        start = match.end()
    parts.append(raw[start:])
    locations.extend((None, i) for i in offsets[start:])
    return "".join(parts), locations


def parameter_spans(rendered_value, raw, spans):
    """Map normalized expression tokens back to the saved parameter's exact text."""
    before = sqlglot.tokenize(raw, read="duckdb")
    after = sqlglot.tokenize(rendered_value, read="duckdb")
    matcher = SequenceMatcher(
        None, [t.text.casefold() for t in before], [t.text.casefold() for t in after], autojunk=False
    )
    mapping = {b + i: a + i for a, b, size in matcher.get_matching_blocks() for i in range(size)}
    result = []
    for start, end in spans:
        index = next((i for i, t in enumerate(after) if t.start == start and t.end + 1 == end), None)
        if index not in mapping:
            raise Incomplete("parameter_mapping")
        token = before[mapping[index]]
        result.append((token.start, token.end + 1))
    return result


def replace_parameter(raw, spans, name):
    if isinstance(raw, str):
        return replace_spans(raw, spans, name)
    result, offset = [], 0
    for item in raw:
        local = [
            (start - offset, end - offset)
            for start, end in spans
            if offset <= start < end <= offset + len(item)
        ]
        result.append(replace_spans(item, local, name))
        offset += len(item) + 2
    return result


def edited_bundle(bundle, code_changes, param_changes):
    """Specialize shared definitions only when their instances require different edits.

    This keeps unrelated branches intact. Identical variants share one definition;
    deterministic names make preview and apply describe exactly the same files.
    """
    result = deepcopy(bundle)
    variants = defaultdict(dict)
    uses = defaultdict(set)
    expanded, _, _ = expand(bundle, tolerant=True)
    template_values = defaultdict(set)
    for key, node in expanded.items():
        if node.get("template"):
            template_values[node["template"]].add(code_changes.get(key, node["template_sql"]))
    shared_templates = {name for name, values in template_values.items() if len(values) == 1}
    for name in shared_templates:
        result["templates"][name] = next(iter(template_values[name]))

    def visit(graph, prefix="", component=None):
        graph = deepcopy(graph)
        code = {}
        for node in graph.get("nodes", []):
            key = prefix + node["id"]
            for (owner, parameter), value in param_changes.items():
                if owner == key:
                    node.setdefault("params", {})[parameter] = value
            if node.get("component"):
                original = node["component"]
                inner, local_code = visit(bundle["components"][original], key + "::", original)
                baseline = {
                    n["id"]: bundle["node_sql"][code_path(n["id"], original, n.get("language", "sql"))]
                    for n in bundle["components"][original]["nodes"]
                    if not n.get("component") and not n.get("template")
                }
                if inner != bundle["components"][original] or local_code != baseline:
                    variant = original + "_" + digest([inner, local_code])[:8]
                    variants[original][variant] = (inner, local_code)
                    node["component"] = variant
                uses[original].add(node["component"])
            elif key in code_changes:
                if node.get("template") not in shared_templates:
                    node.pop("template", None)
                    code[node["id"]] = code_changes[key]
            elif not node.get("template"):
                code[node["id"]] = bundle["node_sql"][
                    code_path(node["id"], component, node.get("language", "sql"))
                ]
        return graph, code

    result["flow"], root_code = visit(bundle["flow"])
    remap = {next(iter(names)): original for original, names in uses.items() if len(names) == 1}

    def remapped(graph):
        for node in graph.get("nodes", []):
            if node.get("component") in remap:
                node["component"] = remap[node["component"]]
        return graph

    remapped(result["flow"])
    for key, text in root_code.items():
        node = next(n for n in result["flow"]["nodes"] if n["id"] == key)
        result["node_sql"][code_path(key, language=node.get("language", "sql"))] = text
    for definitions in variants.values():
        for name, (graph, code) in definitions.items():
            name = remap.get(name, name)
            remapped(graph)
            graph["id"] = name
            result["components"][name] = graph
            for key, text in code.items():
                node = next(n for n in graph["nodes"] if n["id"] == key)
                result["node_sql"][code_path(key, name, node.get("language", "sql"))] = text
    return result


def inspect(engine, worktree, environment, node, port, column, *, new_name=None, snapshot=None):
    snapshot = snapshot or engine.projects.snapshot(worktree)
    bundle = snapshot["bundle"]
    if new_name is not None and (not IDENTIFIER.fullmatch(new_name) or new_name.startswith("__dp_")):
        raise Problem(
            "Use a valid column identifier: letters, digits and underscores, starting with a letter or underscore.",
            422,
        )
    outputs, steps, boundaries = engine.column_lineage.analysis(worktree, environment, snapshot=snapshot)
    target = tuple(boundaries[node]["outputs"].get(port, ())) if node in boundaries else (node, port)
    root = identity(*target, column) if len(target) == 2 else ""
    if root not in steps:
        raise Problem(f"No schema for {column} yet. Run the flow to refresh column schemas.", 422)
    computed = engine.pool.computed(worktree, environment, bundle)
    nodes, edges, _ = static_nodes(bundle, environment, computed)
    downstream = reachable({target[0]}, edges, upstream=False)
    tainted = {root}
    # Value dependencies propagate; predicates are edits, not renamed output columns.
    while True:
        extra = {key for key, step in steps.items() if any(r["id"] in tainted for r in step["inputs"])}
        if extra <= tainted:
            break
        tainted |= extra
    result: Record = {
        "node": node,
        "port": port,
        "column": column,
        "revision": snapshot["revision"],
        "edit": [],
        "follows": [],
        "derived": [],
        "exports": [],
        "manual": [],
        "unaffected": [],
        "mentions": [],
        "source": False,
    }
    renamed = defaultdict(set)
    renamed[target].add(column)
    relation = {key: f"impact_{i}" for i, key in enumerate(outputs)}
    schema = {
        relation[key]: {c["name"]: c["type"] or "UNKNOWN" for c in value["columns"]}
        for key, value in outputs.items()
        if value["columns"]
    }
    affected_refs = {
        (relation[(step["node"], step["port"])], step["column"])
        for key, step in steps.items()
        if key in tainted
    }
    project = snapshot["worktree"]["project"]
    files = engine.store.paths.project_files(project, worktree, environment)
    code_spans, params = defaultdict(set), defaultdict(set)
    param_values = {}
    insertions = defaultdict(list)
    automatic = set()
    touched, manual = {target[0]}, set()

    def review(key, reason, **details):
        signature = (key, reason, str(details))
        if signature not in manual:
            manual.add(signature)
            result["manual"].append({"node": key, "reason": reason, **details})
        touched.add(key)

    for key in topological(nodes, edges, tolerant=True):
        if key not in downstream:
            continue
        item = nodes[key]
        incoming = [e for e in edges if e["target"] == key]
        if item.get("language") == "python" or item.get("error"):
            review(key, "python" if item.get("language") == "python" else "incomplete")
            continue
        input_relations = {
            e["targetHandle"]: qi(relation[(e["source"], e["sourceHandle"])])
            for e in incoming
            if (e["source"], e["sourceHandle"]) in relation
        }
        names = {p: relation[(key, p)] for p in item["parsed"]["outputs"] if (key, p) in relation}
        try:
            captured, _ = engine.pool.connections.capture(worktree, connection_references(item), environment)
            statements = compile_node(item, input_relations, names, captured, files)
        except (Problem, sqlglot.errors.SqlglotError, KeyError):
            review(key, "incomplete")
            continue
        authored, parent = find_node(bundle, key)
        path = (
            template_path(authored["template"])
            if authored.get("template")
            else code_path(authored["id"], parent)
        )
        shared = (
            sum(n.get("template") == authored.get("template") for n in nodes.values())
            if authored.get("template")
            else sum(
                find_node(bundle, n)[1] == parent for n in nodes if n.rsplit("::", 1)[-1] == authored["id"]
            )
            if parent
            else 1
        )
        code = item["template_sql"]
        for statement in statements:
            output = (key, statement["output"])
            label = statement.get("test_name") or (
                "message" if statement.get("message_block") else statement["output"] or "export"
            )
            text, locations = rendered(statement, code)
            active = {relation[p]: names for p, names in renamed.items() if p in relation and p != output}
            force = column if output == target else None
            try:
                carried = set()
                if statement["source"] and output == target:
                    tree = sqlglot.parse_one(text, read="duckdb")
                    if not isinstance(tree, exp.Query):
                        raise Incomplete("source_query")
                    selected = next((s for s in tree.selects if s.alias_or_name == column), None)
                    alias = selected.args.get("alias") if isinstance(selected, exp.Alias) else None
                    spans = [(alias.meta["start"], alias.meta["end"] + 1)] if alias is not None else []
                    follows = {column}
                    result["source"] = alias is None
                else:
                    spans, follows = references(text, schema, active, definition=force, automatic=carried)
                insertion = None
                if force and steps[root]["kind"] == "carried":
                    insertion = local_alias(text, column, new_name or "__impact_column__")
                    if insertion:
                        position, addition = insertion
                        owner, offset = locations[position - 1]
                        if owner is not None:
                            raise Incomplete("parameter_alias")
                        insertions[key].append((offset + 1, addition))
                if statement["output"]:
                    renamed[output] |= follows
                    automatic.update(identity(*output, name) for name in carried)
                grouped = defaultdict(set)
                for start, end in spans:
                    owner, offset = locations[start]
                    last_owner, last = locations[end - 1]
                    if owner != last_owner or last - offset != end - start - 1:
                        raise Incomplete("source_mapping")
                    grouped[owner].add((offset, last + 1))
                pending_params = []
                for parameter, spans_ in grouped.items():
                    if parameter is None:
                        continue
                    definition = next(
                        (p for p in item["parsed"]["parameters"] if p["name"] == parameter), None
                    )
                    if definition is None:
                        raise Incomplete("relation_identifier")
                    raw = item.get("params", {}).get(parameter, definition.get("default"))
                    expression_list = isinstance(raw, list) and all(isinstance(v, str) for v in raw)
                    if (not isinstance(raw, str) and not expression_list) or definition["type"].split("(")[
                        0
                    ] not in {
                        "expression",
                        "expressions",
                        "column",
                        "identifier",
                    }:
                        raise Incomplete("parameter_type")
                    owner = parameter_owner(bundle, key, parameter)
                    owner_node, _ = find_node(bundle, owner[0])
                    if isinstance(owner_node.get("params", {}).get(owner[1]), dict):
                        raise Incomplete("bound_parameter")
                    saved_spans = parameter_spans(
                        statement["source_location"]["values"][parameter],
                        ", ".join(raw) if expression_list else raw,
                        spans_,
                    )
                    pending_params.append((owner, raw, saved_spans))
                code_spans[key].update(grouped.get(None, set()))
                for owner, raw, spans_ in pending_params:
                    params[owner].update(spans_)
                    param_values[owner] = raw
                    _, container = find_node(bundle, owner[0])
                    result["edit"].append(
                        {
                            "node": key,
                            "port": statement["output"],
                            "kind": "parameter",
                            "label": owner[1],
                            "file": f"components/{container}.json" if container else "flow.json",
                            "excerpt": f"{owner[1]}: {', '.join(raw) if isinstance(raw, list) else raw}",
                            "instances": shared,
                        }
                    )
                    touched.add(key)
                if grouped.get(None) or insertion:
                    result["edit"].append(
                        {
                            "node": key,
                            "port": statement["output"],
                            "kind": "sql",
                            "label": label,
                            "file": path,
                            "excerpt": statement["source_location"]["sql"],
                            "instances": shared,
                            "parameters": [p for p in grouped if p],
                        }
                    )
                    touched.add(key)
                if (
                    not statement["output"]
                    and not statement.get("test_name")
                    and not statement.get("message_block")
                ) and (export_inputs(text, schema) & affected_refs):
                    resource = {
                        p["name"]: item.get("params", {}).get(p["name"], p.get("default"))
                        for p in item["parsed"]["parameters"]
                        if p["type"].split("(")[0] in {"destination", "table_name", "schema_name"}
                    }
                    result["exports"].append({"node": key, "resource": resource})
                    touched.add(key)
            except (Incomplete, sqlglot.errors.SqlglotError, KeyError, IndexError):
                review(key, "incomplete", label=label)

    for id_, step in steps.items():
        if id_ not in tainted or id_ == root:
            continue
        if id_ in automatic:
            result["follows"].append({k: step[k] for k in ("node", "port", "column", "expression")})
        elif step["column"] not in renamed[(step["node"], step["port"])]:
            result["derived"].append({k: step[k] for k in ("node", "port", "column", "expression")})
        touched.add(step["node"])
    # Outputs exposed through component boundaries share their inner schema.
    all_renamed = dict(renamed)
    for key, boundary in boundaries.items():
        for p, inner in boundary["outputs"].items():
            if tuple(inner) in renamed:
                all_renamed[(key, p)] = renamed[tuple(inner)]
    replacement = new_name or "__impact_column__"
    changes = {
        key: replace_spans(nodes[key]["template_sql"], spans, replacement)
        for key, spans in code_spans.items()
        if spans
    }
    for key, additions in insertions.items():
        # Reapply all edits in original-offset order so an insertion cannot shift a token.
        edits = [
            (
                start,
                end,
                replace_spans(nodes[key]["template_sql"][start:end], [(0, end - start)], replacement),
            )
            for start, end in code_spans[key]
        ]
        edits.extend((position, position, text) for position, text in additions)
        text = nodes[key]["template_sql"]
        for start, end, value in sorted(edits, reverse=True):
            text = text[:start] + value + text[end:]
        changes[key] = text
    values = {
        key: replace_parameter(param_values[key], spans, replacement)
        for key, spans in params.items()
        if spans
    }
    updated = edited_bundle(bundle, changes, values)
    saved_references(updated, all_renamed, replacement, result, review)
    for key, names in all_renamed.items():
        if not names:
            continue
        descriptions = (updated.get("documentation") or {}).get("columns", {}).get(":".join(key), {})
        for name in names:
            if name in descriptions:
                result["mentions"].append(
                    {"node": key[0], "port": key[1], "column": name, "excerpt": descriptions[name]}
                )
                descriptions[replacement] = descriptions.pop(name)
    if new_name is not None and new_name != column:
        for key, output in outputs.items():
            if any(identity(*key, c["name"]) in tainted for c in output["columns"]) and any(
                c["name"].casefold() == new_name.casefold() and c["name"] not in renamed[key]
                for c in output["columns"]
            ):
                raise Problem(f"A column named {new_name} already exists in {key[0]} · {key[1]}", 409)
    result["unaffected"] = [{"node": key} for key in nodes if key in downstream and key not in touched]
    result["complete"] = not result["manual"]
    result["affected_columns"] = len(tainted) - 1
    if new_name is None:
        for entry in result["edit"]:
            entry.pop("after", None)
    if new_name is not None:
        if new_name == column:
            updated = deepcopy(bundle)
        before, after = bundle_to_files(bundle), bundle_to_files(updated)
        result["changes"] = [
            {
                "file": path,
                "before": snapshot["files"].get(path, ""),
                "after": after.get(path, ""),
                "removed": path not in after,
            }
            for path in sorted(before.keys() | after.keys())
            if before.get(path) != after.get(path)
        ]
        result["token"] = digest(
            [snapshot["revision"], environment, node, port, column, new_name, result["changes"]]
        )
    return result, updated


def saved_references(bundle, renamed, replacement, result, review):
    def record(node, file, label, before, after):
        if before != after:
            result["edit"].append(
                {
                    "node": node,
                    "file": file,
                    "kind": "setting",
                    "label": label,
                    "excerpt": before,
                    "after": after,
                }
            )

    def field(owner, key, names, node, file, label):
        value = owner.get(key)
        if isinstance(value, str) and value.casefold() in {name.casefold() for name in names}:
            record(node, file, label, owner[key], replacement)
            owner[key] = replacement

    for (node, port), names in renamed.items():
        if not names:
            continue
        for view in (bundle.get("views") or {}).get(f"{node}:{port}", []):
            before = view.get("filter", "")
            try:
                masked = VARIABLE_REFERENCE.sub(lambda m: "0" + " " * (len(m[0]) - 1), before)
                tree = sqlglot.parse_one(masked, read="duckdb") if before else None
                spans = (
                    [
                        (c.this.meta["start"], c.this.meta["end"] + 1)
                        for c in tree.find_all(exp.Column)
                        if c.name.casefold() in {name.casefold() for name in names}
                    ]
                    if tree
                    else []
                )
                if tree and tree.find(exp.Query):
                    raise Incomplete("view_query")
                after = replace_spans(before, spans, replacement)
                if before != after:
                    view["filter"] = after
                    record(node, "views.json", view["name"], before, after)
            except (sqlglot.errors.SqlglotError, Incomplete):
                review(node, "incomplete", label=view["name"])
            for order in view.get("order", []):
                if order[0].casefold() in {name.casefold() for name in names}:
                    record(node, "views.json", view["name"], order[0], replacement)
                    order[0] = replacement

        def chart_fields(value, label, names=names, node=node):
            if isinstance(value, dict):
                field(value, "field", names, node, "charts.json", label)
                for child in value.values():
                    chart_fields(child, label)
            elif isinstance(value, list):
                for child in value:
                    chart_fields(child, label)

        for chart in (bundle.get("charts") or {}).get(f"{node}:{port}", []):
            chart_fields(chart["spec"], chart["name"])
        for name, variable in (bundle.get("variables") or {}).items():
            source = variable.get("from", {})
            if (source.get("node"), source.get("port", "result")) == (node, port):
                field(source, "column", names, node, "variables.json", name)
        for name, dimension in bundle["flow"].get("partitions", {}).items():
            source = dimension.get("values", {})
            if (source.get("node"), source.get("port", "result")) == (node, port):
                field(source, "column", names, node, "flow.json", name)
        for root in bundle["flow"].get("nodes", []):
            if root["id"] == node:
                declaration = root.get("outputs", {}).get(port, {}).get("partition", {})
                field(declaration, "column", names, node, "flow.json", port)


def rename(engine, worktree, environment, node, port, column, new_name, revision, token):
    projects = engine.projects
    with projects.locked(worktree):
        snapshot = projects.snapshot(worktree)
        if snapshot["revision"] != revision:
            raise Problem("The project changed. Preview the rename again.", 409)
        plan, _ = inspect(
            engine, worktree, environment, node, port, column, new_name=new_name, snapshot=snapshot
        )
        if plan["token"] != token:
            raise Problem("Column schemas changed. Preview the rename again.", 409)
        proposal = dict(snapshot["files"])
        for change in plan["changes"]:
            if change["removed"]:
                proposal.pop(change["file"], None)
            else:
                proposal[change["file"]] = change["after"]
        return projects.write(worktree, revision, proposal, relock=False)
