"""SQLModel persistence with short, thread-local units of work.

Services exchange dictionaries; only explicit models define storage. Unknown
entity kinds cannot be persisted, and there is no generic document table.
"""

import threading
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import URL, delete, event, func, literal_column
from sqlmodel import Session, create_engine, select

from . import models as m
from .migrations import upgrade
from .paths import InstancePaths
from .util import dumps

MODELS = {
    "user": m.User,
    "session": m.LoginSession,
    "project": m.Project,
    "worktree": m.Worktree,
    "connector": m.Connector,
    "connection": m.Connection,
    "environment": m.Environment,
    "revision": m.Revision,
    "conflict": m.Conflict,
    "run": m.Run,
    "artifact": m.Artifact,
    "export_result": m.ExportResult,
    "settings": m.Setting,
    "ssh_key": m.SSHKey,
    "git_consent": m.GitConsent,
    "git_remote": m.GitRemote,
    "oidc_transaction": m.OIDCTransaction,
}
SNAPSHOTS = {"connector": "definition", "conflict": "snapshot", "run": "snapshot"}


def reject_unknown_fields(kind, data, fields):
    unknown = data.keys() - fields
    if unknown:
        raise ValueError(f"Unknown {kind} fields: {', '.join(sorted(unknown))}")


def configure_connection(connection, _record):
    # Explicit BEGIN makes DDL and SAVEPOINT rollback transactional on Python
    # 3.11 too, where sqlite3's default transaction mode does not.
    connection.isolation_level = None
    cursor = connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()


def metadata_engine(path):
    engine = create_engine(
        URL.create("sqlite", database=str(path)),
        connect_args={"check_same_thread": False, "timeout": 30},
        json_serializer=dumps,
        hide_parameters=True,
    )
    event.listen(engine, "connect", configure_connection)
    event.listen(engine, "begin", lambda connection: connection.exec_driver_sql("BEGIN"))
    return engine


