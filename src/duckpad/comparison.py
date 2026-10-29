"""Pure definition comparisons. No execution, source access, saves or Git mutations."""

import re
from collections import Counter

from .bundle import files_to_bundle
from .components import expand
from .util import Problem

CATEGORIES = ("processing", "documentation", "layout")
EMPTY = {"flow": {}, "templates": {}, "components": {}, "documentation": {}}


def label(value, fallback):
    if isinstance(value, dict):
        return str(value.get("label") or value.get("name") or fallback)
    match = re.search(r"^--\s*@label\s+(.+)$", value or "", re.MULTILINE)
    return match[1].strip() if match else fallback


def entities(bundle):
    result = {}

    def add(key, kind, name, value, file, scope=""):
        result[key] = {"id": key, "kind": kind, "name": name, "value": value, "file": file, "scope": scope}

    def graph(value, file, scope=""):
        kind = "component" if scope else "flow"
        metadata = {k: v for k, v in value.items() if k not in ("nodes", "edges")}
        add(scope or "flow", kind, label(value, scope or "Project"), metadata, file, scope)
        nodes = {n["id"]: n for n in value.get("nodes", [])}
        for key, node in nodes.items():
            definition = (
                bundle["components"].get(node.get("component"), {})
                if node.get("component")
                else bundle["templates"].get(node.get("template"), "")
            )
            name = label(node, label(definition, key))
            add(f"{scope + '/' if scope else ''}node/{key}", "node", name, node, file, scope)
        for edge in value.get("edges", []):
            name = f"{label(nodes.get(edge['source'], {}), edge['source'])} → {label(nodes.get(edge['target'], {}), edge['target'])}"
            add(f"{scope + '/' if scope else ''}edge/{edge['id']}", "edge", name, edge, file, scope)

    graph(bundle["flow"], "flow.json")
    for key, value in sorted(bundle["components"].items()):
        graph(value, f"components/{key}.json", f"component/{key}")
    for key, value in sorted(bundle["templates"].items()):
        add(f"template/{key}", "template", label(value, key), value, f"templates/{key}.sql")

    def instance_name(identity):
        graph = bundle["flow"]
        names = []
        for part in identity.split("::"):
            node = next((n for n in graph.get("nodes", []) if n["id"] == part), {})
            names.append(label(node, part))
            graph = bundle["components"].get(node.get("component"), {})
        return " / ".join(names)

    for section, values in sorted(bundle["documentation"].items()):
        if isinstance(values, dict):
            for key, value in sorted(values.items()):
                if section == "columns" and isinstance(value, dict):
                    node = key.rsplit(":", 1)[0]
                    for column, description in sorted(value.items()):
                        add(
                            f"documentation/{section}/{key}/{column}",
                            "documentation",
                            f"{column} column in {instance_name(node)}",
                            description,
                            "documentation.json",
                        )
                    continue
                add(
                    f"documentation/{section}/{key}",
                    "documentation",
                    instance_name(key) if section == "nodes" else f"{section}: {key}",
                    value,
                    "documentation.json",
                )
        else:
            add(
                f"documentation/{section}",
                "documentation",
                section,
                values,
                "README.md" if section == "project" else "documentation.json",
            )
    if bundle.get("pyproject") is not None:
        add("file/pyproject.toml", "file", "pyproject.toml", bundle["pyproject"], "pyproject.toml")
    return result


def fields(before, after, prefix=""):
    """Field names only; values stay in the inspector, never in commit summaries."""
    if before == after:
        return []
    if isinstance(before, dict) and isinstance(after, dict):
        return [
            p
            for k in sorted(before.keys() | after.keys())
            for p in fields(before.get(k), after.get(k), f"{prefix}/{k}".lstrip("/"))
        ]
    return [prefix or "value"]


def categories(kind, paths, before, after):
    if kind == "documentation":
        return ["documentation"]
    if kind == "template":

        def sql(text):
            return "\n".join(
                line
                for line in (text or "").splitlines()
                if not re.match(r"^\s*--\s*@(label|description)\b", line)
            )

        result = ["processing"] if sql(before) != sql(after) else []

        def descriptions(text):
            return re.findall(r"^\s*--\s*@(?:label|description)\b.*$", text or "", re.MULTILINE)

        if descriptions(before) != descriptions(after) or not result:
            result.append("documentation")
        return result
    return sorted(
        {
            "layout"
            if p.split("/")[0] in ("position", "selected")
            else "documentation"
            if p.split("/")[0] in ("name", "label", "description", "documentation")
            else "processing"
            for p in paths
        }
    )


