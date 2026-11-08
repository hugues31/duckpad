"""The editor's project snapshot with permissions and computed presentation data."""

from . import variables
from .node_code import code_path
from .python_nodes import retained_contract
from .python_policy import get_policy
from .services import Services
from .templates import parse_templates
from .types import Record


def project_view(services: Services, user: Record, worktree: str) -> Record:
    store, projects, catalog, engine = services.store, services.projects, services.catalog, services.engine
    access = engine.access
    assert access is not None
    result = projects.snapshot(worktree, committed=True)
    project = result["worktree"]["project"]
    result["role"] = access.role(user, project)
    result["python_enabled"] = get_policy(store, project)["enabled"]
    granted_connections = access.record(project)["connections"]
    result["connections"] = []
    for c in store.all("connection"):
        if c["id"] in granted_connections:
            definition = catalog.connector(c["connector"]) or {}
            result["connections"].append(
                {
                    "id": c["id"],
                    "name": c["name"],
                    "family": definition.get("family"),
                    "capabilities": definition.get("capabilities", []),
                }
            )
    result["parsed_templates"] = parse_templates((result["bundle"] or {}).get("templates", {}))
    result["parsed_nodes"] = parse_templates((result["bundle"] or {}).get("node_sql", {}))

    for parent, graph in [
        (None, (result["bundle"] or {}).get("flow", {})),
        *((result["bundle"] or {}).get("components", {})).items(),
    ]:
        for node in graph.get("nodes", []):
            if node.get("language") == "python" and node.get("python_contract"):
                path = node.get("template") or code_path(node["id"], parent, "python")
                collection = result["parsed_templates"] if node.get("template") else result["parsed_nodes"]
                parsed = collection.get(path, {})

                retained = retained_contract(node, parsed, graph.get("edges", []))
                result["parsed_nodes"][code_path(node["id"], parent, "python")] = retained
                if retained.get("error"):
                    file = "templates/" + path if node.get("template") else path
                    located = {"node": node["id"], "code": "python_contract"}
                    message = retained["error"]
                    # A syntax error is already reported for its file: locate it on the node.
                    same = next(
                        (
                            d
                            for d in result["diagnostics"]
                            if d.get("file") == file and d.get("message") == message and "node" not in d
                        ),
                        None,
                    )
                    if same:
                        same.update(located)
                    else:
                        result["diagnostics"].append({"file": file, "message": message, **located})
    result["variables"] = (
        variables.summary(
            result["bundle"],
            catalog.environment_names(),
            {
                environment: engine.pool.computed(worktree, environment, result["bundle"])
                for environment in catalog.environment_names()
            },
        )
        if result["bundle"]
        else None
    )
    result["partitions"] = {
        environment: engine.partitions.describe(worktree, environment)
        for environment in catalog.environment_names()
    }
    return result
