"""Database guarantees independently of HTTP and service validation."""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import SQLModel

from duckpad.auth import Auth
from duckpad.catalog import Catalog
from duckpad.migrations import configuration, migration_connection
from duckpad.models import LoginSession, ProjectMember, User
from duckpad.projects import Projects
from duckpad.store import Store
from duckpad.util import Problem


@pytest.fixture
def store(tmp_path):
    instance = Store(tmp_path / "instance")
    yield instance
    instance.close()


def test_initial_migration_matches_models_and_survives_restart(store):
    Auth(store)
    catalog = Catalog(store)
    catalog.save_environment(
        {"id": "qa", "label": "QA", "color": "#123456", "confirm_before_run": False}, create=True
    )
    store.put("settings", "arbitrary_config", {"enabled": True, "values": [1, 2]})
    with store.engine.connect() as connection:
        assert (
            connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one()
            == "0001_relational"
        )
        assert "records" not in inspect(connection).get_table_names()
        assert len(SQLModel.metadata.tables) == 20
        assert compare_metadata(MigrationContext.configure(connection), SQLModel.metadata) == []
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
        assert connection.exec_driver_sql("PRAGMA journal_mode").scalar_one() == "wal"
    store.close()
    reopened = Store(store.home)
    try:
        assert Auth(reopened).initial_password is None
        assert Catalog(reopened).environment_names() == ["dev", "prod", "qa"]
        assert reopened.get("settings", "arbitrary_config") == {"enabled": True, "values": [1, 2]}
    finally:
        reopened.close()


def test_unknown_document_schema_is_not_modified(tmp_path):
    path = tmp_path / "instance.sqlite"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE records (kind TEXT, id TEXT, value TEXT)")
        connection.execute("INSERT INTO records VALUES ('settings', 'marker', 'kept')")
    with pytest.raises(Problem, match="unsupported document schema"):
        Store(tmp_path)
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT value FROM records").fetchone() == ("kept",)
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [
            ("records",)
        ]


def test_schema_constraints_apply_outside_services(store):
    auth = Auth(store)
    admin = store.get("user", "admin")
    with pytest.raises(IntegrityError), store.transaction() as session:
        session.add(
            User(
                id="duplicate",
                username="ADMIN",
                username_key="admin",
                role="member",
                active=True,
                salt=admin["salt"],
                hash=admin["hash"],
            )
        )
    with pytest.raises(IntegrityError), store.transaction() as session:
        session.add(
            User(
                id="bad-role",
                username="other",
                username_key="other",
                role="owner",
                active=True,
                salt=admin["salt"],
                hash=admin["hash"],
            )
        )
    with pytest.raises(IntegrityError), store.transaction() as session:
        session.add(LoginSession(id="orphan", user="missing", version=0, expires=1))
    user = auth.create_user("member", "test-password-123")
    worktree = Projects(store).create("Ownership")
    with pytest.raises(IntegrityError), store.transaction() as session:
        session.add(ProjectMember(project=worktree["project"], user=user["id"], role="owner"))
    assert store.get("session", "orphan") is None


def test_oidc_identity_is_unique_and_credentials_are_exclusive(store):
    value = {
        "username": "sso-one",
        "role": "member",
        "active": True,
        "oidc": {"issuer": "https://identity.example", "subject": "subject"},
    }
    store.put("user", "sso-one", value)
    with pytest.raises(IntegrityError):
        store.put("user", "sso-two", {**value, "username": "sso-two"})
    with pytest.raises(IntegrityError):
        store.put("user", "sso-one", {**value, "salt": "salt", "hash": "hash"})
    assert store.find_oidc_user("https://identity.example", "subject")["id"] == "sso-one"


def test_project_main_and_run_must_belong_to_the_project(store):
    projects = Projects(store)
    first, second = projects.create("First"), projects.create("Second")
    project = store.get("project", first["project"])
    with pytest.raises(IntegrityError):
        store.put("project", project["id"], {**project, "main": second["id"]})
    with pytest.raises(IntegrityError):
        store.put(
            "run",
            "invalid",
            {
                "project": first["project"],
                "worktree": second["id"],
                "environment": "dev",
                "status": "success",
                "started": "2026-01-01",
            },
        )
    with pytest.raises(IntegrityError):
        store.delete("worktree", first["id"])
    assert store.get("worktree", first["id"]) is not None


def test_project_creation_rolls_back_both_rows_on_failure(store, monkeypatch):
    original = store.put

    def fail_worktree(kind, key, value):
        if kind == "worktree":
            raise RuntimeError("Simulated write failure")
        return original(kind, key, value)

    monkeypatch.setattr(store, "put", fail_worktree)
    with pytest.raises(RuntimeError, match="Simulated write failure"):
        Projects(store).create("Rollback")
    assert store.all("project") == []
    assert store.all("worktree") == []


