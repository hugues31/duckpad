"""Read and serialize the project file registry without changing authored text."""

import re
import sys
from contextlib import suppress

import duckdb

from . import project_files
from .json_read import loads
from .node_names import Name, node_names
from .project_schema import require_structure
from .python_environment import manifest_settings
from .types import Files, Record
from .util import Problem, dumps


def files_to_bundle(files, *, check_structure=True):
    result: Record = {"templates": {}, "node_sql": {}, "components": {}, "python_helpers": {}}
    for spec in project_files.FILES:
        if not spec.pattern:
            result.setdefault(spec.section, None)
    errors = []
    for name, text in files.items():
        spec = project_files.matching(name)
        if spec is None:
            continue
        try:
            value = (
                spec.document.read(text) if spec.document else loads(text) if spec.merge == "json" else text
            )
        except ValueError as error:
            errors.append({"file": name, "message": f"Invalid JSON: {error}"})
            continue
        if spec.pattern:
            result[spec.section][spec.key(name)] = value
        else:
            result[spec.section] = value
    if errors:
        raise Problem("Cannot read declarative project files", 422, errors)
    documentation = result["documentation"]
    if isinstance(documentation, dict) and "project" in documentation:
        raise Problem(
            'Move project documentation from documentation.json to README.md and remove the "project" key.',
            422,
        )
    if check_structure:
        require_structure(result)
    readme = result.pop("readme")
    if readme and isinstance(documentation, dict):
        documentation["project"] = readme
    return result


def default_pyproject(name):
    """A dependency-only project, suitable for uv sync without packaging the flow."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "untitled"
    return (
        f'[project]\nname = "duckpad-project-{slug}"\n'
        f'version = "0.1.0"\nreadme = "README.md"\nrequires-python = "=={sys.version_info.major}.{sys.version_info.minor}.*"\n'
        f'dependencies = ["duckdb=={duckdb.__version__}", "pytz>=2024.1"]\n'
        "\n[tool.uv]\npackage = false\n" + manifest_settings()
    )


def bundle_to_files(bundle):
    bundle = {"documentation": {}, "templates": {}, "components": {}, **bundle}
    require_structure(bundle)
    result = {}
    for spec, path, _, value in project_files.entries(bundle):
        if spec.section == "documentation":
            value = {k: v for k, v in value.items() if k != "project"}
        if spec.document:
            value = spec.document.write(value)
        elif spec.merge == "json":
            value = dumps(value)
        if not isinstance(value, str):
            raise Problem(f"{path} must contain text", 422)
        result[path] = value
    if "pyproject.toml" not in result:
        name = bundle["flow"].get("name")
        result["pyproject.toml"] = default_pyproject(name if isinstance(name, str) else "Untitled project")
    return result


def file_node_names(*versions: Files) -> dict[str, Name]:
    """Prefer the current version, retaining names of nodes removed in other versions."""
    names = {}
    for files in versions:
        with suppress(Problem):
            names.update(node_names(files_to_bundle(files)))
    return names
