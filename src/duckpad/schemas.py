"""Request bodies of the HTTP API."""

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from .auth import USERNAME


class Login(BaseModel):
    username: str = USERNAME
    password: str


class Identity(BaseModel):
    name: str = Field(min_length=1)
    email: str = Field(min_length=1)


class NewProject(BaseModel):
    name: str = "Untitled project"


class Save(BaseModel):
    """A UI save: raw files, or a bundle serialized to files, based on an editing revision."""

    revision: str
    files: dict[str, str] | None = None
    bundle: dict[str, Any] | None = None

    @model_validator(mode="after")
    def has_content(self):
        if self.files is None and self.bundle is None:
            raise ValueError("Provide files or a bundle")
        return self


class Resolution(BaseModel):
    choice: Literal["current", "proposal", "combined"]
    files: dict[str, str] | None = None


class NewBranch(BaseModel):
    name: str
    revision: str | None = None


class Merge(BaseModel):
    source_revision: str
    target_revision: str
    files: dict[str, str]


class Group(BaseModel):
    revision: str
    nodes: list[str]
    name: str
    parameters: dict[str, Any] | None = None
    parent: str | None = None


class Import(BaseModel):
    revision: str
    source_worktree: str
    kind: Literal["templates", "components"]
    id: str


class Launch(BaseModel):
    environment: str = "dev"
    node: str | None = None
    entry_point: str | None = None


class Explain(BaseModel):
    environment: str = "dev"
    dataset: str
    row: int
    column: str
    offset: int = Field(default=0, ge=0)
    group: str | None = None
    context: bool = False
