"""Keep partition metadata in the instance Store and cascade with its owners."""

import sqlalchemy as sa
from alembic import op

revision = "0007_partitions"
down_revision = "0006_builtin_connectors"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "partition_manifest",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("worktree", sa.String(), sa.ForeignKey("worktree.id", ondelete="CASCADE"), nullable=False),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("run", sa.String(), sa.ForeignKey("run.id", ondelete="CASCADE"), nullable=False),
        sa.Column("signature", sa.String(), nullable=False),
        sa.Column("created", sa.String(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
    )
    op.create_index(
        "partition_manifest_lookup", "partition_manifest", ["worktree", "environment", "signature", "created"]
    )
    op.create_index("ix_partition_manifest_run", "partition_manifest", ["run"])
    op.create_table(
        "partition_entry",
        sa.Column(
            "manifest",
            sa.String(),
            sa.ForeignKey("partition_manifest.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("ordinal", sa.Integer(), primary_key=True),
        sa.Column("partition_id", sa.String(), nullable=False),
        sa.Column("key_hash", sa.String(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.UniqueConstraint("manifest", "partition_id", name="partition_entry_identity"),
    )
    op.create_table(
        "partition_attempt",
        sa.Column("run", sa.String(), sa.ForeignKey("run.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("partition_id", sa.String(), primary_key=True),
        sa.Column("node", sa.String(), primary_key=True),
        sa.Column("state", sa.JSON(), nullable=False),
    )
    op.create_table(
        "partition_result",
        sa.Column(
            "worktree", sa.String(), sa.ForeignKey("worktree.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("environment", sa.String(), primary_key=True),
        sa.Column("node", sa.String(), primary_key=True),
        sa.Column("key_hash", sa.String(), primary_key=True),
        sa.Column("state", sa.JSON(), nullable=False),
    )
    op.create_table(
        "partition_output",
        sa.Column("id", sa.String(), sa.ForeignKey("artifact.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("worktree", sa.String(), sa.ForeignKey("worktree.id", ondelete="CASCADE"), nullable=False),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("node", sa.String(), nullable=False),
        sa.Column("key_hash", sa.String(), nullable=False),
        sa.Column("dataset", sa.String(), nullable=False),
        sa.Column("mandatory", sa.Boolean(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
    )
    op.create_index(
        "partition_output_lookup", "partition_output", ["worktree", "environment", "node", "key_hash"]
    )
    op.create_index("ix_partition_output_dataset", "partition_output", ["dataset"])


def downgrade():
    for table in (
        "partition_output",
        "partition_result",
        "partition_attempt",
        "partition_entry",
        "partition_manifest",
    ):
        op.drop_table(table)
