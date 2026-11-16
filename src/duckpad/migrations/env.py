"""Run migrations on the application's configured transactional connection."""

from alembic import context
from sqlmodel import SQLModel
from sqlmodel.sql.sqltypes import AutoString

from duckpad import models  # noqa: F401


def render_item(kind, value, _context):
    if kind == "type" and isinstance(value, AutoString):
        return f"sa.String(length={value.length!r})" if value.length else "sa.String()"
    return False


context.configure(
    connection=context.config.attributes["connection"],
    target_metadata=SQLModel.metadata,
    render_as_batch=True,
    compare_type=True,
    render_item=render_item,
)
with context.begin_transaction():
    context.run_migrations()
