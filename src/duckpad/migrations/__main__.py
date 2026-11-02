"""Inspect, check or generate migrations against a stopped development instance."""

import argparse
from pathlib import Path

from alembic import command
from filelock import FileLock, Timeout

from duckpad.migrations import configuration, migration_connection
from duckpad.store import metadata_engine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("current", "check", "upgrade", "revision"))
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--message", default="Update instance metadata")
    args = parser.parse_args()
    path = args.home / "instance.sqlite"
    if not path.is_file():
        parser.error("Initialize a disposable instance first, then stop it before running migration commands")
    engine = metadata_engine(path)
    try:
        with FileLock(args.home / "instance.lock", timeout=0), migration_connection(engine) as connection:
            config = configuration(connection)
            if args.action == "revision":
                command.revision(config, message=args.message, autogenerate=True)
            elif args.action == "upgrade":
                command.upgrade(config, "head")
            else:
                getattr(command, args.action)(config)
    except Timeout:
        parser.error("Stop this Duckpad instance before running migration commands")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
