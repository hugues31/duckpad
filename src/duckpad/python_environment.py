"""Immutable project interpreters with a locked, operator-owned DuckDB runtime."""

import base64
import csv
import hashlib
import importlib.metadata
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import zipfile
from functools import cache
from pathlib import Path

import _duckdb
import duckdb
from filelock import FileLock

from .python_sdk import SDK_CONTRACT
from .util import Problem, atomic_write, digest

MODULES = (
    "python_sdk.py",
    "python_contract.py",
    "sql_worker.py",
    "worker_bootstrap.py",
    "worker_policy.py",
    "worker_connections.py",
    "native.py",
    "types.py",
    "util.py",
    "extensions.py",
    "project_extensions.py",
    "python_execution.py",
    "python_partitions.py",
)


def runtime_tag():
    distribution = importlib.metadata.distribution("duckdb")
    wheel = distribution.read_text("WHEEL") or ""
    tag = next(line.split(": ", 1)[1] for line in wheel.splitlines() if line.startswith("Tag: "))
    return f"duckdb-{duckdb.__version__}-{tag}.whl"


def manifest_settings():
    return (
        f"\n[tool.duckpad]\nsdk-contract = {SDK_CONTRACT}\n"
        f'\n[tool.uv.sources]\nduckdb = {{ path = ".duckpad-runtime/{runtime_tag()}" }}\n'
    )


@cache
def runtime_signature():
    root = Path(__file__).parent
    return digest(
        [
            SDK_CONTRACT,
            sys.version,
            duckdb.__version__,
            hashlib.sha256(Path(_duckdb.__file__).read_bytes()).hexdigest(),
            [(name, (root / name).read_text()) for name in MODULES],
        ]
    )


def runtime_wheel(directory):
    """Reuse an operator wheel, or package the already installed operator binary unchanged."""
    directory = directory / runtime_signature()[:16]
    target = directory / runtime_tag()
    if target.exists():
        return target
    directory.mkdir(parents=True, exist_ok=True)
    supplied = os.environ.get("DUCKPAD_RUNTIME_WHEEL")
    if supplied:
        if Path(supplied).name != target.name:
            raise Problem("DUCKPAD_RUNTIME_WHEEL must match the server's DuckDB version and ABI", 503)
        with zipfile.ZipFile(supplied) as archive:
            binary = Path(_duckdb.__file__).name
            if (
                binary not in archive.namelist()
                or hashlib.sha256(archive.read(binary)).digest()
                != hashlib.sha256(Path(_duckdb.__file__).read_bytes()).digest()
            ):
                raise Problem("DUCKPAD_RUNTIME_WHEEL must contain the exact installed DuckDB binary", 503)
        shutil.copyfile(supplied, target)
        return target
    distribution = importlib.metadata.distribution("duckdb")
    records = []
    record_name = None
    with zipfile.ZipFile(target.with_suffix(".tmp"), "w", zipfile.ZIP_DEFLATED) as archive:
        for item in sorted(distribution.files or []):
            name = str(item).replace("\\", "/")
            if name.endswith(".dist-info/RECORD"):
                record_name = name
                continue
            if (
                name.startswith("../")
                or "__pycache__" in name
                or name.endswith((".pyc", "/INSTALLER", "/direct_url.json"))
            ):
                continue
            data = Path(str(distribution.locate_file(item))).read_bytes()
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
            checksum = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            records.append((name, "sha256=" + checksum, len(data)))
        if record_name is None:
            raise Problem("The server DuckDB installation has no wheel RECORD", 503)
        output = io.StringIO()
        csv.writer(output).writerows([*records, (record_name, "", "")])
        archive.writestr(zipfile.ZipInfo(record_name, (2020, 1, 1, 0, 0, 0)), output.getvalue())
    target.with_suffix(".tmp").replace(target)
    return target


