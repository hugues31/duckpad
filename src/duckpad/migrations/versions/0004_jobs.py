"""Add Operators and Jobs with internal read-only worktrees."""

import sqlalchemy as sa
from alembic import op

revision = "0004_jobs"
down_revision = "0003_api_tokens"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("project_member") as batch:
        batch.drop_constraint("project_member_role", type_="check")
        batch.create_check_constraint(
            "project_member_role", "role IN ('reader', 'operator', 'editor', 'admin')"
        )
    with op.batch_alter_table("worktree") as batch:
        batch.add_column(sa.Column("read_only", sa.Boolean(), nullable=False, server_default=sa.false()))
    with op.batch_alter_table("worktree") as batch:
        batch.alter_column("read_only", server_default=None)
    op.create_table(
        "job",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project", sa.String(), nullable=False),
        sa.Column("worktree", sa.String(), nullable=False, unique=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("scope", sa.String()),
        sa.Column("target", sa.JSON(), nullable=False),
        sa.Column("runtime_variables", sa.JSON(), nullable=False),
        sa.Column("versions", sa.JSON(), nullable=False),
        sa.Column("revision", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["worktree", "project"],
            ["worktree.id", "worktree.project"],
            ondelete="CASCADE",
            name="job_worktree_project",
        ),
    )
    op.create_index("ix_job_project", "job", ["project"])


def downgrade():
    connection = op.get_bind()
    if connection.execute(sa.text("SELECT 1 FROM worktree WHERE read_only = 1 LIMIT 1")).first():
        raise RuntimeError("Remove Job worktrees and their history before downgrading")
    if connection.execute(sa.text("SELECT 1 FROM project_member WHERE role = 'operator' LIMIT 1")).first():
        raise RuntimeError("Reassign Operators before downgrading")
    op.drop_table("job")
    with op.batch_alter_table("worktree") as batch:
        batch.drop_column("read_only")
    with op.batch_alter_table("project_member") as batch:
        batch.drop_constraint("project_member_role", type_="check")
        batch.create_check_constraint("project_member_role", "role IN ('reader', 'editor', 'admin')")
