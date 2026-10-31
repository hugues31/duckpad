"""Add API tokens and passwordless service accounts."""

import sqlalchemy as sa
from alembic import op

revision = "0003_api_tokens"
down_revision = "0002_assistant"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("user") as batch:
        batch.add_column(sa.Column("service", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("description", sa.String(), nullable=False, server_default=""))
        batch.drop_constraint("user_credentials", type_="check")
        batch.create_check_constraint(
            "user_credentials",
            "(service = 0 AND ((oidc_issuer IS NULL AND oidc_subject IS NULL AND salt IS NOT NULL AND hash IS NOT NULL) "
            "OR (oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL AND salt IS NULL AND hash IS NULL))) "
            "OR (service = 1 AND role = 'member' AND oidc_issuer IS NULL AND oidc_subject IS NULL AND salt IS NULL AND hash IS NULL)",
        )
    with op.batch_alter_table("user") as batch:
        batch.alter_column("service", server_default=None)
        batch.alter_column("description", server_default=None)
    op.create_table(
        "api_token",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user", sa.String(), nullable=False),
        sa.Column("hash", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("created", sa.Float(), nullable=False),
        sa.Column("expires", sa.Float(), nullable=True),
        sa.Column("last_used", sa.Float(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user"], ["user.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("hash"),
    )
    op.create_index("ix_api_token_user", "api_token", ["user"])


def downgrade():
    # Older schemas cannot represent service accounts without inventing passwords.
    if op.get_bind().execute(sa.text("SELECT 1 FROM user WHERE service = 1 LIMIT 1")).first():
        raise RuntimeError("Remove service accounts before downgrading the API token schema")
    op.drop_table("api_token")
    with op.batch_alter_table("user") as batch:
        batch.drop_constraint("user_credentials", type_="check")
        batch.drop_column("service")
        batch.drop_column("description")
        batch.create_check_constraint(
            "user_credentials",
            "(oidc_issuer IS NULL AND oidc_subject IS NULL AND salt IS NOT NULL AND hash IS NOT NULL) "
            "OR (oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL AND salt IS NULL AND hash IS NULL)",
        )
