"""Private archives and staged restoration of stopped instances."""

import io
import json
import os
import shutil
import sqlite3
import tarfile
import tempfile
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from . import __version__
from .instance import instance_lease
from .paths import InstancePaths
from .util import Problem


class BackupError(Problem):
    pass


def backup_destination(home, destination):
    path = Path(destination).expanduser().absolute() if destination is not None else Path.cwd()
    directory = path.is_dir() or (
        not path.exists()
        and not path.is_symlink()
        and (not path.suffix or str(destination).endswith(("/", os.sep)))
    )
    if directory:
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        path /= f"duckpad-{__version__}-{stamp}.tar.gz"
    # Keep the final component literal so O_EXCL also rejects dangling symlinks.
    path = path.parent.resolve() / path.name
    if path.is_relative_to(home):
        raise BackupError("Choose a backup destination outside the instance directory.")
    if path.exists() or path.is_symlink():
        raise BackupError(f"Backup already exists: {path}. Choose another filename.")
    return path


def create_backup(home, destination=None, *, include_python_cache=False):
    home = home.expanduser().resolve()
    paths = InstancePaths(home)
    if not paths.database.is_file() or paths.database.is_symlink():
        raise BackupError(f"No regular instance.sqlite in {home}. Pass the --home used with duckpad start.")
    destination = backup_destination(home, destination)
    with instance_lease(home):
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            return _archive(paths, destination, include_python_cache=include_python_cache)
        except FileExistsError:
            raise BackupError(f"Backup already exists: {destination}. Choose another filename.") from None
        except sqlite3.Error as error:
            raise BackupError(f"Cannot back up the instance database: {error}") from None


def _archive(paths, destination, *, include_python_cache):
    database_name = f"duckpad/{paths.database.name}"
    excluded = {f"duckpad/{paths.lock.name}", database_name + "-wal", database_name + "-shm"}
    if not include_python_cache:
        excluded.add(f"duckpad/{paths.python_cache.name}")

    def include(member):
        if member.name in excluded:
            return None
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise BackupError(f"Cannot back up special file: {member.name}")
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        if member.name in {database_name, f"duckpad/{paths.master_key.name}"}:
            member.mode = 0o600
        return member

    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        # Stage outside the instance even when TMPDIR points inside it.
        with (
            os.fdopen(descriptor, "wb") as output,
            tempfile.TemporaryDirectory(dir=destination.parent) as directory,
        ):
            snapshot = Path(directory) / paths.database.name
            with (
                closing(sqlite3.connect(paths.database.as_uri() + "?mode=ro", uri=True)) as source,
                closing(sqlite3.connect(snapshot)) as target,
            ):
                source.backup(target)
            snapshot.chmod(0o600)
            with tarfile.open(fileobj=output, mode="w:gz", dereference=False) as archive:
                manifest = {
                    "format": 1,
                    "duckpad_version": __version__,
                    "created_at": datetime.now(UTC).isoformat(),
                    "original_home": str(paths.home),
                    "python_cache_included": include_python_cache,
                    "external_dependencies": "External master keys, secret sources and data need separate backups. "
                    "Symbolic links are preserved, not followed.",
                }
                content = json.dumps(manifest, indent=2).encode()
                member = tarfile.TarInfo("manifest.json")
                member.size, member.mode = len(content), 0o600
                archive.addfile(member, io.BytesIO(content))
                archive.add(paths.home, arcname="duckpad", recursive=False, filter=include)
                for child in sorted(paths.home.iterdir()):
                    archive.add(
                        snapshot if child == paths.database else child,
                        arcname=f"duckpad/{child.name}",
                        filter=include,
                    )
        return destination
    except BaseException:
        destination.unlink()
        raise


def _member_path(name):
    # Reject platform-specific path spellings as well as POSIX traversal.
    parts = name.rstrip("/").split("/")
    if any(part in ("", ".", "..") or "\\" in part or ":" in part or "\0" in part for part in parts):
        raise BackupError(f"Unsafe archive path: {name!r}")
    if os.name == "nt":
        for part in parts:
            stem = part.split(".")[0].upper()
            if part.rstrip(" .") != part or stem in {
                "CON",
                "PRN",
                "AUX",
                "NUL",
                *(f"COM{i}" for i in range(1, 10)),
                *(f"LPT{i}" for i in range(1, 10)),
            }:
                raise BackupError(f"Unsupported archive path: {name!r}")
    return PurePosixPath(*parts)


