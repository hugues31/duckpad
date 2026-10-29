"""ZIP archives of a project's declarative files, for download and import."""

import io
import json
import re
import zipfile
import zlib
from pathlib import Path

from .bundle import files_to_bundle, is_declarative
from .components import expand
from .engine import connection_references
from .projects import decode
from .templates import URI, base_type
from .util import Problem

MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 10_000
MAX_PROJECT_BYTES = 64 * 1024 * 1024
# flow.json at the root, or inside the single folder added by most ZIP tools and Git hosts.
PROJECT_ROOT = re.compile(r"(?:[^/]+/)?flow\.json")
UNREADABLE = (
    zipfile.BadZipFile,
    zipfile.LargeZipFile,
    NotImplementedError,
    RuntimeError,
    EOFError,
    ValueError,
    OSError,
    zlib.error,
)


def write_archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            archive.writestr(name, content)
    return output.getvalue()


def read_archive(stream):
    """The declarative files of an archived project; Git metadata, data and local files are ignored."""
    data = stream.read(MAX_ARCHIVE_BYTES + 1)
    if len(data) > MAX_ARCHIVE_BYTES:
        raise Problem("Project archives are limited to 16 MiB", 413)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = [entry for entry in archive.infolist() if not entry.is_dir()]
            if len(entries) > MAX_ARCHIVE_ENTRIES:
                raise Problem(f"Project archives are limited to {MAX_ARCHIVE_ENTRIES} files", 413)
            roots = {
                entry.filename.removesuffix("flow.json")
                for entry in entries
                if PROJECT_ROOT.fullmatch(entry.filename)
            }
            prefix = "" if "" in roots else roots.pop() if len(roots) == 1 else None
            if prefix is None:
                raise Problem("The archive must contain one Duckpad project with flow.json at its root", 422)
            files, size = {}, 0
            for entry in entries:
                name = entry.filename.removeprefix(prefix)
                if not entry.filename.startswith(prefix) or not is_declarative(name):
                    continue
                if name in files:
                    raise Problem(f"The archive contains {name} more than once", 422)
                with archive.open(entry) as source:
                    content = source.read(MAX_PROJECT_BYTES - size + 1)
                size += len(content)
                if size > MAX_PROJECT_BYTES:
                    raise Problem("Extracted project files are limited to 64 MiB", 413)
                files[name] = decode(name, content)
    except UNREADABLE as error:
        raise Problem("Choose a readable ZIP archive of a Duckpad project", 422) from error
    return files


def archive_bundle(files):
    """Parse archived files, naming any file that cannot become a project section."""
    files.setdefault("documentation.json", "{}")
    for name, text in files.items():
        if name.endswith(".json"):
            try:
                value = json.loads(text)
            except ValueError as error:
                raise Problem(f"{name} is not valid JSON: {error}", 422) from error
            if not isinstance(value, dict):
                raise Problem(f"{name} must contain a JSON object", 422)
    return files_to_bundle(files)


def import_warnings(bundle, granted):
    """What the archive cannot carry: connections unavailable to the project and absolute input files."""
    try:
        labels = {
            node["id"]: str(node.get("label") or node["id"]) for node in bundle["flow"].get("nodes", [])
        }
        nodes, _, _ = expand(bundle, tolerant=True)
        connections, files = set(), set()
        for node in nodes.values():
            connections.update(r for r in connection_references(node) if isinstance(r, str) and r)
            for parameter in node["parsed"]["parameters"]:
                value = node.get("params", {}).get(parameter["name"], parameter.get("default"))
                if (
                    base_type(parameter["type"]) == "file"
                    and isinstance(value, str)
                    and not URI.match(value)
                    and Path(value).is_absolute()
                ):
                    files.add(labels.get(node["root"], node["root"]))
    except (Problem, KeyError, TypeError, AttributeError, RecursionError):
        # Diagnostics of the imported project already explain malformed definitions.
        return {"connections": [], "files": []}
    return {"connections": sorted(connections - set(granted)), "files": sorted(files)}
