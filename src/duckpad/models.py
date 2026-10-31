"""Relational instance metadata. Public API responses are assembled by services."""

from typing import Any

from sqlalchemy import JSON, CheckConstraint, Column, ForeignKeyConstraint, Index, UniqueConstraint
from sqlmodel import Field, SQLModel


class User(SQLModel, table=True):
    __tablename__ = "user"
    __table_args__ = (
        CheckConstraint("role IN ('admin', 'member')", name="user_role"),
        UniqueConstraint("oidc_issuer", "oidc_subject", name="user_oidc_identity"),
        CheckConstraint(
            "(service = 0 AND ((oidc_issuer IS NULL AND oidc_subject IS NULL AND salt IS NOT NULL AND hash IS NOT NULL) "
            "OR (oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL AND salt IS NULL AND hash IS NULL))) "
            "OR (service = 1 AND role = 'member' AND oidc_issuer IS NULL AND oidc_subject IS NULL AND salt IS NULL AND hash IS NULL)",
            name="user_credentials",
        ),
    )
    id: str = Field(primary_key=True)
    username: str
    username_key: str = Field(unique=True)
    role: str
    active: bool
    service: bool = False
    description: str = ""
    salt: str | None = None
    hash: str | None = None
    oidc_issuer: str | None = None
    oidc_subject: str | None = None
    session_version: int = 0
    commit_identity: dict | None = Field(default=None, sa_type=JSON)


class LoginSession(SQLModel, table=True):
    __tablename__ = "session"
    id: str = Field(primary_key=True)
    user: str = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    expires: float = Field(index=True)
    version: int
    credential: str | None = None
    oidc_revision: str | None = None


class APIToken(SQLModel, table=True):
    __tablename__ = "api_token"
    id: str = Field(primary_key=True)
    user: str = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    hash: str = Field(unique=True)
    name: str
    created: float
    expires: float | None = None
    last_used: float | None = None


class Project(SQLModel, table=True):
    __tablename__ = "project"
    __table_args__ = (
        ForeignKeyConstraint(
            ["main", "id"],
            ["worktree.id", "worktree.project"],
            name="project_main_worktree",
            use_alter=True,
            deferrable=True,
            initially="DEFERRED",
        ),
    )
    id: str = Field(primary_key=True)
    name: str
    main: str
    created: str


class Worktree(SQLModel, table=True):
    __tablename__ = "worktree"
    __table_args__ = (
        UniqueConstraint("id", "project", name="worktree_project_identity"),
        UniqueConstraint("project", "branch", name="worktree_project_branch"),
    )
    id: str = Field(primary_key=True)
    project: str = Field(foreign_key="project.id", ondelete="CASCADE", index=True)
    branch: str
    path: str = Field(unique=True)
    read_only: bool = False


class Job(SQLModel, table=True):
    __tablename__ = "job"
    __table_args__ = (
        ForeignKeyConstraint(
            ["worktree", "project"],
            ["worktree.id", "worktree.project"],
            ondelete="CASCADE",
            name="job_worktree_project",
        ),
    )
    # The immutable instance-wide slug is the primary key.
    id: str = Field(primary_key=True)
    project: str = Field(index=True)
    worktree: str = Field(unique=True)
    name: str
    description: str
    environment: str
    scope: str | None = None
    target: dict = Field(sa_type=JSON)
    runtime_variables: list = Field(default_factory=list, sa_type=JSON)
    versions: list = Field(default_factory=list, sa_type=JSON)
    revision: str


class ProjectMember(SQLModel, table=True):
    __tablename__ = "project_member"
    __table_args__ = (
        CheckConstraint("role IN ('reader', 'operator', 'editor', 'admin')", name="project_member_role"),
    )
    project: str = Field(primary_key=True, foreign_key="project.id", ondelete="CASCADE")
    user: str = Field(primary_key=True, foreign_key="user.id", ondelete="CASCADE", index=True)
    role: str


class JobIdempotency(SQLModel, table=True):
    __tablename__ = "job_idempotency"
    job: str = Field(primary_key=True, foreign_key="job.id", ondelete="CASCADE")
    key: str = Field(primary_key=True)
    request_hash: str
    run: str = Field(foreign_key="run.id", ondelete="CASCADE")
    expires: float = Field(index=True)


class Connector(SQLModel, table=True):
    __tablename__ = "connector"
    id: str = Field(primary_key=True)
    name: str | None = None
    definition: dict = Field(sa_type=JSON)


class Connection(SQLModel, table=True):
    __tablename__ = "connection"
    id: str = Field(primary_key=True)
    name: str
    connector: str = Field(foreign_key="connector.id", ondelete="RESTRICT", index=True)
    secret_fields: list[str] = Field(sa_type=JSON)


class Environment(SQLModel, table=True):
    __tablename__ = "environment"
    id: str = Field(primary_key=True)
    label: str
    color: str
    confirm_before_run: bool


