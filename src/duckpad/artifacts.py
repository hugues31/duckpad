"""Private, immutable copies of completed file exports, never client-selected paths."""

import os
import re
import shutil
import stat
from contextlib import contextmanager
from pathlib import Path

from .util import Problem, uid

CHUNK_SIZE = 64 * 1024
MEDIA_TYPES = {
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


@contextmanager
def open_regular(path):
    """Pin a regular file without following symlinks, including parent directories."""
    path = Path(path).absolute()
    if ".." in path.parts:
        raise OSError("Parent traversal is not allowed")
    if os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW"):
        directory = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in path.parts[1:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
            descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        finally:
            os.close(directory)
    else:
        # The artifact directory is private and outside every SQL worker's writable roots.
        # Check reparse points as well on platforms without openat/O_NOFOLLOW.
        for part in [*path.parents, path]:
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise OSError("Links are not allowed")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise OSError("Export is not a regular file")
        yield stream


def signature(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


class Artifacts:
    def __init__(self, store):
        self.store = store
        self.directory = store.home / "artifacts"
        self.directory.mkdir(mode=0o700, exist_ok=True)

    def capture(self, spec, run, node, roots):
        """Copy the actual exported bytes, bounded in memory, before another export can overwrite them."""
        path = Path(spec["path"]).absolute()
        if ".." in path.parts or not any(path.is_relative_to(root) for root in roots):
            raise OSError("Export destination is outside authorized roots")
        identity = uid("artifact_")
        destination = self.directory / identity
        try:
            with open_regular(path) as source, destination.open("xb") as output:
                before = signature(os.fstat(source.fileno()))
                shutil.copyfileobj(source, output, CHUNK_SIZE)
                if signature(os.fstat(source.fileno())) != before:
                    raise OSError("Export changed while being captured")
            filename = re.sub(r"[\x00-\x1f\x7f/\\]", "_", path.name)
            extension = "." + spec["format"]
            if not filename.lower().endswith(extension):
                filename += extension
            record = {
                "id": identity,
                "run": run["id"],
                "project": run["project"],
                "worktree": run["worktree"],
                "environment": run["environment"],
                "node": node,
                "filename": filename,
                "media_type": MEDIA_TYPES[spec["format"]],
                "size": before[2],
                "signature": signature(destination.stat()),
            }
            self.store.put("artifact", identity, record)
            return identity
        except Exception:
            destination.unlink(missing_ok=True)
            raise

    @contextmanager
    def open(self, identity, worktree, environment, node, run):
        record = self.store.get("artifact", identity)
        if (
            not re.fullmatch(r"artifact_[0-9a-f]{16}", identity)
            or not record
            or any(
                record[key] != value
                for key, value in {
                    "worktree": worktree,
                    "environment": environment,
                    "node": node,
                    "run": run,
                }.items()
            )
        ):
            raise Problem("Exported file is unavailable. Run the export again.", 404)
        try:
            with open_regular(self.directory / identity) as stream:
                if signature(os.fstat(stream.fileno())) != record["signature"]:
                    raise OSError("Artifact was replaced")
                yield stream, record
        except OSError as error:
            raise Problem("Exported file is unavailable. Run the export again.", 404) from error