def potential_impact(before, after):
    """Expanded instance paths and wiring, without inferring runtime schemas or values."""
    views, errors = [], []
    for bundle in (before, after):
        try:
            nodes, edges, boundaries = expand(bundle, tolerant=True)
            errors.extend({"node": key, "message": n["error"]} for key, n in nodes.items() if n.get("error"))
            views.append((nodes, edges, boundaries))
        except (Problem, KeyError, TypeError, ValueError, AttributeError, RecursionError):
            views.append(({}, [], {}))
            errors.append({"message": "Some definitions cannot be expanded; dependency analysis is partial."})
    old, new = views
    affected = set()
    for key in old[0].keys() | new[0].keys():

        def processing(node):
            if node is None:
                return None
            return {
                k: v
                for k, v in node.items()
                if k
                not in (
                    "position",
                    "label",
                    "name",
                    "description",
                    "documentation",
                    "selected",
                    "parsed",
                    "error",
                    "template_sql",
                )
            } | {
                "sql": "\n".join(
                    line
                    for line in node.get("template_sql", "").splitlines()
                    if not re.match(r"^\s*--\s*@(label|description)\b", line)
                )
            }

        if processing(old[0].get(key)) != processing(new[0].get(key)):
            affected.add(key)
    old_edges = {e["id"]: e for e in old[1]}
    new_edges = {e["id"]: e for e in new[1]}
    for key in old_edges.keys() | new_edges.keys():
        if old_edges.get(key) != new_edges.get(key):
            affected.update(e["target"] for e in (old_edges.get(key), new_edges.get(key)) if e)
    direct = set(affected)
    while True:
        downstream = {e["target"] for e in old[1] + new[1] if e["source"] in affected}
        if downstream <= affected:
            break
        affected |= downstream
    return {
        "status": "partial" if affected or errors else "not_applicable",
        "reason": "Static dependencies only. Schemas and output values were not resolved; no sources were read."
        if affected or errors
        else "No processing or wiring changes.",
        "direct": sorted(direct),
        "downstream": sorted(affected - direct),
        "diagnostics": errors,
        "before_wiring": old[1],
        "after_wiring": new[1],
        "before_scopes": old[2],
        "after_scopes": new[2],
    }


def compare_files(before_files, after_files, impact=True):
    diagnostics = []
    bundles = []
    for side, files in (("before", before_files), ("after", after_files)):
        try:
            bundles.append(files_to_bundle(files) if files else EMPTY)
        except (Problem, TypeError, AttributeError) as error:
            bundles.append(EMPTY)
            diagnostics.append({"side": side, "message": str(error)})
    try:
        left, right = (entities(bundle) for bundle in bundles)
    except (KeyError, TypeError, AttributeError):
        left, right = {}, {}
        diagnostics.append({"message": "Malformed definitions: semantic comparison is partial."})
    changes = []
    for key in sorted(left.keys() | right.keys()):
        a, b = left.get(key), right.get(key)
        before, after = a["value"] if a else None, b["value"] if b else None
        paths = fields(before, after)
        status = "added" if not a else "removed" if not b else "modified" if paths else "unchanged"
        record = b or a
        changes.append(
            {
                **{k: v for k, v in record.items() if k != "value"},
                "before": before,
                "after": after,
                "status": status,
                "fields": paths,
                "categories": categories(record["kind"], paths, before, after) if paths else [],
            }
        )
    if diagnostics:
        # Retain malformed/deleted files for inspection instead of inventing node removals.
        changes = [
            {
                "id": f"file/{name}",
                "kind": "file",
                "name": name,
                "file": name,
                "scope": "",
                "before": before_files.get(name),
                "after": after_files.get(name),
                "status": "modified",
                "fields": ["unresolved"],
                "categories": ["processing"],
            }
            for name in sorted(before_files.keys() | after_files.keys())
            if before_files.get(name) != after_files.get(name)
        ]
    result = {
        "entities": changes,
        "counts": dict(Counter(c["status"] for c in changes)),
        "categories": {
            category: sum(category in c["categories"] for c in changes) for category in CATEGORIES
        },
        "diagnostics": diagnostics,
    }
    if impact:
        result["impact"] = potential_impact(*bundles)
        if diagnostics:
            result["impact"].update(status="partial", diagnostics=diagnostics)
    return result


def commit_message(before, after, context=""):
    changes = [
        c for c in compare_files(before, after, impact=False)["entities"] if c["status"] != "unchanged"
    ]
    if not changes:
        return "chore(project): normalize declarative files"
    cats = {category for c in changes for category in c["categories"]}
    kind = "style" if cats == {"layout"} else "docs" if cats <= {"documentation"} else "feat"
    if context == "resolution":
        kind = "chore"

    def safe(value):
        return " ".join(str(value).split())[:64]

    def describe(change):
        action = {"added": "add", "removed": "remove", "modified": "update"}[change["status"]]
        aspects = {p.split("/")[0] for p in change["fields"]}
        name = safe(change["name"])
        if change["status"] == "modified":
            if change["categories"] == ["layout"]:
                return f"reposition {name}"
            if aspects == {"label"} or aspects == {"name"}:
                return f"rename {name}"
            if change["kind"] == "template" and "processing" in change["categories"]:
                return f"update SQL for {name}"
            if aspects == {"params"}:
                return f"update parameters for {name}"
            if change["kind"] == "documentation":
                return f"describe {name}"
        if change["kind"] == "edge":
            return (
                f"{'connect' if action == 'add' else 'disconnect' if action == 'remove' else 'rewire'} {name}"
            )
        return f"{action} {name}"

    scope = "canvas" if kind == "style" else changes[0]["kind"] if len(changes) == 1 else "project"
    if scope == "edge":
        scope = "flow"
    summary = (
        describe(changes[0])
        if len(changes) == 1
        else f"update {len(changes)} elements ({', '.join(f'{n} {k}' for k, n in sorted(Counter(c['kind'] for c in changes).items()))})"
    )
    if kind == "style" and len(changes) > 1:
        summary = f"reposition {len(changes)} elements"
    prefix = "resolve edits: " if context == "resolution" else "import: " if context == "import" else ""
    subject = f"{kind}({scope}): {prefix}{summary}"[:110]
    if context == "external":
        subject = subject[:99] + " [external]"
    body = "\n".join(
        f"- {c['kind']}: {describe(c)} [{', '.join(c['categories'])}] ({', '.join(safe(p) for p in c['fields'][:8])})"
        for c in changes[:20]
    )
    if len(changes) > 20:
        body += f"\n- {len(changes) - 20} more elements"
    return subject + "\n\n" + body
