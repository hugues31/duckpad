"""Packaged Alembic migrations used by installed wheels and development tools."""

import threading
from contextlib import contextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect

from duckpad.util import Problem

_migration_lock = threading.Lock()


def configuration(connection):
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent))
    config.attributes["connection"] = connection
    return config


@contextmanager
def migration_connection(engine):
    """Allow SQLite batch rebuilds without cascading deletes into child tables.

    The application has not started serving requests yet. Disable enforcement
    outside BEGIN, then validate every foreign key before committing the DDL.
    """
    with _migration_lock, engine.connect() as connection:
        raw = connection.connection.dbapi_connection
        raw.execute("PRAGMA foreign_keys=OFF")
        try:
            with connection.begin():
                if "records" in inspect(connection).get_table_names():
                    raise Problem(
                        "This database uses the unsupported document schema. Start with a new data directory using duckpad start --home <new-directory>."
                    )
                yield connection
                if connection.exec_driver_sql("PRAGMA foreign_key_check").first():
                    raise Problem("Migration left invalid foreign keys; changes were rolled back")
        finally:
            raw.execute("PRAGMA foreign_keys=ON")


def upgrade(engine):
    # Alembic's environment proxy is process-global during command execution.
    with migration_connection(engine) as connection:
        command.upgrade(configuration(connection), "head")