class Store:
    def __init__(self, home: Path):
        self.home = home.resolve()
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.paths = InstancePaths(self.home)
        self.lock = threading.RLock()
        self._local = threading.local()
        path = self.home / "instance.sqlite"
        path.touch(mode=0o600, exist_ok=True)
        path.chmod(0o600)
        self.engine = metadata_engine(path)
        try:
            upgrade(self.engine)
        except BaseException:
            self.engine.dispose()
            raise

    @contextmanager
    def transaction(self):
        """Commit a metadata operation together; nested operations use savepoints."""
        with self.lock:
            current = getattr(self._local, "session", None)
            if current is not None:
                with current.begin_nested():
                    yield current
                return
            with Session(self.engine, expire_on_commit=False) as session, session.begin():
                self._local.session = session
                try:
                    yield session
                finally:
                    self._local.session = None

    @contextmanager
    def session(self):
        """Reuse only the calling thread's unit of work, never an HTTP/worker session."""
        current = getattr(self._local, "session", None)
        if current is not None:
            yield current
        else:
            with self.transaction() as session:
                yield session

    @staticmethod
    def _key(kind, key):
        if kind == "revision":
            return tuple(key.split(":", 1))
        if kind == "git_consent":
            return tuple(key.split("/", 1))
        return key

    def _record(self, kind, row, session):
        data = row.model_dump()
        if kind in SNAPSHOTS:
            data = {**data.pop(SNAPSHOTS[kind]), **data}
        if kind == "connector" and data["name"] is None:
            data.pop("name")
        if kind == "user":
            data.pop("username_key")
            issuer, subject = data.pop("oidc_issuer"), data.pop("oidc_subject")
            if issuer is not None:
                data["oidc"] = {"issuer": issuer, "subject": subject}
            data = {key: value for key, value in data.items() if value is not None}
        elif kind == "connection":
            rows = session.exec(
                select(m.ConnectionEnvironment).where(m.ConnectionEnvironment.connection == row.id)
            )
            data["environments"] = {item.environment: item.parameters for item in rows}
        elif kind == "settings":
            return data["value"]
        elif kind == "revision":
            return data["files"]
        elif kind == "ssh_key":
            data.pop("user")
        elif kind == "git_remote":
            data.pop("project")
        elif kind in ("session", "oidc_transaction", "export_result"):
            data.pop("id")
            if kind == "oidc_transaction":
                data["metadata"] = data.pop("provider")
            elif kind == "session":
                data = {key: value for key, value in data.items() if value is not None}
        return data

    def get(self, kind, key, default=None):
        with self.session() as session:
            if kind == "access":
                if session.get(m.Project, key) is None:
                    return default
                return self._access(key, session)
            row = session.get(MODELS[kind], self._key(kind, key))
            return self._record(kind, row, session) if row is not None else default

    def all(self, kind):
        return [value for _, value in self.items(kind)]

    def items(self, kind):
        """Read entities in stable insertion order, including composite identifiers."""
        with self.session() as session:
            rows = session.exec(select(MODELS[kind]).order_by(literal_column("rowid"))).all()
            result = []
            for row in rows:
                if kind == "revision":
                    key = f"{row.worktree}:{row.revision}"
                elif kind == "git_consent":
                    key = f"{row.project}/{row.user}"
                elif kind == "ssh_key":
                    key = row.user
                elif kind == "git_remote":
                    key = row.project
                else:
                    key = row.id
                result.append((key, self._record(kind, row, session)))
            return result

    @staticmethod
    def _access(project, session):
        members = session.exec(select(m.ProjectMember).where(m.ProjectMember.project == project))
        grants = session.exec(select(m.ProjectConnection).where(m.ProjectConnection.project == project))
        return {"members": {m.user: m.role for m in members}, "connections": [g.connection for g in grants]}

    def put(self, kind, key, value):
        with self.session() as session:
            if kind == "access":
                reject_unknown_fields(kind, value, {"members", "connections"})
                session.exec(delete(m.ProjectMember).where(m.ProjectMember.project == key))
                session.exec(delete(m.ProjectConnection).where(m.ProjectConnection.project == key))
                for user, role in value["members"].items():
                    session.add(m.ProjectMember(project=key, user=user, role=role))
                for connection in dict.fromkeys(value["connections"]):
                    session.add(m.ProjectConnection(project=key, connection=connection))
            else:
                model = MODELS[kind]
                if kind == "settings":
                    data = {"id": key, "value": value}
                elif kind == "revision":
                    worktree, revision = self._key(kind, key)
                    data = {"worktree": worktree, "revision": revision, "files": value}
                elif kind == "ssh_key":
                    data = {**value, "user": key}
                elif kind == "git_remote":
                    data = {**value, "project": key}
                elif kind == "git_consent":
                    project, user = self._key(kind, key)
                    data = {**value, "project": project, "user": user}
                else:
                    data = {**value, "id": key}
                if kind in SNAPSHOTS:
                    field = SNAPSHOTS[kind]
                    data[field] = {k: data.pop(k) for k in list(data) if k not in model.model_fields}
                if kind == "user":
                    data["username_key"] = data["username"].casefold()
                    identity = data.pop("oidc", {})
                    reject_unknown_fields("OIDC identity", identity, {"issuer", "subject"})
                    data.update(oidc_issuer=identity.get("issuer"), oidc_subject=identity.get("subject"))
                if kind == "oidc_transaction":
                    data["provider"] = data.pop("metadata")
                if kind == "connection":
                    environments = data.pop("environments")
                reject_unknown_fields(kind, data, model.model_fields.keys())
                # SQLModel table constructors do not validate by default.
                session.merge(model.model_validate(data))
                session.flush()
                if kind == "connection":
                    session.exec(
                        delete(m.ConnectionEnvironment).where(m.ConnectionEnvironment.connection == key)
                    )
                    for environment, parameters in environments.items():
                        session.add(
                            m.ConnectionEnvironment(
                                connection=key, environment=environment, parameters=parameters
                            )
                        )
            session.flush()
        return value

    def delete(self, kind, key):
        with self.session() as session:
            row = session.get(MODELS[kind], self._key(kind, key))
            if row is not None:
                session.delete(row)
            session.flush()

    def find_user(self, username):
        with self.session() as session:
            row = session.exec(select(m.User).where(m.User.username_key == username.casefold())).first()
            return self._record("user", row, session) if row else None

    def find_oidc_user(self, issuer, subject):
        with self.session() as session:
            row = session.exec(
                select(m.User).where(m.User.oidc_issuer == issuer, m.User.oidc_subject == subject)
            ).first()
            return self._record("user", row, session) if row else None

    def purge_expired(self, kind, now):
        model = {"session": m.LoginSession, "oidc_transaction": m.OIDCTransaction}[kind]
        with self.session() as session:
            session.exec(delete(model).where(model.expires < now))

    def visible_projects(self, user):
        """Projects an account can open, with its project role, in one query and creation order."""
        with self.session() as session:
            if user["role"] == "admin":
                rows = session.exec(select(m.Project).order_by(literal_column("rowid")))
                return [{**self._record("project", row, session), "role": "admin"} for row in rows]
            rows = session.exec(
                select(m.Project, m.ProjectMember.role)
                .join(m.ProjectMember, m.ProjectMember.project == m.Project.id)
                .where(m.ProjectMember.user == user["id"])
                .order_by(literal_column("project.rowid"))
            )
            return [{**self._record("project", row, session), "role": role} for row, role in rows]

    def runs_with_statuses(self, statuses):
        with self.session() as session:
            rows = session.exec(select(m.Run).where(m.Run.status.in_(statuses)))
            return [self._record("run", row, session) for row in rows]

    def worktrees(self, project):
        with self.session() as session:
            rows = session.exec(
                select(m.Worktree).where(m.Worktree.project == project).order_by(literal_column("rowid"))
            )
            return [self._record("worktree", row, session) for row in rows]

    def find_worktree(self, project, branch):
        with self.session() as session:
            row = session.exec(
                select(m.Worktree).where(m.Worktree.project == project, m.Worktree.branch == branch)
            ).first()
            return self._record("worktree", row, session) if row else None

    def conflicts(self, worktree):
        with self.session() as session:
            rows = session.exec(
                select(m.Conflict).where(m.Conflict.worktree == worktree).order_by(literal_column("rowid"))
            )
            return [self._record("conflict", row, session) for row in rows]

    def has_conflicts(self, worktree):
        with self.session() as session:
            return (
                session.exec(select(m.Conflict.id).where(m.Conflict.worktree == worktree).limit(1)).first()
                is not None
            )

    def artifact_ids(self, *, project=None, worktree=None):
        if project is None and worktree is None:
            raise ValueError("Specify a project or worktree for artifact lookup")
        statement = select(m.Artifact.id)
        if project is not None:
            statement = statement.where(m.Artifact.project == project)
        if worktree is not None:
            statement = statement.where(m.Artifact.worktree == worktree)
        with self.session() as session:
            return list(session.exec(statement))

    def delete_git_consents(self, project):
        with self.session() as session:
            session.exec(delete(m.GitConsent).where(m.GitConsent.project == project))

    def count_oidc_transactions(self):
        with self.session() as session:
            return session.exec(select(func.count()).select_from(m.OIDCTransaction)).one()

    def delete_oidc_transactions(self):
        with self.session() as session:
            session.exec(delete(m.OIDCTransaction))

    def runs(self, user, worktree=None):
        with self.session() as session:
            statement = select(m.Run)
            if user["role"] != "admin":
                statement = statement.join(m.ProjectMember, m.ProjectMember.project == m.Run.project).where(
                    m.ProjectMember.user == user["id"]
                )
            if worktree:
                statement = statement.where(m.Run.worktree == worktree)
            rows = session.exec(statement.order_by(m.Run.started.desc(), m.Run.id.desc()))
            return [self._record("run", row, session) for row in rows]

    def close(self):
        self.engine.dispose()