def _restore_plan(archive):
    members = {}
    names = set()
    for member in archive:
        path = _member_path(member.name)
        identity = str(path).casefold() if os.name == "nt" else str(path)
        if identity in names:
            raise BackupError(f"Duplicate archive path: {member.name!r}")
        names.add(identity)
        if path != PurePosixPath("manifest.json") and path.parts[0] != "duckpad":
            raise BackupError(f"Unexpected archive entry: {member.name!r}")
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise BackupError(f"Unsupported archive entry: {member.name!r}")
        members[path] = member
    # Tar's end marker can precede gzip's checksum/trailer. Validate that too.
    while archive.fileobj.read(1024 * 1024):
        pass
    manifest_member = members.get(PurePosixPath("manifest.json"))
    if not manifest_member or not manifest_member.isfile() or manifest_member.size > 1024 * 1024:
        raise BackupError("The archive has no valid Duckpad manifest.")
    with archive.extractfile(manifest_member) as stream:
        manifest = json.load(stream)
    if not isinstance(manifest, dict) or manifest.get("format") != 1:
        raise BackupError("Unsupported Duckpad backup format.")
    root = PurePosixPath("duckpad")
    if root not in members or not members[root].isdir():
        raise BackupError("The archive has no instance directory.")
    paths = InstancePaths(Path("duckpad"))
    database = PurePosixPath(paths.database.as_posix())
    if database not in members or not members[database].isfile():
        raise BackupError("The archive has no regular instance database.")
    forbidden = {
        PurePosixPath(paths.lock.as_posix()),
        database.with_name(database.name + "-wal"),
        database.with_name(database.name + "-shm"),
    }
    if forbidden & members.keys():
        raise BackupError("The archive contains live instance lock or journal files.")
    for path, member in members.items():
        for parent in path.parents:
            if parent == PurePosixPath("."):
                break
            if parent not in members or not members[parent].isdir():
                raise BackupError(f"Archive entry has a non-directory parent: {member.name!r}")
        if member.islnk():
            target = _member_path(member.linkname)
            if target not in members or not members[target].isfile() or target.parts[0] != "duckpad":
                raise BackupError(f"Unsafe archive hard link: {member.name!r}")
        if member.issym() and (not member.linkname or "\0" in member.linkname):
            raise BackupError(f"Invalid archive symbolic link: {member.name!r}")
    return manifest, members


def _extract(archive, members, staging):
    # Directories, then files in archive order (gzip rereads from the start to seek back),
    # then links: no write ever traverses an archive symlink.
    entries = [
        (staging.joinpath(*path.parts), member)
        for path, member in members.items()
        if path.parts[0] == "duckpad"
    ]
    for target, member in sorted(entries, key=lambda entry: len(entry[0].parts)):
        if member.isdir():
            target.mkdir(mode=0o700)
    for target, member in entries:
        if member.isfile():
            with archive.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(member.mode & 0o777)
            os.utime(target, (member.mtime, member.mtime))
    for target, member in entries:
        if member.islnk():
            os.link(staging.joinpath(*_member_path(member.linkname).parts), target)
        elif member.issym():
            target.symlink_to(member.linkname)
    paths = InstancePaths(staging / "duckpad")
    paths.database.chmod(0o600)
    if paths.master_key.is_file() and not paths.master_key.is_symlink():
        paths.master_key.chmod(0o600)
    return paths.home


def _require_empty(home):
    if any(item.name != InstancePaths(home).lock.name for item in home.iterdir()):
        raise BackupError(
            f"Restore destination is not empty: {home}. Move the existing instance aside first."
        )


def restore_backup(source, home=None):
    try:
        with tarfile.open(Path(source).expanduser(), mode="r:gz") as archive:
            manifest, members = _restore_plan(archive)
            saved_version = manifest.get("duckpad_version")
            if saved_version != __version__:
                raise BackupError(
                    f"Backup requires Duckpad {saved_version!r}; installed version is {__version__}. "
                    "Restore with the version that created the backup."
                )
            original = manifest.get("original_home")
            if not isinstance(original, str) or not Path(original).is_absolute():
                raise BackupError("The backup manifest has no absolute original instance path.")
            original = Path(original).resolve()
            home = home.expanduser().resolve() if home is not None else original
            if home != original:
                raise BackupError(
                    f"Restore requires the original instance path: {original}. Moving an instance is not supported."
                )
            with instance_lease(home):
                _require_empty(home)
                # Stage inside the home: same filesystem, even when the home is a mount point.
                with tempfile.TemporaryDirectory(prefix=".duckpad-restore-", dir=home) as directory:
                    restored = _extract(archive, members, Path(directory))
                    database = InstancePaths(restored).database
                    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
                        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                            raise BackupError("The archived database failed its integrity check.")
                    # The database moves last: a home without it holds no restored instance.
                    for item in sorted(restored.iterdir(), key=lambda item: item == database):
                        item.rename(home / item.name)
            return home
    except (tarfile.TarError, EOFError, UnicodeError, ValueError, sqlite3.Error) as error:
        raise BackupError(f"Cannot restore this Duckpad archive: {error}") from None
