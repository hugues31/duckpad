"""Database guarantees independently of HTTP and service validation."""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import event, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import SQLModel

from duckpad.auth import Auth
from duckpad.catalog import Catalog
from duckpad.migrations import configuration, migration_connection
from duckpad.models import LoginSession, ProjectMember, User
from duckpad.projects import Projects
from duckpad.store import Store, metadata_engine
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
            connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == "0004_jobs"
        )
        assert "records" not in inspect(connection).get_table_names()
        assert len(SQLModel.metadata.tables) == 23
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
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("CREATE TABLE records (kind TEXT, id TEXT, value TEXT)")
        connection.execute("INSERT INTO records VALUES ('settings', 'marker', 'kept')")
    with pytest.raises(Problem, match="unsupported document schema"):
        Store(tmp_path)
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("SELECT value FROM records").fetchone() == ("kept",)
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [
            ("records",)
        ]


@pytest.mark.parametrize("previous", ["0001_relational", "0002_assistant"])
def test_api_token_migration_preserves_accounts_sessions_and_memberships(tmp_path, previous):
    engine = metadata_engine(tmp_path / "instance.sqlite")
    credentials = Auth.credentials("migration-password")
    with migration_connection(engine) as connection:
        command.upgrade(configuration(connection), previous)
        connection.execute(
            text(
                "INSERT INTO user (id, username, username_key, role, active, salt, hash, session_version) "
                "VALUES ('owner', 'owner', 'owner', 'admin', 1, :salt, :hash, 0)"
            ),
            credentials,
        )
        connection.execute(
            text(
                "INSERT INTO user (id, username, username_key, role, active, oidc_issuer, oidc_subject, session_version) "
                "VALUES ('sso', 'sso', 'sso', 'member', 1, 'https://id.example.invalid', 'subject', 0)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO session (id, user, expires, version, credential) VALUES ('session', 'owner', 9999999999, 0, :hash)"
            ),
            credentials,
        )
        connection.execute(
            text("INSERT INTO project VALUES ('project', 'Existing project', 'main', '2026-01-01')")
        )
        connection.execute(text("INSERT INTO worktree VALUES ('main', 'project', 'main', 'unused')"))
        connection.execute(text("INSERT INTO project_member VALUES ('project', 'owner', 'admin')"))
        connection.execute(text("INSERT INTO project_member VALUES ('project', 'sso', 'reader')"))
        if previous == "0002_assistant":
            connection.execute(
                text(
                    "INSERT INTO assistant_conversation VALUES "
                    "('conversation', 'owner', 'project', 'main', 'main', 'Kept', '2026-01-01', 0, '[]', '[]')"
                )
            )
    engine.dispose()
    store = Store(tmp_path)
    try:
        assert store.get("user", "owner")["hash"] == credentials["hash"]
        assert store.get("user", "owner")["service"] is False
        assert store.get("user", "sso")["oidc"]["subject"] == "subject"
        assert store.get("session", "session")["credential"] == credentials["hash"]
        assert store.get("access", "project")["members"] == {"owner": "admin", "sso": "reader"}
        if previous == "0002_assistant":
            assert store.get("assistant_conversation", "conversation")["title"] == "Kept"
        auth = Auth(store)
        user = auth.create_user("migrated-service", service=True)
        token = auth.create_api_token(auth.public(store.get("user", "owner")), user["id"], "After migration")
        assert auth.check_api_token(token["token"])[0] == user
    finally:
        store.close()


