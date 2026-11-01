"""Serve built-in connectors from the release; stored connectors are overrides and custom types."""

import sqlalchemy as sa
from alembic import op

revision = "0006_builtin_connectors"
down_revision = "0005_job_idempotency"
branch_labels = None
depends_on = None

# Names the unnamed foreign key of the initial schema so that the batch rebuild can drop it.
NAMING = {"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}


def upgrade():
    with op.batch_alter_table("connection", naming_convention=NAMING) as batch:
        batch.drop_constraint("fk_connection_connector_connector", type_="foreignkey")


def downgrade():
    connection = op.get_bind()
    if connection.execute(
        sa.text("SELECT 1 FROM connection WHERE connector NOT IN (SELECT id FROM connector) LIMIT 1")
    ).first():
        raise RuntimeError("Remove connections whose connector is not stored before downgrading")
    with op.batch_alter_table("connection") as batch:
        batch.create_foreign_key(
            "fk_connection_connector_connector", "connector", ["connector"], ["id"], ondelete="RESTRICT"
        )
