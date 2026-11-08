"""Record artifact storage independently of the file format."""

import sqlalchemy as sa
from alembic import op

revision = "0002_artifact_storage"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "artifact", sa.Column("storage_kind", sa.String(), nullable=False, server_default="download")
    )
    # Existing Parquet downloads also lived here; retain their location until removed.
    op.execute(
        "UPDATE artifact SET storage_kind = 'partition' WHERE media_type = 'application/vnd.apache.parquet'"
    )


def downgrade():
    misplaced = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT count(*) FROM artifact WHERE storage_kind = 'download' "
                "AND media_type = 'application/vnd.apache.parquet'"
            )
        )
        .scalar_one()
    )
    if misplaced:
        raise RuntimeError("Remove Parquet downloads before downgrading artifact storage")
    op.drop_column("artifact", "storage_kind")