def test_job_migration_keeps_worktree_runs_and_accepts_operators(tmp_path):
    engine = metadata_engine(tmp_path / "instance.sqlite")
    with migration_connection(engine) as connection:
        command.upgrade(configuration(connection), "0003_api_tokens")
        connection.execute(
            text(
                "INSERT INTO user (id, username, username_key, role, active, session_version, service, description) "
                "VALUES ('robot', 'robot', 'robot', 'member', 1, 0, 1, '')"
            )
        )
        connection.execute(
            text("INSERT INTO project VALUES ('project', 'Existing project', 'main', '2026-01-01')")
        )
        connection.execute(text("INSERT INTO worktree VALUES ('main', 'project', 'main', 'unused')"))
        connection.execute(text("INSERT INTO project_member VALUES ('project', 'robot', 'reader')"))
        connection.execute(
            text(
                "INSERT INTO run VALUES ('run', 'project', 'main', 'dev', 'success', '2026-01-01', NULL, NULL, '{}')"
            )
        )
    engine.dispose()
    store = Store(tmp_path)
    try:
        # Rebuilding the worktree table must not cascade into its run history.
        assert store.get("run", "run")["status"] == "success"
        assert store.get("worktree", "main") == {
            "id": "main",
            "project": "project",
            "branch": "main",
            "path": "unused",
        }
        access = store.get("access", "project")
        access["members"]["robot"] = "operator"
        store.put("access", "project", access)
        assert store.get("access", "project")["members"] == {"robot": "operator"}
    finally:
        store.close()


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


@pytest.mark.parametrize("kind", ["user", "project", "worktree", "connection", "environment", "access"])
def test_unknown_fields_are_rejected_without_changing_records(store, kind):
    Auth(store)
    worktree = Projects(store).create("Strict records")
    keys = {
        "user": "admin",
        "project": worktree["project"],
        "worktree": worktree["id"],
        "connection": "local",
        "environment": "dev",
        "access": worktree["project"],
    }
    key = keys[kind]
    original = store.get(kind, key)
    with pytest.raises(ValueError, match=f"Unknown {kind} fields: new_service_field"):
        store.put(kind, key, {**original, "new_service_field": "must not disappear"})
    assert store.get(kind, key) == original


def test_converted_fields_and_arbitrary_json_snapshots_round_trip(store):
    from datetime import UTC, date, datetime
    from decimal import Decimal

    worktree = Projects(store).create("Snapshots")
    identity = {"issuer": "https://identity.example", "subject": "one"}
    store.put("user", "sso", {"username": "SSO", "role": "member", "active": True, "oidc": identity})
    assert store.get("user", "sso")["oidc"] == identity
    connection = store.get("connection", "local")
    connection["environments"]["dev"] = {"arbitrary_parameter": "value"}
    store.put("connection", "local", connection)
    assert store.get("connection", "local") == connection
    transaction = {
        "browser": "browser",
        "nonce": "nonce",
        "verifier": "verifier",
        "revision": "revision",
        "metadata": {"custom_provider_field": [1, 2]},
        "expires": 123.0,
    }
    store.put("oidc_transaction", "transaction", transaction)
    assert store.get("oidc_transaction", "transaction") == transaction
    connector = {"id": "custom", "custom_definition_field": {"nested": True}}
    store.put("connector", "custom", connector)
    assert store.get("connector", "custom") == connector
    conflict = {"id": "conflict", "worktree": worktree["id"], "custom_snapshot_field": [1, 2]}
    store.put("conflict", "conflict", conflict)
    assert store.get("conflict", "conflict") == conflict
    snapshot = {
        "amount": Decimal("1.20"),
        "date": date(2026, 1, 2),
        "timestamp": datetime(2026, 1, 2, tzinfo=UTC),
        "bytes": b"\x00\xff",
    }
    store.put(
        "run",
        "run",
        {
            "project": worktree["project"],
            "worktree": worktree["id"],
            "environment": "dev",
            "status": "success",
            "started": "2026-01-01",
            "nodes": {"node": snapshot},
        },
    )
    assert store.get("run", "run")["nodes"]["node"] == {
        "amount": "1.20",
        "date": "2026-01-02",
        "timestamp": "2026-01-02T00:00:00+00:00",
        "bytes": "00ff",
    }
    store.put("settings", "custom", {"arbitrary": [1, 2]})
    store.put("revision", worktree["id"] + ":custom", {"custom.txt": "contents"})
    assert store.get("settings", "custom") == {"arbitrary": [1, 2]}
    assert store.get("revision", worktree["id"] + ":custom") == {"custom.txt": "contents"}


