"""Locate instance state and archive a stopped instance without opening its services."""

import io
import json
import os
import sqlite3
import tarfile
import tempfile
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from filelock import FileLock, Timeout

from . import __version__


class BackupError(Exception):
    pass


def instance_paths(home):
    home = home.expanduser().resolve()
    key_file = os.environ.get("DUCKPAD_MASTER_KEY_FILE")
    if key_file:
        key_source = "DUCKPAD_MASTER_KEY_FILE"
        key_path = str(Path(key_file).resolve())
    elif "DUCKPAD_MASTER_KEY" in os.environ:
        key_source, key_path = "DUCKPAD_MASTER_KEY", None
    else:
        key_source, key_path = "instance", str(home / "duckpad-master.key")
    return {
        "home": str(home),
        "exists": home.is_dir(),
        "database": str(home / "instance.sqlite"),
        "master_key": {"source": key_source, "path": key_path},
        "projects": str(home / "projects"),
        "worktrees": str(home / "worktrees"),
        "resources": str(home / "resources"),
        "artifacts": str(home / "artifacts"),
        "exports": str(home / "exports"),
        "extensions": str(home / "extensions"),
        "python": str(home / "python"),
    }


def print_paths(home, *, as_json=False):
    paths = instance_paths(home)
    if as_json:
        print(json.dumps(paths, indent=2))
        return
    print(f"Instance: {paths['home']}" + ("" if paths["exists"] else " (not created)"))
    print(f"Configuration, accounts and history: {paths['database']}")
    key = paths["master_key"]
    print(f"Master key: {key['path'] or key['source']} ({key['source']})")
    for name in ("projects", "worktrees", "resources", "artifacts", "exports", "extensions", "python"):
        print(f"{name.capitalize()}: {paths[name]}")
    print("Paths reflect this command's --home and environment, not a running server's configuration.")


def create_backup(home, destination):
    home = home.expanduser().resolve()
    # Resolve the parent only: an existing destination symlink must never be followed.
    destination = destination.expanduser().absolute()
    destination = destination.parent.resolve() / destination.name
    database = home / "instance.sqlite"
    if not database.is_file() or database.is_symlink():
        raise BackupError(f"No regular instance.sqlite in {home}. Pass the --home used with duckpad start.")
    if destination.is_relative_to(home):
        raise BackupError("Choose a backup destination outside the instance directory.")
    try:
        with FileLock(home / "instance.lock", timeout=0):
            return _archive(home, database, destination)
    except Timeout:
        raise BackupError("This Duckpad instance is running. Stop it before making a backup.") from None
    except sqlite3.Error as error:
        raise BackupError(f"Cannot back up the instance database: {error}") from None


def _archive(home, database, destination):
    def include(member):
        if member.name in {
            "duckpad/instance.lock",
            "duckpad/instance.sqlite-wal",
            "duckpad/instance.sqlite-shm",
        }:
            return None
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise BackupError(f"Cannot back up special file: {member.name}")
        # Do not preserve the machine's user names or numeric ownership on restore.
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        return member

    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output, tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "instance.sqlite"
            # Include committed WAL pages, even after a crash, without migrating the original.
            with (
                closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as source,
                closing(sqlite3.connect(snapshot)) as target,
            ):
                source.backup(target)
            snapshot.chmod(0o600)
            with tarfile.open(fileobj=output, mode="w:gz", dereference=False) as archive:
                manifest = {
                    "format": 1,
                    "duckpad_version": __version__,
                    "created_at": datetime.now(UTC).isoformat(),
                    "original_home": str(home),
                    "restore": "Stop Duckpad and restore duckpad/ to original_home using the same Duckpad version.",
                    "external_dependencies": "Back up external master keys, secret sources and data separately. "
                    "Symbolic links are preserved, not followed.",
                }
                content = json.dumps(manifest, indent=2).encode()
                member = tarfile.TarInfo("manifest.json")
                member.size, member.mode = len(content), 0o600
                archive.addfile(member, io.BytesIO(content))
                archive.add(home, arcname="duckpad", recursive=False, filter=include)
                for child in sorted(home.iterdir()):
                    if child == database:
                        archive.add(snapshot, arcname="duckpad/instance.sqlite", filter=include)
                    else:
                        archive.add(child, arcname=f"duckpad/{child.name}", filter=include)
        return destination
    except BaseException:
        destination.unlink()
        raise
