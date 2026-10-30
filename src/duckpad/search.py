"""Permission-scoped discovery of projects, open branches and placed nodes."""

from .bundle import files_to_bundle
from .templates import parse_templates
from .util import Problem


def node_entries(bundle):
    """Walk component instances independently, tolerating invalid or cyclic graphs."""
    templates = parse_templates(bundle.get("templates", {}))
    components = bundle.get("components", {})
    if not isinstance(components, dict):
        return
    pending = [(bundle.get("flow"), [], [], frozenset())]
    while pending:
        graph, path, labels, ancestors = pending.pop()
        if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
            continue
        for node in graph["nodes"]:
            if not isinstance(node, dict) or not isinstance(node.get("id"), str):
                continue
            component, template = node.get("component"), node.get("template")
            definition = components.get(component, {}) if isinstance(component, str) else {}
            definition = definition if isinstance(definition, dict) else {}
            parsed = templates.get(template, {}) if isinstance(template, str) else {}
            label = node.get("label") or definition.get("name") or parsed.get("label") or node["id"]
            label = label if isinstance(label, str) else node["id"]
            yield {
                "kind": "node",
                "label": label,
                "node": node["id"],
                "path": path,
                "breadcrumbs": labels,
                "definition": component
                if isinstance(component, str)
                else template
                if isinstance(template, str)
                else "",
                "definition_label": definition.get("name") or parsed.get("label") or "",
            }
            if definition and component not in ancestors:
                pending.append((definition, [*path, node["id"]], [*labels, label], ancestors | {component}))


def search_instance(projects, user, query, limit):
    terms = query.casefold().split()
    response = {"results": [], "has_more": False, "incomplete": False}
    if not terms:
        return response

    # Apply the same project visibility as /workspace before touching any files.
    visible = {p["id"]: p for p in projects.store.visible_projects(user)}

    def add(entry):
        text = " ".join(
            str(entry.get(key, ""))
            for key in (
                "label",
                "node",
                "definition",
                "definition_label",
                "project",
                "worktree",
                "project_name",
                "branch",
                "breadcrumbs",
            )
        ).casefold()
        if not all(term in text for term in terms):
            return False
        if len(response["results"]) == limit:
            response["has_more"] = True
            return True
        response["results"].append(entry)
        return False

    worktrees = sorted(
        (w for w in projects.store.all("worktree") if w["project"] in visible),
        key=lambda w: (
            visible[w["project"]]["name"].casefold(),
            w["project"],
            w["branch"] != "main",
            w["branch"],
        ),
    )
    for worktree in worktrees:
        project = visible[worktree["project"]]
        context = {
            "project": project["id"],
            "project_name": project["name"],
            "worktree": worktree["id"],
            "branch": worktree["branch"],
        }
        kind = "project" if worktree["id"] == project["main"] else "branch"
        if add(
            {**context, "kind": kind, "label": project["name"] if kind == "project" else worktree["branch"]}
        ):
            break
        try:
            # Search the same committed content as the canvas, without a lock, saving a
            # revision, running validation or reading execution/connection data.
            commit = projects.git(worktree["path"], "rev-parse", "HEAD")
            bundle = files_to_bundle(projects.revision_files(worktree["path"], commit))
            if any(add({**context, **entry}) for entry in node_entries(bundle)):
                break
        except (Problem, OSError, ValueError, TypeError, AttributeError):
            # An invalid project must not hide results from healthy projects.
            response["incomplete"] = True
    return response
