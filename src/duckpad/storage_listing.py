"""One level of a storage connection, listed for the file browser.

A folder root is read on the Duckpad server. An S3-compatible prefix is listed through its own API:
DuckDB's `glob` returns files only and walks a whole prefix, so it cannot show the folders of one level.
"""

import heapq
import os
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

from . import s3_listing
from .templates import URI
from .types import Record
from .util import Problem

# Entries returned for one level. A larger level is narrowed by the beginning of a name.
LIMIT = 1000


def folder_path(path: str) -> str:
    """A folder below a root, as `a/b`; an empty string is the root itself."""
    parts = [part for part in path.split("/") if part]
    if "\x00" in path or any(part in (".", "..") for part in parts):
        raise Problem("Choose a folder below the connection root", 422)
    return "/".join(parts)


def level(connection: Record, path: str, prefix: str = "") -> Record:
    """The folders, then the files, of one folder below a captured storage connection's root."""
    path = folder_path(path)
    if "/" in prefix or "\x00" in prefix:
        raise Problem("A name filter cannot contain a path separator", 422)
    root = connection["values"].get("root")
    if not isinstance(root, str) or not root:
        raise Problem(
            f"Connection {connection['name']} has no root in this environment: enter an absolute path", 422
        )
    if not URI.match(root):
        return folder_level(Path(root).expanduser(), path, prefix)
    settings = s3_listing.client_settings(connection["definition"], connection["values"])
    if settings is None:
        raise Problem("Duckpad cannot list this type of storage yet: enter the path of the file", 422)
    return s3_listing.list_level(settings, root, path, prefix, LIMIT)


def folder_level(root: Path, path: str, prefix: str) -> Record:
    base = root.resolve()
    folder = (base / path).resolve()
    # A run refuses what leaves the root, through `..` or a symbolic link: so does the browser.
    if not folder.is_relative_to(base):
        raise Problem("Choose a folder below the connection root", 422)
    if not folder.is_dir():
        raise Problem("This folder does not exist on the Duckpad server", 404)
    start = prefix.casefold()

    def candidates(listing: Iterator[os.DirEntry[str]]) -> Iterator[tuple[bool, str, os.DirEntry[str]]]:
        for entry in listing:
            if entry.name.startswith(".") or not entry.name.casefold().startswith(start):
                continue
            if entry.is_symlink() and not Path(entry.path).resolve().is_relative_to(base):
                continue
            if entry.is_dir() or entry.is_file():
                yield not entry.is_dir(), entry.name, entry

    try:
        with os.scandir(folder) as listing:
            # A folder of a million files keeps its first names only, without sorting them all.
            found = heapq.nsmallest(
                LIMIT + 1, candidates(listing), key=lambda item: (item[0], item[1].casefold(), item[1])
            )
            entries = [entry_record(*item) for item in found[:LIMIT]]
    except OSError as error:
        raise Problem(f"The Duckpad server cannot read this folder: {error.strerror}", 422) from None
    return {"entries": entries, "truncated": len(found) > LIMIT}


def entry_record(file: bool, name: str, entry: os.DirEntry[str]) -> Record:
    if not file:
        return {"name": name, "kind": "folder", "size": None, "modified": None}
    status = entry.stat()
    modified = datetime.fromtimestamp(status.st_mtime, UTC).isoformat(timespec="seconds")
    return {"name": name, "kind": "file", "size": status.st_size, "modified": modified}