def validate_manifest(text):
    try:
        manifest = tomllib.loads(text)
    except (ValueError, TypeError) as error:
        raise Problem(f"Invalid Python project manifest: {error}", 422) from None
    if manifest.get("tool", {}).get("duckpad", {}).get("sdk-contract") != SDK_CONTRACT:
        raise Problem(
            f"This server requires Duckpad SDK contract {SDK_CONTRACT}; update the project manifest", 422
        )
    project = manifest.get("project", {})
    dependencies = project.get("dependencies", [])
    if f"duckdb=={duckdb.__version__}" not in dependencies:
        raise Problem(
            f"Project dependencies must pin duckdb=={duckdb.__version__}, matching the server runtime", 422
        )
    uv = manifest.get("tool", {}).get("uv", {})
    if uv.get("package") is not False or "build-system" in manifest:
        raise Problem("Python flows must set tool.uv.package=false and must not declare a build system", 422)
    if set(uv) - {"package", "sources"}:
        raise Problem(
            "Only tool.uv.package and the server DuckDB source are allowed; indexes and cache settings belong to the operator",
            422,
        )
    if project.get("dynamic"):
        raise Problem("Python project dependency declarations must be static", 422)
    lists = [
        dependencies,
        *project.get("optional-dependencies", {}).values(),
        *manifest.get("dependency-groups", {}).values(),
    ]
    for items in lists:
        if not isinstance(items, list):
            raise Problem("Python dependencies must be lists", 422)
        for dependency in items:
            if isinstance(dependency, dict) and set(dependency) == {"include-group"}:
                continue
            if (
                not isinstance(dependency, str)
                or "@" in dependency
                or "://" in dependency
                or "\\" in dependency
            ):
                raise Problem(
                    "Direct dependency URLs and local paths are unsupported; use the operator package index",
                    422,
                )
            match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[|[<>=!~;]|$)", dependency)
            if not match:
                raise Problem("Dependencies must be named packages from the operator package index", 422)
            name = re.sub(r"[-_.]+", "-", match[1]).lower()
            if name == "duckpad":
                raise Problem(
                    "Remove the Duckpad server dependency: the server supplies the lightweight SDK", 422
                )
            if name == "duckdb" and dependency != f"duckdb=={duckdb.__version__}":
                raise Problem("All DuckDB dependencies must match the server's exact version", 422)
    if uv.get("sources") != {"duckdb": {"path": f".duckpad-runtime/{runtime_tag()}"}}:
        raise Problem(
            "The project's DuckDB source must match the operator runtime; other sources are unsupported", 422
        )
    return manifest


