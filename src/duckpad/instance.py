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
def instance_lease(home):
    """Admit one server, backup, restore or migration command per instance directory."""
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = FileLock(InstancePaths(home).lock, mode=0o600)
    try:
        lock.acquire(timeout=0)
    except Timeout:
        raise Problem(
            "This Duckpad instance is already running, or a backup or restore is using it. "
            "Stop it or wait for that command to finish, or choose another --home."
        ) from None
    try:
        yield
    finally:
        lock.release()