def test_scoped_queries_and_bulk_deletes_leave_other_projects_untouched(store):
    from sqlalchemy import event

    from duckpad.git.credentials import GitCredentials

    Auth(store)
    projects = Projects(store)
    first, second = projects.create("First"), projects.create("Second")
    credentials = GitCredentials(store)
    for tree in (first, second):
        key = tree["id"]
        store.put("conflict", key, {"worktree": key, "proposal": {"flow.json": "{}"}})
        store.put(
            "run",
            key,
            {
                "project": tree["project"],
                "worktree": key,
                "environment": "dev",
                "status": "success",
                "started": "2026-01-01",
            },
        )
        store.put(
            "artifact",
            key,
            {
                "run": key,
                "project": tree["project"],
                "worktree": key,
                "environment": "dev",
                "node": "export",
                "filename": "report.csv",
                "media_type": "text/csv",
                "size": 0,
                "signature": [],
            },
        )
        credentials.consent("admin", tree["project"], "https://example.com/repo.git")
    statements = []

    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(store.engine, "before_cursor_execute", capture)
    try:
        assert store.worktrees(first["project"]) == [first]
        assert store.find_worktree(first["project"], first["branch"]) == first
        assert store.find_worktree(first["project"], "missing") is None
        assert [c["id"] for c in projects.snapshot(first["id"])["conflicts"]] == [first["id"]]
        assert store.has_conflicts(first["id"])
        assert not store.has_conflicts("missing")
        assert store.artifact_ids(project=first["project"]) == [first["id"]]
        assert store.artifact_ids(worktree=second["id"]) == [second["id"]]
        credentials.forget_project(first["project"])
        assert not credentials.consented("admin", first["project"], "https://example.com/repo.git")
        assert credentials.consented("admin", second["project"], "https://example.com/repo.git")
    finally:
        event.remove(store.engine, "before_cursor_execute", capture)
    queries = [s for s in statements if s.startswith(("SELECT", "DELETE"))]
    assert queries and all("WHERE" in statement for statement in queries)


def test_oidc_transaction_count_and_clear_do_not_load_provider_snapshots(store, monkeypatch):
    for key in ("first", "second"):
        store.put(
            "oidc_transaction",
            key,
            {
                "browser": "browser",
                "nonce": "nonce",
                "verifier": "verifier",
                "revision": "revision",
                "metadata": {"arbitrary": True},
                "expires": 123.0,
            },
        )

    def refuse_record(*args):
        pytest.fail("Counting or deleting transactions must not deserialize their snapshots")

    monkeypatch.setattr(store, "_record", refuse_record)
    assert store.count_oidc_transactions() == 2
    store.delete_oidc_transactions()
    assert store.count_oidc_transactions() == 0


def test_visible_projects_come_with_their_role_from_one_query(store):
    auth = Auth(store)
    member = auth.create_user("member", "test-password-123")
    projects = Projects(store)
    created = [projects.create(f"Project {index}")["project"] for index in range(4)]
    for role, project in (("reader", created[2]), ("editor", created[1])):
        store.put("access", project, {"members": {member["id"]: role}, "connections": []})
    store.put("access", created[3], {"members": {"admin": "admin"}, "connections": []})
    admin = store.get("user", "admin")
    statements = []

    def record(connection, cursor, statement, *args):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(store.engine, "before_cursor_execute", record)
    try:
        visible = store.visible_projects(member)
        assert len(statements) == 1
        everything = store.visible_projects(admin)
        assert len(statements) == 2
    finally:
        event.remove(store.engine, "before_cursor_execute", record)
    assert [(p["id"], p["role"]) for p in visible] == [(created[1], "editor"), (created[2], "reader")]
    assert [(p["id"], p["role"]) for p in everything] == [(project, "admin") for project in created]
    assert visible[0] == {**store.get("project", created[1]), "role": "editor"}
