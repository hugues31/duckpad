"""Remember accepted Job launches for seven days."""

import sqlalchemy as sa
from alembic import op

revision = "0005_job_idempotency"
down_revision = "0004_jobs"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "job_idempotency",
        sa.Column("job", sa.String(), sa.ForeignKey("job.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("request_hash", sa.String(), nullable=False),
        sa.Column("run", sa.String(), sa.ForeignKey("run.id", ondelete="CASCADE"), nullable=False),
        sa.Column("expires", sa.Float(), nullable=False),
    )
    op.create_index("ix_job_idempotency_expires", "job_idempotency", ["expires"])


def downgrade():
    op.drop_table("job_idempotency")
