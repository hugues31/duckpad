"""Keep private assistant conversations in the instance database."""

import sqlalchemy as sa
from alembic import op

revision = "0002_assistant"
down_revision = "0001_relational"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "assistant_conversation",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user", sa.String(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project", sa.String(), sa.ForeignKey("project.id", ondelete="CASCADE")),
        sa.Column("branch", sa.String(), nullable=False),
        sa.Column("worktree", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("updated", sa.String(), nullable=False),
        sa.Column("allow_data", sa.Boolean(), nullable=False),
        sa.Column("messages", sa.JSON(), nullable=False),
        sa.Column("turns", sa.JSON(), nullable=False),
    )
    op.create_index("assistant_owner_updated", "assistant_conversation", ["user", "updated"])


def downgrade():
    op.drop_index("assistant_owner_updated", table_name="assistant_conversation")
    op.drop_table("assistant_conversation")
