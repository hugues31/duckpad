"""Inspect, check or generate migrations against a stopped development instance."""

import argparse
from pathlib import Path

from alembic import command

from duckpad.instance import instance_lease
from duckpad.migrations import configuration, migration_connection
from duckpad.paths import InstancePaths
from duckpad.store import metadata_engine
from duckpad.util import Problem


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("current", "check", "upgrade", "revision"))
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--message", default="Update instance metadata")
    args = parser.parse_args()
    args.home = args.home.expanduser().resolve()
    path = InstancePaths(args.home).database
    if not path.is_file():
        parser.exit(
            1, "Initialize a disposable instance first, then stop it before running migration commands\n"
        )
    engine = metadata_engine(path)
    try:
        with instance_lease(args.home), migration_connection(engine) as connection:
            config = configuration(connection)
            if args.action == "revision":
                command.revision(config, message=args.message, autogenerate=True)
            elif args.action == "upgrade":
                command.upgrade(config, "head")
            else:
                getattr(command, args.action)(config)
    except Problem as error:
        parser.exit(1, f"{error}\n")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
