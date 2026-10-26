"""Versioned, execution-bound contracts for the contribution workspace."""

from typing import Any, Literal

from pydantic import BaseModel, Field

CoverageState = Literal[
    "step_explained",
    "sources_reached",
    "upstream_not_explored",
    "unsupported_operation",
    "no_matching_row",
    "branch_not_selected",
]
DependencyKind = Literal["value", "condition", "existence"]


class Cell(BaseModel):
    dataset: str = Field(min_length=1, max_length=100)
    row: int = Field(ge=0)
    column: str = Field(min_length=1, max_length=1024)
    execution: str = Field(min_length=1, max_length=100)


class StageRequest(BaseModel):
    environment: str = Field(default="dev", max_length=100)
    root: Cell
    cell: Cell
    request_id: str = Field(min_length=1, max_length=100)


class RecordsRequest(StageRequest):
    role: str = Field(min_length=1, max_length=100)
    offset: int = Field(default=0, ge=0, le=10_000_000)
    limit: int = Field(default=25, ge=1, le=100)
    group: str | None = Field(default=None, max_length=10000)


class CancelRequest(BaseModel):
    environment: str = Field(default="dev", max_length=100)
    request_id: str = Field(min_length=1, max_length=100)


class Coverage(BaseModel):
    step: CoverageState
    upstream: CoverageState
    warnings: list[str] = Field(default_factory=list)


class Role(BaseModel):
    id: str
    alias: str
    display_alias: str
    side: str
    kind: DependencyKind
    dataset: str
    execution: str
    node: str
    label: str
    path: list[str]
    port: str
    column: str
    columns: list[dict[str, str]]
    occurrences: int
    participations: int
    coverage: CoverageState


class StageEdge(BaseModel):
    source: str
    target: str
    kind: DependencyKind


class Stage(BaseModel):
    version: Literal[1] = 1
    id: str
    cell: Cell
    worktree: str
    environment: str
    project: str
    node: str
    label: str
    path: list[str]
    port: str
    value: Any
    kind: str
    expression: str
    sql: str
    coverage: Coverage
    roles: list[Role]
    edges: list[StageEdge]
    evidence: dict[str, Any]
    budget: dict[str, int]


class ContributionRecord(BaseModel):
    cell: Cell
    value: Any
    values: list[Any]
    participations: int


class Records(BaseModel):
    role: str
    offset: int
    limit: int
    total: int
    columns: list[dict[str, str]]
    records: list[ContributionRecord] = Field(default_factory=list)
    groups: list[dict[str, Any]] = Field(default_factory=list)
