"""Validate document structure before any graph or reference traversal."""

from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, model_validator

from . import project_files
from .util import Problem

Identity = Annotated[str, Field(min_length=1)]


class Definition(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)


class ParameterTarget(Definition):
    node: Identity
    param: Identity


class PortTarget(Definition):
    node: Identity
    port: Identity


class Parameter(Definition):
    targets: list[ParameterTarget] = Field(default_factory=list)
    type: str | None = None


class Documentation(Definition):
    project: str | None = None
    nodes: dict[str, str] = Field(default_factory=dict)
    datasets: dict[str, str] = Field(default_factory=dict)
    columns: dict[str, dict[str, str]] = Field(default_factory=dict)


class ContractParameter(Definition):
    name: Identity
    type: str


class PythonContract(Definition):
    inputs: list[str]
    outputs: list[str]
    parameters: list[ContractParameter]


class Node(Definition):
    id: Identity
    muted: bool = False
    params: dict[str, Any] = Field(default_factory=dict)
    template: str | None = None
    component: str | None = None
    language: str = "sql"
    python_contract: PythonContract = Field(
        default_factory=lambda: PythonContract(inputs=[], outputs=[], parameters=[])
    )

    @model_validator(mode="after")
    def source(self):
        if self.template and self.component:
            raise ValueError("a node cannot have both a template and a component")
        return self


class Edge(Definition):
    id: Identity
    source: Identity
    target: Identity
    sourceHandle: Identity
    targetHandle: Identity


class Graph(Definition):
    documentation: Documentation = Field(default_factory=Documentation)
    nodes: list[Node] = Field(default_factory=list)
    edges: list[Edge] = Field(default_factory=list)
    parameters: dict[str, Parameter] = Field(default_factory=dict)
    inputs: dict[str, PortTarget] = Field(default_factory=dict)
    outputs: dict[str, PortTarget] = Field(default_factory=dict)

    @model_validator(mode="after")
    def identities(self):
        for name in ("nodes", "edges"):
            values = getattr(self, name)
            if len({v.id for v in values}) != len(values):
                raise ValueError(f"{name} identifiers must be unique")
        return self


GRAPH = TypeAdapter(Graph)
OBJECT = TypeAdapter(dict[str, Any])
DOCUMENTATION = TypeAdapter(Documentation)
TEXTS = TypeAdapter(dict[str, str])
TEXT = TypeAdapter(str)


def check(adapter, value, file):
    try:
        adapter.validate_python(value, strict=True)
    except ValidationError as error:
        return [
            {
                "file": file,
                "code": "project_structure",
                "message": f"{'.'.join(map(str, item['loc'])) or 'document'}: {item['msg']}",
            }
            for item in error.errors(include_input=False, include_url=False)
        ]
    return []


def problems(bundle):
    if not isinstance(bundle, dict):
        return [
            {
                "file": "flow.json",
                "code": "project_structure",
                "message": "A project bundle must be an object",
            }
        ]
    errors = []
    checked = set()
    for spec in project_files.FILES:
        if spec.section in checked or spec.section == "readme" or spec.document:
            continue
        checked.add(spec.section)
        value = bundle.get(spec.section)
        if spec.pattern:
            value = bundle.get(spec.section, {})
            section_errors = check(OBJECT if spec.entity == "graph" else TEXTS, value, spec.path)
            errors.extend(section_errors)
            if section_errors:
                continue
            for key, entry in value.items():
                path = spec.filename(key)
                actual = project_files.matching(path)
                if actual is None or actual.section != spec.section:
                    errors.append(
                        {
                            "file": path,
                            "code": "project_structure",
                            "message": f"Invalid path in {spec.section}",
                        }
                    )
                elif spec.entity == "graph":
                    errors.extend(check(GRAPH, entry, path))
        elif spec.entity == "graph":
            errors.extend(check(GRAPH, value, spec.path))
        elif spec.section == "documentation":
            errors.extend(check(DOCUMENTATION, bundle.get("documentation", {}), spec.path))
        elif value is not None:
            errors.extend(check(TEXT, value, spec.path))
    return errors


def require_structure(bundle):
    if errors := problems(bundle):
        raise Problem(
            "Invalid project structure in " + errors[0]["file"] + ": " + errors[0]["message"], 422, errors
        )