class ConnectionEnvironment(SQLModel, table=True):
    __tablename__ = "connection_environment"
    connection: str = Field(primary_key=True, foreign_key="connection.id", ondelete="CASCADE")
    environment: str = Field(primary_key=True, foreign_key="environment.id", ondelete="CASCADE", index=True)
    parameters: dict = Field(sa_type=JSON)


class ProjectConnection(SQLModel, table=True):
    __tablename__ = "project_connection"
    project: str = Field(primary_key=True, foreign_key="project.id", ondelete="CASCADE")
    connection: str = Field(primary_key=True, foreign_key="connection.id", ondelete="CASCADE", index=True)


class Revision(SQLModel, table=True):
    __tablename__ = "revision"
    worktree: str = Field(primary_key=True, foreign_key="worktree.id", ondelete="CASCADE")
    revision: str = Field(primary_key=True)
    files: dict[str, str] = Field(sa_type=JSON)


class Conflict(SQLModel, table=True):
    __tablename__ = "conflict"
    id: str = Field(primary_key=True)
    worktree: str = Field(foreign_key="worktree.id", ondelete="CASCADE", index=True)
    snapshot: dict = Field(sa_type=JSON)


class Run(SQLModel, table=True):
    __tablename__ = "run"
    __table_args__ = (
        ForeignKeyConstraint(
            ["worktree", "project"],
            ["worktree.id", "worktree.project"],
            ondelete="CASCADE",
            name="run_worktree_project",
        ),
        Index("run_project_started", "project", "started"),
        Index("run_worktree_started", "worktree", "started"),
    )
    id: str = Field(primary_key=True)
    project: str
    worktree: str
    # Historical environment names survive environment deletion.
    environment: str = Field(index=True)
    status: str = Field(index=True)
    started: str
    finished: str | None = None
    duration: float | None = None
    snapshot: dict = Field(sa_type=JSON)


class Artifact(SQLModel, table=True):
    __tablename__ = "artifact"
    __table_args__ = (CheckConstraint("size >= 0", name="artifact_size"),)
    id: str = Field(primary_key=True)
    run: str = Field(foreign_key="run.id", ondelete="CASCADE", index=True)
    project: str = Field(foreign_key="project.id", ondelete="CASCADE", index=True)
    worktree: str = Field(foreign_key="worktree.id", ondelete="CASCADE", index=True)
    environment: str
    node: str
    filename: str
    media_type: str
    size: int
    signature: list = Field(sa_type=JSON)


class ExportResult(SQLModel, table=True):
    __tablename__ = "export_result"
    __table_args__ = (UniqueConstraint("worktree", "environment", "node", name="export_result_node"),)
    id: str = Field(primary_key=True)
    worktree: str = Field(foreign_key="worktree.id", ondelete="CASCADE", index=True)
    environment: str
    node: str
    run: str = Field(foreign_key="run.id", ondelete="CASCADE", index=True)
    artifact: str | None = Field(default=None, foreign_key="artifact.id", ondelete="SET NULL", index=True)
    status: str | None = None
    run_status: str
    fingerprint: str | None = None
    commit: str
    started: str


class Setting(SQLModel, table=True):
    __tablename__ = "setting"
    id: str = Field(primary_key=True)
    value: Any = Field(sa_column=Column(JSON, nullable=False))


class AssistantConversation(SQLModel, table=True):
    __tablename__ = "assistant_conversation"
    __table_args__ = (Index("assistant_owner_updated", "user", "updated"),)
    id: str = Field(primary_key=True)
    user: str = Field(foreign_key="user.id", ondelete="CASCADE")
    project: str | None = Field(default=None, foreign_key="project.id", ondelete="CASCADE")
    branch: str
    worktree: str
    title: str
    updated: str
    allow_data: bool
    messages: list = Field(sa_type=JSON)
    turns: list = Field(sa_type=JSON)


class SSHKey(SQLModel, table=True):
    __tablename__ = "ssh_key"
    user: str = Field(primary_key=True, foreign_key="user.id", ondelete="CASCADE")
    id: str = Field(unique=True)
    private_key: str
    public_key: str
    fingerprint: str
    created: str


class GitConsent(SQLModel, table=True):
    __tablename__ = "git_consent"
    project: str = Field(primary_key=True, foreign_key="project.id", ondelete="CASCADE")
    user: str = Field(primary_key=True, foreign_key="user.id", ondelete="CASCADE", index=True)
    url: str
    confirmed: str


class GitRemote(SQLModel, table=True):
    __tablename__ = "git_remote"
    project: str = Field(primary_key=True, foreign_key="project.id", ondelete="CASCADE")
    url: str | None = None
    version: str
    mappings: dict = Field(sa_type=JSON)
    checked: str | None = None
    seen: list = Field(default_factory=list, sa_type=JSON)


class OIDCTransaction(SQLModel, table=True):
    __tablename__ = "oidc_transaction"
    id: str = Field(primary_key=True)
    browser: str
    nonce: str
    verifier: str
    revision: str
    # SQLAlchemy reserves the attribute name metadata.
    provider: dict = Field(sa_type=JSON)
    expires: float = Field(index=True)
