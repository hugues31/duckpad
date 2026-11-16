"""Import target-platform binaries locally, using DuckDB's own signature checks."""

import gzip
import hashlib
import io
import json
import re
import shutil
import zlib
from functools import cache
from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb

from .util import Problem, literal, qi, uid

MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_BINARY_BYTES = 256 * 1024 * 1024
SOURCES = {"core", "community", "unsigned"}
NAME = re.compile(r"([a-z][a-z0-9_]{0,63})\.duckdb_extension(\.gz)?")


@cache
def runtime():
    with duckdb.connect(config={"threads": 1}) as db:
        version = db.execute("PRAGMA version").fetchone()
        platform = db.execute("PRAGMA platform").fetchone()
        assert version is not None and platform is not None
        return version[0], platform[0]


@cache
def core_catalog():
    """List the core extensions this DuckDB build knows about, without contacting a repository."""
    with (
        TemporaryDirectory() as empty,
        duckdb.connect(config={"extension_directory": empty, "threads": 1}) as db,
    ):
        rows = db.execute(
            "SELECT extension_name, description, aliases, install_mode = 'STATICALLY_LINKED' "
            "FROM duckdb_extensions() ORDER BY extension_name"
        ).fetchall()
    return [
        {"name": name, "description": description or "", "aliases": aliases, "built_in": built_in}
        for name, description, aliases, built_in in rows
    ]


def database_config(directory):
    return {
        "extension_directory": str(directory),
        "extension_repository_directory": str(directory / "repository-definitions"),
    }


def register(db, name, directory):
    db.execute("SET allow_extension_repositories = 'allowed'")
    db.execute(f"CREATE EXTENSION REPOSITORY {qi(name)} WITH PREFIX {literal(str(directory))}")


def write_keys(directory, source):
    # Pin the official DuckDB 2.0 trust roots; never trust keys supplied with an upload.
    keys = json.loads(Path(__file__).with_name("extension_keys.json").read_text())
    manifest = directory / ".well-known" / "duckdb-extension-repo.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps({"signature_keys": keys["core" if source == "unsigned" else source]}))


def install(directory, filename, source, stream, allow_unsigned, before_publish):
    """Validate in a temporary cache without LOAD; publish only after checks pass."""
    match = NAME.fullmatch(filename or "")
    if not match:
        raise Problem("Choose a file named <extension>.duckdb_extension or <extension>.duckdb_extension.gz")
    if source not in SOURCES:
        raise Problem("Choose a core, community or unsigned extension source")
    if source == "unsigned" and not allow_unsigned:
        raise Problem("Enable unsigned extensions before importing an unsigned build")
    name = match[1]
    data = stream.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise Problem("Extension uploads must be at most 64 MiB", 413)
    version, platform = runtime()
    repository = uid("duckpad_upload_")
    directory.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".import-", dir=directory) as temporary:
        stage = Path(temporary)
        repository_source = stage / "source"
        write_keys(repository_source, source)
        binary = repository_source / version / platform / (name + ".duckdb_extension.gz")
        binary.parent.mkdir(parents=True)
        digest = hashlib.sha256()
        size = 0
        try:
            raw = io.BytesIO(data)
            with gzip.GzipFile(fileobj=raw) if match[2] else raw as reader, gzip.open(binary, "wb") as writer:
                while chunk := reader.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_BINARY_BYTES:
                        raise Problem("Uncompressed extensions must be at most 256 MiB", 413)
                    digest.update(chunk)
                    writer.write(chunk)
        except (OSError, EOFError, zlib.error) as error:
            raise Problem("The compressed extension file is invalid or incomplete") from error
        try:
            with duckdb.connect(
                config={
                    **database_config(stage / "cache"),
                    "allow_unsigned_extensions": source == "unsigned",
                    "threads": 1,
                }
            ) as db:
                register(db, repository, repository_source)
                db.execute(f"INSTALL {qi(name)} FROM {qi(repository)}")
        except duckdb.Error as error:
            raise Problem("Cannot import extension: " + str(error).replace(str(stage), "<upload>")) from None

        # A new repository name keeps an unsuccessful replacement from damaging an existing import.
        before_publish()
        relative = Path(version) / platform / "repositories" / repository
        destination = directory / relative
        definition = directory / "repository-definitions" / (repository + ".duckdb_extension.repo.json")
        try:
            keys = directory / "offline-keys" / source
            write_keys(keys, source)
            with duckdb.connect(config={**database_config(directory), "threads": 1}) as db:
                register(db, repository, keys)
            destination.parent.mkdir(parents=True, exist_ok=True)
            (stage / "cache" / relative).rename(destination)
        except Exception:
            shutil.rmtree(destination, ignore_errors=True)
            definition.unlink(missing_ok=True)
            raise
    return {
        "name": name,
        "source": source,
        "repository": repository,
        "version": version,
        "platform": platform,
        "sha256": digest.hexdigest(),
    }
