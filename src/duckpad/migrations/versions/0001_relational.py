"""Create the initial relational schema and default catalog on a fresh database."""

import sqlalchemy as sa
from alembic import op

revision = "0001_relational"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "connector",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("definition", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "environment",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("color", sa.String(), nullable=False),
        sa.Column("confirm_before_run", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "oidc_transaction",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("browser", sa.String(), nullable=False),
        sa.Column("nonce", sa.String(), nullable=False),
        sa.Column("verifier", sa.String(), nullable=False),
        sa.Column("revision", sa.String(), nullable=False),
        sa.Column("provider", sa.JSON(), nullable=False),
        sa.Column("expires", sa.Float(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_oidc_transaction_expires"), "oidc_transaction", ["expires"], unique=False)
    op.create_table(
        "project",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("main", sa.String(), nullable=False),
        sa.Column("created", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["main", "id"],
            ["worktree.id", "worktree.project"],
            name="project_main_worktree",
            initially="DEFERRED",
            deferrable=True,
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "setting",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "user",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("username", sa.String(), nullable=False),
        sa.Column("username_key", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("salt", sa.String(), nullable=True),
        sa.Column("hash", sa.String(), nullable=True),
        sa.Column("oidc_issuer", sa.String(), nullable=True),
        sa.Column("oidc_subject", sa.String(), nullable=True),
        sa.Column("session_version", sa.Integer(), nullable=False),
        sa.Column("commit_identity", sa.JSON(), nullable=True),
        sa.CheckConstraint("role IN ('admin', 'member')", name="user_role"),
        sa.CheckConstraint(
            "(oidc_issuer IS NULL AND oidc_subject IS NULL AND salt IS NOT NULL AND hash IS NOT NULL) OR (oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL AND salt IS NULL AND hash IS NULL)",
            name="user_credentials",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("oidc_issuer", "oidc_subject", name="user_oidc_identity"),
        sa.UniqueConstraint("username_key"),
    )
    op.create_table(
        "connection",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("connector", sa.String(), nullable=False),
        sa.Column("secret_fields", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["connector"], ["connector.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_connection_connector"), "connection", ["connector"], unique=False)
    op.create_table(
        "git_consent",
        sa.Column("project", sa.String(), nullable=False),
        sa.Column("user", sa.String(), nullable=False),
        sa.Column("url", sa.String(), nullable=False),
        sa.Column("confirmed", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["project"], ["project.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project", "user"),
    )
    op.create_index(op.f("ix_git_consent_user"), "git_consent", ["user"], unique=False)
    op.create_table(
        "git_remote",
        sa.Column("project", sa.String(), nullable=False),
        sa.Column("url", sa.String(), nullable=True),
        sa.Column("version", sa.String(), nullable=False),
        sa.Column("mappings", sa.JSON(), nullable=False),
        sa.Column("checked", sa.String(), nullable=True),
        sa.Column("seen", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["project"], ["project.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project"),
    )
    op.create_table(
        "project_member",
        sa.Column("project", sa.String(), nullable=False),
        sa.Column("user", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.CheckConstraint("role IN ('reader', 'editor', 'admin')", name="project_member_role"),
        sa.ForeignKeyConstraint(["project"], ["project.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project", "user"),
    )
    op.create_index(op.f("ix_project_member_user"), "project_member", ["user"], unique=False)
    op.create_table(
        "session",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user", sa.String(), nullable=False),
        sa.Column("expires", sa.Float(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("credential", sa.String(), nullable=True),
        sa.Column("oidc_revision", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["user"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_session_expires"), "session", ["expires"], unique=False)
    op.create_index(op.f("ix_session_user"), "session", ["user"], unique=False)
    op.create_table(
        "ssh_key",
        sa.Column("user", sa.String(), nullable=False),
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("private_key", sa.String(), nullable=False),
        sa.Column("public_key", sa.String(), nullable=False),
        sa.Column("fingerprint", sa.String(), nullable=False),
        sa.Column("created", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["user"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user"),
        sa.UniqueConstraint("id"),
    )
    op.create_table(
        "worktree",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("project", sa.String(), nullable=False),
        sa.Column("branch", sa.String(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["project"], ["project.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "project", name="worktree_project_identity"),
        sa.UniqueConstraint("path"),
        sa.UniqueConstraint("project", "branch", name="worktree_project_branch"),
    )
    op.create_index(op.f("ix_worktree_project"), "worktree", ["project"], unique=False)
    op.create_table(
        "conflict",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("worktree", sa.String(), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["worktree"], ["worktree.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_conflict_worktree"), "conflict", ["worktree"], unique=False)
    op.create_table(
        "connection_environment",
        sa.Column("connection", sa.String(), nullable=False),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("parameters", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["connection"], ["connection.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["environment"], ["environment.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("connection", "environment"),
    )
    op.create_index(
        op.f("ix_connection_environment_environment"), "connection_environment", ["environment"], unique=False
    )
    op.create_table(
        "project_connection",
        sa.Column("project", sa.String(), nullable=False),
        sa.Column("connection", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["connection"], ["connection.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project"], ["project.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project", "connection"),
    )
    op.create_index(
        op.f("ix_project_connection_connection"), "project_connection", ["connection"], unique=False
    )
    op.create_table(
        "revision",
        sa.Column("worktree", sa.String(), nullable=False),
        sa.Column("revision", sa.String(), nullable=False),
        sa.Column("files", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["worktree"], ["worktree.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("worktree", "revision"),
    )
    op.create_table(
        "run",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("project", sa.String(), nullable=False),
        sa.Column("worktree", sa.String(), nullable=False),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("started", sa.String(), nullable=False),
        sa.Column("finished", sa.String(), nullable=True),
        sa.Column("duration", sa.Float(), nullable=True),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(
            ["worktree", "project"],
            ["worktree.id", "worktree.project"],
            name="run_worktree_project",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_run_environment"), "run", ["environment"], unique=False)
    op.create_index(op.f("ix_run_status"), "run", ["status"], unique=False)
    op.create_index("run_project_started", "run", ["project", "started"], unique=False)
    op.create_index("run_worktree_started", "run", ["worktree", "started"], unique=False)
    op.create_table(
        "artifact",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("run", sa.String(), nullable=False),
        sa.Column("project", sa.String(), nullable=False),
        sa.Column("worktree", sa.String(), nullable=False),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("node", sa.String(), nullable=False),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("media_type", sa.String(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("signature", sa.JSON(), nullable=False),
        sa.CheckConstraint("size >= 0", name="artifact_size"),
        sa.ForeignKeyConstraint(["project"], ["project.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run"], ["run.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["worktree"], ["worktree.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_artifact_project"), "artifact", ["project"], unique=False)
    op.create_index(op.f("ix_artifact_run"), "artifact", ["run"], unique=False)
    op.create_index(op.f("ix_artifact_worktree"), "artifact", ["worktree"], unique=False)
    op.create_table(
        "export_result",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("worktree", sa.String(), nullable=False),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("node", sa.String(), nullable=False),
        sa.Column("run", sa.String(), nullable=False),
        sa.Column("artifact", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("run_status", sa.String(), nullable=False),
        sa.Column("fingerprint", sa.String(), nullable=True),
        sa.Column("commit", sa.String(), nullable=False),
        sa.Column("started", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["artifact"], ["artifact.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["run"], ["run.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["worktree"], ["worktree.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("worktree", "environment", "node", name="export_result_node"),
    )
    op.create_index(op.f("ix_export_result_artifact"), "export_result", ["artifact"], unique=False)
    op.create_index(op.f("ix_export_result_run"), "export_result", ["run"], unique=False)
    op.create_index(op.f("ix_export_result_worktree"), "export_result", ["worktree"], unique=False)

    op.bulk_insert(
        sa.table(
            "environment",
            sa.column("id"),
            sa.column("label"),
            sa.column("color"),
            sa.column("confirm_before_run", sa.Boolean()),
        ),
        [
            {"id": "dev", "label": "dev", "color": "#31a878", "confirm_before_run": False},
            {"id": "prod", "label": "prod", "color": "#e05252", "confirm_before_run": True},
        ],
    )
    op.bulk_insert(
        sa.table("connector", sa.column("id"), sa.column("name"), sa.column("definition", sa.JSON())),
        [
            {
                "id": "local",
                "name": "Local files",
                "definition": {
                    "description": "CSV and Parquet on this computer.",
                    "parameters": [{"name": "root", "type": "text", "default": ""}],
                    "extensions": [],
                    "init_sql": "",
                    "capabilities": ["read", "write"],
                    "compatibility": "Validated on DuckDB 2.0.0, Linux x86_64, with native CSV and Parquet. Other DuckDB versions and platforms require validation.",
                },
            },
            {
                "id": "xlsx",
                "name": "Excel (XLSX)",
                "definition": {
                    "description": "Read worksheets and export XLSX workbooks on this computer.",
                    "parameters": [{"name": "root", "type": "text", "default": ""}],
                    "extensions": [{"name": "excel"}],
                    "init_sql": "",
                    "capabilities": ["read", "write"],
                    "compatibility": "Requires the matching DuckDB excel extension. Validated with DuckDB 2.0.0 on Linux x86_64, including isolated execution. Legacy .xls files are not supported.",
                },
            },
            {
                "id": "s3",
                "name": "Amazon S3",
                "definition": {
                    "description": "CSV and Parquet in S3-compatible object storage.",
                    "parameters": [
                        {"name": "key_id", "type": "text", "secret": True},
                        {"name": "secret", "type": "text", "secret": True},
                        {"name": "region", "type": "text", "default": "us-east-1"},
                        {"name": "endpoint", "type": "text", "default": "s3.amazonaws.com"},
                        {"name": "use_ssl", "type": "boolean", "default": True},
                        {"name": "url_style", "type": "text", "default": "vhost"},
                    ],
                    "extensions": [{"name": "httpfs"}],
                    "init_sql": "CREATE OR REPLACE TEMPORARY SECRET {{ secret_name }} (TYPE S3, KEY_ID {{ key_id }}, SECRET {{ secret }}, REGION {{ region }}, ENDPOINT {{ endpoint }}, USE_SSL {{ use_ssl }}, URL_STYLE {{ url_style }});",
                    "capabilities": ["read", "write"],
                    "compatibility": "Validated on DuckDB 2.0.0 with matching httpfs, Linux x86_64, and a Moto S3 endpoint. Live AWS IAM/TLS behavior requires deployment validation.",
                },
            },
            {
                "id": "oracle",
                "name": "Oracle · OraDuck",
                "definition": {
                    "description": "Read Oracle tables and load existing tables through OraDuck.",
                    "parameters": [
                        {"name": "user", "type": "text"},
                        {"name": "password", "type": "text", "secret": True},
                        {"name": "dsn", "type": "text"},
                    ],
                    "extensions": [{"name": "oraduck", "repository": "community"}],
                    "init_sql": "CREATE OR REPLACE TEMPORARY SECRET {{ secret_name }} (TYPE oraduck, USER {{ user }}, PASSWORD {{ password }}, DSN {{ dsn }}); ATTACH '' AS {{ alias }} (TYPE oraduck, SECRET {{ secret_name }});",
                    "capabilities": ["read", "write"],
                    "compatibility": "Validated with DuckDB 2.0.0, OraDuck 0.4.0, Oracle 19.3, Instant Client 19.32 on Linux x86_64. Requires a matching extension, Instant Client 19+ (Basic/Basic Light), libaio and libnsl on Linux. Other platforms and versions require validation.",
                },
            },
        ],
    )
    op.bulk_insert(
        sa.table(
            "connection",
            sa.column("id"),
            sa.column("name"),
            sa.column("connector"),
            sa.column("secret_fields", sa.JSON()),
        ),
        [{"id": "local", "name": "Local workspace", "connector": "local", "secret_fields": []}],
    )
    op.bulk_insert(
        sa.table(
            "connection_environment",
            sa.column("connection"),
            sa.column("environment"),
            sa.column("parameters", sa.JSON()),
        ),
        [
            {"connection": "local", "environment": name, "parameters": {"root": ""}}
            for name in ("dev", "prod")
        ],
    )


def downgrade():
    op.drop_index(op.f("ix_export_result_worktree"), table_name="export_result")
    op.drop_index(op.f("ix_export_result_run"), table_name="export_result")
    op.drop_index(op.f("ix_export_result_artifact"), table_name="export_result")
    op.drop_table("export_result")
    op.drop_index(op.f("ix_artifact_worktree"), table_name="artifact")
    op.drop_index(op.f("ix_artifact_run"), table_name="artifact")
    op.drop_index(op.f("ix_artifact_project"), table_name="artifact")
    op.drop_table("artifact")
    op.drop_index("run_worktree_started", table_name="run")
    op.drop_index("run_project_started", table_name="run")
    op.drop_index(op.f("ix_run_status"), table_name="run")
    op.drop_index(op.f("ix_run_environment"), table_name="run")
    op.drop_table("run")
    op.drop_table("revision")
    op.drop_index(op.f("ix_project_connection_connection"), table_name="project_connection")
    op.drop_table("project_connection")
    op.drop_index(op.f("ix_connection_environment_environment"), table_name="connection_environment")
    op.drop_table("connection_environment")
    op.drop_index(op.f("ix_conflict_worktree"), table_name="conflict")
    op.drop_table("conflict")
    op.drop_index(op.f("ix_worktree_project"), table_name="worktree")
    op.drop_table("worktree")
    op.drop_table("ssh_key")
    op.drop_index(op.f("ix_session_user"), table_name="session")
    op.drop_index(op.f("ix_session_expires"), table_name="session")
    op.drop_table("session")
    op.drop_index(op.f("ix_project_member_user"), table_name="project_member")
    op.drop_table("project_member")
    op.drop_table("git_remote")
    op.drop_index(op.f("ix_git_consent_user"), table_name="git_consent")
    op.drop_table("git_consent")
    op.drop_index(op.f("ix_connection_connector"), table_name="connection")
    op.drop_table("connection")
    op.drop_table("user")
    op.drop_table("setting")
    op.drop_table("project")
    op.drop_index(op.f("ix_oidc_transaction_expires"), table_name="oidc_transaction")
    op.drop_table("oidc_transaction")
    op.drop_table("environment")
    op.drop_table("connector")