def test_environment_creation_rolls_back_all_connections(store, monkeypatch):
    catalog = Catalog(store)
    original = store.put

    def fail_connection(kind, key, value):
        if kind == "connection":
            raise RuntimeError("Simulated connection failure")
        return original(kind, key, value)

    monkeypatch.setattr(store, "put", fail_connection)
    with pytest.raises(RuntimeError, match="Simulated connection failure"):
        catalog.save_environment(
            {"id": "qa", "label": "QA", "color": "#123456", "confirm_before_run": False}, create=True
        )
    assert catalog.environment_names() == ["dev", "prod"]
    assert "qa" not in store.get("connection", "local")["environments"]


def test_nested_rollback_and_thread_local_sessions(store):
    def rollback():
        with store.transaction():
            store.put("settings", "discarded", 2)
            raise RuntimeError("rollback")

    with store.transaction():
        store.put("settings", "kept", 1)
        with pytest.raises(RuntimeError, match="rollback"):
            rollback()
    assert store.get("settings", "kept") == 1
    assert store.get("settings", "discarded") is None
    barrier = threading.Barrier(4)

    def increment(_):
        barrier.wait(timeout=5)
        sessions = []
        for _ in range(5):
            with store.transaction() as session:
                sessions.append(session)
                store.put("settings", "counter", store.get("settings", "counter", 0) + 1)
        return sessions

    with ThreadPoolExecutor(max_workers=4) as pool:
        sessions = [session for batch in pool.map(increment, range(4)) for session in batch]
    assert len({id(session) for session in sessions}) == 20
    assert store.get("settings", "counter") == 20


def test_project_delete_cascades_without_deleting_shared_catalog_or_accounts(store):
    auth = Auth(store)
    user = auth.create_user("member", "test-password-123")
    projects = Projects(store)
    worktree = projects.create("Cascade")
    other = projects.create("Keep")
    project = worktree["project"]
    store.put("access", project, {"members": {user["id"]: "admin"}, "connections": ["local"]})
    store.put("revision", worktree["id"] + ":revision", {"flow.json": "{}"})
    store.put("conflict", "conflict", {"worktree": worktree["id"], "base": {}})
    store.put("git_remote", project, {"version": "v1", "url": None, "mappings": {}})
    store.put(
        "git_consent",
        f"{project}/{user['id']}",
        {"url": "https://example.com/repo.git", "confirmed": "2026-01-01"},
    )
    store.put(
        "run",
        "run",
        {
            "project": project,
            "worktree": worktree["id"],
            "environment": "dev",
            "status": "success",
            "started": "2026-01-01",
        },
    )
    projects.delete(project)
    for kind in ("revision", "conflict", "git_remote", "git_consent", "run"):
        assert store.all(kind) == []
    assert store.get("project", other["project"])
    assert store.get("user", user["id"])
    assert store.get("connection", "local")
    with store.engine.connect() as connection:
        assert connection.exec_driver_sql("SELECT count(*) FROM project_member").scalar_one() == 0
        assert connection.exec_driver_sql("SELECT count(*) FROM project_connection").scalar_one() == 0
        assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []


def test_user_update_does_not_delete_sessions_but_deletion_does(store):
    auth = Auth(store)
    token = auth.login("admin", auth.initial_password)
    user = store.get("user", "admin")
    store.put("user", "admin", {**user, "commit_identity": {"name": "Admin", "email": "admin@example.com"}})
    assert auth.check(token)["id"] == "admin"
    store.delete("user", "admin")
    assert store.all("session") == []


def test_batch_migration_preserves_children_and_rolls_back_on_failure(store):
    auth = Auth(store)
    token = auth.login("admin", auth.initial_password)

    def fail_migration():
        with migration_connection(store.engine) as connection:
            ops = Operations(MigrationContext.configure(connection))
            with ops.batch_alter_table("user", recreate="always") as batch:
                batch.alter_column("username", existing_type=User.__table__.c.username.type)
            assert connection.execute(text("SELECT count(*) FROM session")).scalar_one() == 1
            raise RuntimeError("migration failure")

    with pytest.raises(RuntimeError, match="migration failure"):
        fail_migration()
    assert auth.check(token)["id"] == "admin"
    with store.engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
        assert "_alembic_tmp_user" not in inspect(connection).get_table_names()
    with migration_connection(store.engine) as connection:
        command.check(configuration(connection))