def command(arguments, directory, *, allow_builds=False):
    executable = shutil.which("uv")
    if not executable:
        raise Problem("Python environment setup requires the uv executable on the server", 503)
    environment = {
        k: v
        for k, v in os.environ.items()
        if k
        in (
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "LANG",
            "LC_ALL",
            "HOME",
            "TEMP",
            "TMP",
            "UV_INDEX",
            "UV_DEFAULT_INDEX",
            "UV_FIND_LINKS",
            "UV_CACHE_DIR",
            "UV_OFFLINE",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        )
    }
    environment.update(UV_PYTHON_DOWNLOADS="never", UV_LINK_MODE="copy")
    options = [] if allow_builds else ["--no-build"]
    try:
        result = subprocess.run(
            [executable, "--no-config", *arguments, *options],
            cwd=directory,
            env=environment,
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        raise Problem("Python environment preparation timed out", 503) from None
    if result.returncode:
        detail = result.stderr[-8000:].replace(str(directory), "<project>")
        detail = re.sub(r"(https?://)[^/@\s]+@", r"\1<redacted>@", detail)
        raise Problem(
            "Python environment preparation failed (DuckDB is pinned to the server runtime):\n" + detail, 422
        )


def environment_status(home, project):
    path = Path(home) / "python" / "status" / (project + ".json")
    status = json.loads(path.read_text()) if path.exists() else {"state": "unprepared"}
    return {**status, "python": sys.version.split()[0], "duckdb": duckdb.__version__}


def set_status(home, project, state, error=None):
    if project:
        atomic_write(
            Path(home) / "python" / "status" / (project + ".json"),
            json.dumps(
                {
                    "state": state,
                    "error": str(error).replace(str(home), "<instance>") if error else None,
                }
            ),
        )


def lock_files(files, home, *, read_only=False, allow_builds=False, project=None):
    try:
        return cached_lock(files, home, read_only=read_only, allow_builds=allow_builds, project=project)
    except Exception as error:
        set_status(home, project, "error", error)
        raise


def cached_lock(files, home, *, read_only=False, allow_builds=False, project=None):
    validate_manifest(files["pyproject.toml"])
    root = Path(home) / "python" / "locks"
    root.mkdir(parents=True, exist_ok=True)

    def key(lock):
        return digest([files["pyproject.toml"], lock, runtime_signature(), allow_builds])

    cached = root / (key(files.get("uv.lock")) + ".json")
    with FileLock(str(cached.with_suffix(".lock"))):
        if cached.exists():
            locked = json.loads(cached.read_text())["lock"]
            if not read_only or locked == files.get("uv.lock"):
                return locked
        set_status(home, project, "resolving")
        locked = resolve_lock(files, home, read_only=read_only, allow_builds=allow_builds)
        set_status(home, project, "locked")
        value = json.dumps({"lock": locked})
        atomic_write(cached, value)
        atomic_write(root / (key(locked) + ".json"), value)
        return locked


def resolve_lock(files, home, *, read_only=False, allow_builds=False):
    """Resolve in scratch space; tagged worktrees are never written."""
    validate_manifest(files["pyproject.toml"])
    root = Path(home) / "python"
    root.mkdir(parents=True, exist_ok=True)
    with FileLock(str(root / "runtime.lock")):
        wheel = runtime_wheel(root / "wheels")
    with tempfile.TemporaryDirectory(dir=root) as temporary:
        directory = Path(temporary)
        (directory / "pyproject.toml").write_bytes(files["pyproject.toml"].encode("utf-8"))
        (directory / "README.md").write_bytes(files.get("README.md", "").encode("utf-8"))
        (directory / ".duckpad-runtime").mkdir()
        shutil.copyfile(wheel, directory / ".duckpad-runtime" / wheel.name)
        if files.get("uv.lock") and "<<<<<<<" not in files["uv.lock"]:
            (directory / "uv.lock").write_bytes(files["uv.lock"].encode("utf-8"))
        elif read_only:
            raise Problem(
                "This tagged Python project needs a valid uv.lock; update and tag its editable branch", 422
            )
        command(
            ["lock", "--python", sys.executable, *(["--locked"] if read_only else [])],
            directory,
            allow_builds=allow_builds,
        )
        return (directory / "uv.lock").read_bytes().decode("utf-8")


def prepare(files, home, project, *, allow_builds=False):
    try:
        result = prepare_environment(files, home, project, allow_builds=allow_builds)
        set_status(home, project, "ready")
        prune_environments(Path(home) / "python")
        return result
    except Exception as error:
        set_status(home, project, "error", error)
        raise


def prune_environments(root):
    """Keep active workers and recently used immutable environments."""
    from filelock import Timeout

    for marker in root.glob("*/ready.json"):
        if time.time() - marker.stat().st_mtime < 7 * 86400:
            continue
        try:
            with FileLock(str(marker.parent) + ".lock", timeout=0):
                active = False
                for path in root.glob(marker.parent.name + ".lease.*"):
                    try:
                        with FileLock(str(path), timeout=0):
                            pass
                        path.unlink(missing_ok=True)
                    except Timeout:
                        active = True
                if not active and marker.exists() and time.time() - marker.stat().st_mtime >= 7 * 86400:
                    shutil.rmtree(marker.parent)
        except (Timeout, FileNotFoundError):
            continue


def prepare_environment(files, home, project, *, allow_builds=False):
    validate_manifest(files["pyproject.toml"])
    if not files.get("uv.lock"):
        raise Problem("Save the Python project to generate uv.lock before execution", 422)
    root = Path(home) / "python"
    root.mkdir(parents=True, exist_ok=True)
    signature = digest([project, files["pyproject.toml"], files["uv.lock"], runtime_signature()])
    directory = root / signature
    with FileLock(str(root / (signature + ".lock"))):
        if not (directory / "ready.json").exists():
            set_status(home, project, "installing")
            shutil.rmtree(directory, ignore_errors=True)
            directory.mkdir()
            try:
                (directory / "pyproject.toml").write_bytes(files["pyproject.toml"].encode("utf-8"))
                (directory / "uv.lock").write_bytes(files["uv.lock"].encode("utf-8"))
                (directory / "README.md").write_bytes(files.get("README.md", "").encode("utf-8"))
                with FileLock(str(root / "runtime.lock")):
                    wheel = runtime_wheel(root / "wheels")
                (directory / ".duckpad-runtime").mkdir()
                shutil.copyfile(wheel, directory / ".duckpad-runtime" / wheel.name)
                command(
                    ["sync", "--locked", "--no-install-project", "--python", sys.executable],
                    directory,
                    allow_builds=allow_builds,
                )
                package = directory / "sdk" / "duckpad"
                package.mkdir(parents=True)
                for name in MODULES:
                    shutil.copyfile(Path(__file__).with_name(name), package / name)
                (package / "__init__.py").write_text("from .python_sdk import *\n")
                site = (
                    directory
                    / ".venv"
                    / (
                        "Lib/site-packages"
                        if os.name == "nt"
                        else f"lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages"
                    )
                )
                shutil.copytree(package, site / "duckpad")
                atomic_write(directory / "ready.json", json.dumps({"signature": signature}))
            except BaseException:
                shutil.rmtree(directory, ignore_errors=True)
                raise
        (directory / "ready.json").touch()
    interpreter = directory / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    site = (
        directory
        / ".venv"
        / (
            "Lib/site-packages"
            if os.name == "nt"
            else f"lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages"
        )
    )
    return {
        "lease": str(directory) + ".lease",
        "interpreter": str(interpreter),
        "site_packages": str(site),
        "worker": str(directory / "sdk/duckpad/worker_bootstrap.py"),
        "fingerprint": signature,
    }
