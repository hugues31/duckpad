"""Request bodies of the HTTP API."""

from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator


class Login(BaseModel):
    username: str = "admin"
    password: str


class NewUser(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str
    password: str | None = None
    role: Literal["admin", "member"] = "member"
    service: StrictBool = False
    description: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def require_local_password(self):
        if not self.service and self.password is None:
            raise ValueError("A password is required for local accounts")
        return self


class NewAPIToken(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=128)
    expires: AwareDatetime | None = None


class UserChanges(BaseModel):
    """Only the fields that are present change; null leaves a field unchanged."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["admin", "member"] | None = None
    active: StrictBool | None = None
    password: str | None = None


class PasswordChange(BaseModel):
    current: str
    password: str


class ProjectRole(BaseModel):
    role: Literal["reader", "operator", "editor", "admin"]


class JobTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["tag", "branch"]
    ref: str = Field(min_length=1, max_length=240)


class JobFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    environment: str
    scope: str | None = None


class NewJob(JobFields):
    slug: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=80)
    target: JobTarget
    runtime_variables: list[str] = Field(default_factory=list, max_length=0)


class JobChanges(JobFields):
    revision: str


class JobPromotion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: JobTarget
    revision: str
    previous_commit: str
    commit: str


class JobLaunch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entry_point: Literal["ui", "api"] = "api"
    confirmed: StrictBool = False
    revision: str | None = None


class ConnectionGrants(BaseModel):
    connections: list[str]


class ExtensionSettings(BaseModel):
    allow_unsigned_extensions: StrictBool


class ProjectExtension(BaseModel):
    name: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    source: Literal["core", "community", "unsigned"]


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


class NewTag(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    commit: str = Field(pattern=r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
    message: str = Field(min_length=1, max_length=10000)


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


class GitConsent(BaseModel):
    url: str = Field(max_length=2048)


class GitHosts(BaseModel):
    known_hosts: str = Field(max_length=256 * 1024)
    prefixes: list[str] = Field(default_factory=list, max_length=100)


class BranchCleanup(BaseModel):
    remove_worktree: str
    integrated_worktree: str
    expected_head: str


class Group(BaseModel):
    revision: str
    nodes: list[str]
    name: str
    parameters: dict[str, Any] | None = None
    parent: str | None = None


class VariableRename(BaseModel):
    revision: str
    name: str = Field(max_length=200)


class Import(BaseModel):
    revision: str
    source_worktree: str
    kind: Literal["templates", "components"]
    id: str


class Launch(BaseModel):
    environment: str
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
    environment: str
    dataset: str
    row: int
    column: str
    offset: int = Field(default=0, ge=0)
    group: str | None = None
    context: bool = False
