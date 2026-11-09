"""The project file registry: paths, bundle sections, merges and comparison entities."""

import re
from dataclasses import dataclass
from pathlib import Path

from .json_document import Document
from .node_code import template_path

VARIABLES = Document("variables.json", "a JSON object of variables")
EXTENSIONS = Document("extensions.json", "an object keyed by extension name")
VIEWS = Document("views.json", "an object of views by node output")


@dataclass(frozen=True)
class FileType:
    path: str
    section: str
    entity: str
    merge: str = "text"
    pattern: str | None = None
    document: Document | None = None
    # A `named` file merges entry by entry, either field by field or each entry as one unit.
    whole_entries: bool = False

    def matches(self, path):
        return re.fullmatch(self.pattern, path) is not None if self.pattern else path == self.path

    def key(self, path):
        if self.section == "templates":
            return Path(path).name if path.endswith(".py") else Path(path).stem
        if self.section == "components":
            return Path(path).stem
        if self.section == "python_helpers":
            return path.removeprefix("modules/")
        return path

    def filename(self, key=None):
        if self.section == "templates":
            return template_path(key)
        if self.section == "components":
            return f"components/{key}.json"
        if self.section == "python_helpers":
            return f"modules/{key}"
        return key if self.pattern else self.path


FILES = (
    FileType("flow.json", "flow", "graph", "json"),
    FileType("documentation.json", "documentation", "documentation", "json"),
    FileType("README.md", "readme", "documentation"),
    FileType("pyproject.toml", "pyproject", "file"),
    FileType("uv.lock", "python_lock", "file", "generated"),
    FileType(VARIABLES.file, "variables", "variable", "declarations", document=VARIABLES),
    FileType(EXTENSIONS.file, "extensions", "file", "declarations", document=EXTENSIONS),
    FileType(VIEWS.file, "views", "view", "named", document=VIEWS),
    FileType("templates/*", "templates", "template", pattern=r"templates/[A-Za-z0-9_-]+\.(?:sql|py)"),
    FileType("nodes/*", "node_sql", "node", pattern=r"nodes/[A-Za-z0-9_-]+\.(?:sql|py)"),
    FileType("components/*.json", "components", "graph", "json", r"components/[A-Za-z0-9_-]+\.json"),
    FileType(
        "components/*/*", "node_sql", "node", pattern=r"components/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.(?:sql|py)"
    ),
    FileType(
        "modules/**/*.py", "python_helpers", "file", pattern=r"modules/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+\.py"
    ),
)
ROOT_FILES = tuple(spec.path for spec in FILES if not spec.pattern)
# Per-output named documents, such as views.json.
NAMED = tuple(spec for spec in FILES if spec.merge == "named")


def matching(path):
    return next((spec for spec in FILES if spec.matches(path)), None)


def is_declarative(path):
    return matching(path) is not None


def definition_names(path):
    return [
        *ROOT_FILES,
        *(
            p.relative_to(path).as_posix()
            for spec in FILES
            if spec.pattern
            for p in sorted(path.glob(spec.path))
            if spec.matches(p.relative_to(path).as_posix())
        ),
    ]


def entries(bundle):
    """Present values with their file descriptor and exact path, in registry order."""
    for spec in FILES:
        if spec.pattern:
            for key, value in sorted(bundle.get(spec.section, {}).items()):
                path = spec.filename(key)
                if spec.matches(path):
                    yield spec, path, key, value
        elif spec.section == "readme":
            yield spec, spec.path, None, bundle.get("documentation", {}).get("project") or ""
        elif bundle.get(spec.section) is not None:
            yield spec, spec.path, None, bundle[spec.section]
