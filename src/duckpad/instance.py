"""Instance diagnostics and the locks shared by startup, backup and restore."""

import json
import platform
from contextlib import contextmanager
from importlib.metadata import PackageNotFoundError, version

from filelock import FileLock, Timeout

from . import __version__
from .paths import InstancePaths
from .sealing import key_source
from .util import Problem


def instance_info(home):
    paths = InstancePaths(home.expanduser().resolve())
    source, key_path = key_source(paths.home)
    try:
        duckdb_version = version("duckdb")
    except PackageNotFoundError:
        duckdb_version = None
    return {
        "duckpad": __version__,
        "python": platform.python_version(),
        "duckdb": duckdb_version,
        "platform": platform.platform(),
        "home": str(paths.home),
        "exists": paths.database.is_file(),
        "database": str(paths.database),
        "master_key": {"source": source, "path": str(key_path) if key_path else None},
    }


def print_info(home, *, as_json=False):
    info = instance_info(home)
    if as_json:
        print(json.dumps(info, indent=2))
        return
    print(f"Duckpad {info['duckpad']} · Python {info['python']} · DuckDB {info['duckdb'] or 'not installed'}")
    print(f"Platform: {info['platform']}")
    print(f"Instance: {info['home']}" + ("" if info["exists"] else " (not created)"))
    print(f"Database: {info['database']}")
    key = info["master_key"]
    print(f"Master key: {key['source']}" + (f" ({key['path']})" if key["path"] else ""))


@contextmanager
def instance_lease(home, *, create=False):
    paths = InstancePaths(home)
    paths.home.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        # This sibling lock survives the directory rename performed by restore.
        with FileLock(paths.maintenance_lock, timeout=0, mode=0o600):
            if create:
                paths.home.mkdir(parents=True, exist_ok=True, mode=0o700)
            if paths.home.exists():
                with FileLock(paths.lock, timeout=0, mode=0o600) as lease:
                    yield lease
            else:
                yield None
    except Timeout:
        raise Problem(
            "This Duckpad instance is already running or maintenance is in progress. "
            "Stop it and wait for other backup/restore commands to finish."
        ) from None
