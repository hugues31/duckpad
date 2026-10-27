"""Request bodies of the HTTP API."""

from typing import Any, Literal

from pydantic import BaseModel, Field, StrictBool, field_validator, model_validator


class Login(BaseModel):
    username: str = "admin"
    password: str


class Identity(BaseModel):
    name: str = Field(min_length=1)
    email: str = Field(min_length=1)


class NewProject(BaseModel):
    name: str = "Untitled project"


class NewExample(BaseModel):
    name: str | None = None

    @field_validator("name")
    @classmethod
    def project_name(cls, value):
        if value is not None:
            value = value.strip()
            if not value:
                raise ValueError("Project name must not be empty")
        return value


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


class GitReview(BaseModel):
    source: str


class GitChoices(BaseModel):
    choices: dict[str, Literal["base", "current", "incoming"]] = Field(default_factory=dict)


class GitApply(GitChoices):
    proposal_revision: str


class RemoteState(BaseModel):
    config_revision: str


class RemoteConfiguration(RemoteState):
    url: str | None = None
    remote_branch: str = "main"


class RemoteHeads(RemoteState):
    local_head: str
    remote_head: str | None = None
    recreate: bool = False


class BranchCleanup(BaseModel):
    remove_worktree: str
    integrated_worktree: str
    expected_head: str


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
    confirmed: StrictBool = False


class EnvironmentSettings(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    confirm_before_run: StrictBool = False

    @field_validator("label")
    @classmethod
    def clean_label(cls, value):
        if not value.strip():
            raise ValueError("Provide an environment label")
        return value.strip()


class NewEnvironment(EnvironmentSettings):
    id: str = Field(pattern=r"^[a-zA-Z][a-zA-Z0-9_-]*$", max_length=64)


class Explain(BaseModel):
    environment: str = "dev"
    dataset: str
    row: int
    column: str
    offset: int = Field(default=0, ge=0)
    group: str | None = None
    context: bool = False
