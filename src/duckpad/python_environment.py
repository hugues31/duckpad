"""Immutable project interpreters with a locked, operator-owned DuckDB runtime."""

import base64
import contextlib
import csv
import hashlib
import importlib.metadata
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import zipfile
from contextvars import ContextVar
from functools import cache
from pathlib import Path
from urllib.parse import urlsplit

import _duckdb
import duckdb
from filelock import FileLock, Timeout

from .python_progress import LOG_LIMIT, Preparation, clean_output, environment_status
from .python_sdk import SDK_CONTRACT
from .util import Problem, atomic_write, digest

logger = logging.getLogger(__name__)

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
    "project_files.py",
    "json_document.py",
    "node_code.py",
    "python_execution.py",
    "partition_filters.py",
    "value_types.py",
)


PREPARATION_CANCEL = ContextVar("preparation_cancel", default=None)


@contextlib.contextmanager
def preparation_cancellation(event):
    """Scope cancellation to this run's preparation, including nested environment setup."""
    token = PREPARATION_CANCEL.set(event)
    try:
        yield
    finally:
        PREPARATION_CANCEL.reset(token)


def canceled():
    event = PREPARATION_CANCEL.get()
    return event is not None and event.is_set()


def check_canceled():
    if canceled():
        raise Problem("Execution canceled", 409)


@contextlib.contextmanager
def preparation_lock(path):
    lock = FileLock(str(path))
    while True:
        check_canceled()
        try:
            lock.acquire(timeout=0.2)
            break
        except Timeout:
            continue
    try:
        check_canceled()
        yield
    finally:
        lock.release()


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


def requirement_name(dependency):
    """The normalized distribution name a requirement string starts with."""
    match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", dependency)
    return re.sub(r"[-_.]+", "-", match[1]).lower() if match else dependency


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
    tables = [project.get("optional-dependencies", {}), manifest.get("dependency-groups", {})]
    if not all(isinstance(table, dict) for table in tables):
        raise Problem("Optional dependencies and dependency groups must be tables of lists", 422)
    lists = [dependencies, *(items for table in tables for items in table.values())]
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
            if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*\s*(?:\[|[<>=!~;]|$)", dependency):
                raise Problem("Dependencies must be named packages from the operator package index", 422)
            name = requirement_name(dependency)
            if name == "duckpad":
                raise Problem(
                    "Remove the Duckpad server dependency: the server supplies the lightweight SDK", 422
                )
            if name == "duckdb" and dependency != f"duckdb=={duckdb.__version__}":
                raise Problem("All DuckDB dependencies must match the server's exact version", 422)
    if uv.get("sources") != {"duckdb": {"path": f".duckpad-runtime/{runtime_tag()}"}}:
        raise Problem(
            "The project's DuckDB source must match this server's runtime: set [tool.uv.sources] to "
            f'duckdb = {{ path = ".duckpad-runtime/{runtime_tag()}" }}; other sources are unsupported',
            422,
        )
    return manifest


# Operator settings uv may need: locale, temporary space, certificates, proxies and indexes.
UV_ENVIRONMENT = {
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "SYSTEMDRIVE",
    "XDG_CONFIG_HOME",
    "XDG_CONFIG_DIRS",
    "TEMP",
    "TMP",
    "UV_DEFAULT_INDEX",
    "UV_EXTRA_INDEX_URL",
    "UV_FIND_LINKS",
    "UV_CACHE_DIR",
    "UV_OFFLINE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
}


PYPI = "https://pypi.org/simple"
PYPI_FILES = "files.pythonhosted.org"


def operator_config_paths():
    """Discover user and first system uv.toml, in uv's precedence order."""
    if sys.platform == "win32":
        user = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        drive = os.environ.get("SYSTEMDRIVE")
        system = [Path(drive + "\\") / "ProgramData" / "uv" / "uv.toml"] if drive else []
    else:
        user = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        if not user.is_absolute():
            user = Path.home() / ".config"
        directories = (os.environ.get("XDG_CONFIG_DIRS") or "/etc/xdg").split(":")
        system = [Path(directory) / "uv" / "uv.toml" for directory in directories if directory]
        system.append(Path("/etc/uv/uv.toml"))
    first = next((path for path in system if path.is_file()), None)
    return [user / "uv" / "uv.toml", *([first] if first else [])]


def operator_config():
    """Merge operator files: user scalars win, and user arrays precede system arrays."""
    settings = {}
    for path in reversed(operator_config_paths()):
        try:
            with path.open("rb") as stream:
                values = tomllib.load(stream)
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            raise Problem(
                "Cannot read operator uv.toml; check its permissions and TOML syntax", 503
            ) from None
        for key, value in values.items():
            settings[key] = value + settings.get(key, []) if isinstance(value, list) else value
    return settings


def operator_sources():
    """Package sources the operator configured; PyPI unless a default index replaces it."""
    names = ("UV_DEFAULT_INDEX", "UV_INDEX_URL", "UV_INDEX", "UV_EXTRA_INDEX_URL", "UV_FIND_LINKS")
    entries = [e for name in names for e in re.split(r"[\s,]+", os.environ.get(name, "")) if e]
    # Named indexes are written `name=url`.
    entries = [re.sub(r"^[\w.-]+=(?=\S)", "", entry) for entry in entries]
    config = operator_config()
    indexes = config.get("index", [])
    entries += [*config.get("extra-index-url", []), *config.get("find-links", [])]
    entries += [index["url"] for index in indexes if "url" in index]
    if config.get("index-url"):
        entries.append(config["index-url"])
    # uv.lock records index URLs without their credentials.
    sources = {re.sub(r"^(\w[\w+.-]*://)[^/@\s]*@", r"\1", entry).rstrip("/") for entry in entries}
    if not (
        os.environ.get("UV_DEFAULT_INDEX")
        or os.environ.get("UV_INDEX_URL")
        or config.get("index-url")
        or any(index.get("default") for index in indexes)
    ):
        sources.add(PYPI)
    return sources


def served(registry, item):
    """Whether a locked file comes from its registry: same host, or inside a find-links directory."""
    if "://" in registry:
        # PyPI's file host also serves mirrors that keep upstream links.
        return urlsplit(item.get("url", "")).netloc in (urlsplit(registry).netloc, PYPI_FILES)
    return "path" in item and Path(registry, item["path"]).resolve().is_relative_to(Path(registry).resolve())


def check_lock_sources(text):
    """Reject a uv.lock whose packages come from outside the runtime wheel and operator indexes."""
    try:
        packages = tomllib.loads(text).get("package", [])
    except (ValueError, TypeError):
        raise Problem("uv.lock is not a valid lock file", 422) from None
    allowed = operator_sources()
    runtime = f".duckpad-runtime/{runtime_tag()}"
    for package in packages:
        name, source = package.get("name"), package.get("source", {})
        if source in ({"virtual": "."}, {"path": runtime}):
            continue
        registry = str(source.get("registry", "")).rstrip("/")
        files = [item for item in [package.get("sdist"), *package.get("wheels", [])] if item]
        if registry in allowed and all(served(registry, item) for item in files):
            continue
        raise Problem(
            f"uv.lock takes {name} from a source the server does not use; "
            "regenerate the lock on an editable branch with the operator's package index",
            422,
        )


def uv_executable():
    """The uv installed with Duckpad, even when its environment is not on PATH."""
    try:
        from uv import find_uv_bin

        return find_uv_bin()
    except (ImportError, FileNotFoundError):
        return shutil.which("uv")


COMMAND_TIMEOUT = 300


def command(arguments, directory, *, allow_builds=False, progress=None):
    check_canceled()
    executable = uv_executable()
    if not executable:
        raise Problem("Python environment setup requires the uv executable on the server", 503)
    environment = {
        k: v
        for k, v in os.environ.items()
        # UV_INDEX also covers named indexes and their UV_INDEX_<NAME>_USERNAME/PASSWORD.
        if k.upper() in UV_ENVIRONMENT or k.startswith("UV_INDEX")
    }
    environment.update(UV_PYTHON_DOWNLOADS="never", UV_LINK_MODE="copy", UV_NO_PROGRESS="1", NO_COLOR="1")
    options = [] if allow_builds else ["--no-build"]
    # Separate file handles avoid pipe deadlocks and keep only a bounded tail in memory.
    with tempfile.TemporaryDirectory() as temporary:
        output = Path(temporary) / "uv.log"
        with (
            output.open("wb") as writer,
            output.open("rb") as reader,
            subprocess.Popen(
                [executable, *arguments, *options],
                cwd=directory,
                env=environment,
                stdout=writer,
                stderr=subprocess.STDOUT,
            ) as process,
        ):
            deadline = time.monotonic() + COMMAND_TIMEOUT
            previous = None
            detail = ""
            try:
                while True:
                    check_canceled()
                    timed_out = process.poll() is None and time.monotonic() >= deadline
                    if timed_out:
                        process.kill()
                        process.wait()
                    with contextlib.suppress(subprocess.TimeoutExpired):
                        process.wait(timeout=0.2)
                    size = reader.seek(0, os.SEEK_END)
                    reader.seek(max(0, size - LOG_LIMIT * 2))
                    raw = reader.read(LOG_LIMIT * 2).decode("utf-8", errors="replace")
                    if size > LOG_LIMIT * 2:
                        # Do not expose fragments of a credential at the truncation boundary.
                        raw = raw.partition("\n")[2]
                    detail = clean_output(raw, directory)[-LOG_LIMIT:]
                    if progress and detail != previous:
                        progress.output(detail, truncated=size > LOG_LIMIT)
                        previous = detail
                    if timed_out:
                        raise Problem("Python environment preparation timed out", 503)
                    if process.returncode is not None:
                        break
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            if process.returncode:
                raise Problem(
                    "Python environment preparation failed (DuckDB is pinned to the server runtime):\n"
                    + detail,
                    422,
                )


def lock_files(files, home, *, read_only=False, allow_builds=False, worktree=None):
    progress = Preparation(home, worktree, "resolving", start=False)
    try:
        locked = cached_lock(files, home, read_only=read_only, allow_builds=allow_builds, progress=progress)
        if not progress.active and worktree and environment_status(home, worktree)["state"] == "error":
            progress.step("cached")
        progress.finish("locked")
        return locked
    except Exception as error:
        if canceled():
            progress.cancel()
        else:
            progress.finish("error", error)
        raise


def cached_lock(files, home, *, read_only=False, allow_builds=False, progress=None):
    validate_manifest(files["pyproject.toml"])
    root = Path(home) / "python" / "locks"
    root.mkdir(parents=True, exist_ok=True)

    def key(lock):
        return digest(
            [files["pyproject.toml"], lock, runtime_signature(), allow_builds, sorted(operator_sources())]
        )

    cached = root / (key(files.get("uv.lock")) + ".json")
    if progress and not cached.exists():
        progress.start()
    with preparation_lock(cached.with_suffix(".lock")):
        if cached.exists():
            locked = json.loads(cached.read_text())["lock"]
            if not read_only or locked == files.get("uv.lock"):
                return locked
        locked = resolve_lock(files, home, read_only=read_only, allow_builds=allow_builds, progress=progress)
        value = json.dumps({"lock": locked})
        atomic_write(cached, value)
        atomic_write(root / (key(locked) + ".json"), value)
        return locked


def resolve_lock(files, home, *, read_only=False, allow_builds=False, progress=None):
    """Resolve in scratch space; tagged worktrees are never written."""
    validate_manifest(files["pyproject.toml"])
    root = Path(home) / "python"
    root.mkdir(parents=True, exist_ok=True)
    if progress:
        progress.step("runtime")
    with preparation_lock(root / "runtime.lock"):
        wheel = runtime_wheel(root / "wheels")
    with tempfile.TemporaryDirectory(dir=root) as temporary:
        directory = Path(temporary)
        (directory / "pyproject.toml").write_bytes(files["pyproject.toml"].encode("utf-8"))
        (directory / "README.md").write_bytes(files.get("README.md", "").encode("utf-8"))
        (directory / ".duckpad-runtime").mkdir()
        shutil.copyfile(wheel, directory / ".duckpad-runtime" / wheel.name)
        previous = files.get("uv.lock")
        if previous and "<<<<<<<" not in previous:
            try:
                check_lock_sources(previous)
            except Problem:
                if read_only:
                    raise
                # Like a conflicted lock, a foreign one is resolved again from the manifest.
                previous = None
        if previous and "<<<<<<<" not in previous:
            (directory / "uv.lock").write_bytes(previous.encode("utf-8"))
        elif read_only:
            raise Problem(
                "This tagged Python project needs a valid uv.lock; update and tag its editable branch", 422
            )
        if progress:
            progress.step("resolving")
        command(
            ["lock", "--python", sys.executable, *(["--locked"] if read_only else [])],
            directory,
            allow_builds=allow_builds,
            progress=progress,
        )
        locked = (directory / "uv.lock").read_bytes().decode("utf-8")
        check_lock_sources(locked)
        return locked


def prepare(files, home, project, *, allow_builds=False, worktree=None):
    progress = Preparation(home, worktree, "installing", start=False)
    try:
        result = prepare_environment(files, home, project, allow_builds=allow_builds, progress=progress)
        # A cached environment starts no preparation; it only replaces a settled state other than ready.
        if (
            not progress.active
            and worktree
            and environment_status(home, worktree)["state"] in ("unprepared", "locked", "error")
        ):
            progress.step("cached")
        progress.finish("ready")
        try:
            prune_environments(Path(home) / "python")
        except Exception:  # Housekeeping must not fail a prepared run.
            logger.warning("Python environment cleanup failed", exc_info=True)
        return result
    except Exception as error:
        if canceled():
            progress.cancel()
        else:
            progress.finish("error", error)
        raise


UNUSED = 7 * 86400


def prune_environments(root):
    """Keep active workers and recently used environments; cleanup never fails a run."""
    from filelock import Timeout

    def stale(path, age=UNUSED):
        try:
            return time.time() - path.stat().st_mtime >= age
        except FileNotFoundError:
            return False

    for directory in root.iterdir():
        if not directory.is_dir() or directory.name in ("wheels", "locks", "status"):
            continue
        marker = directory / "ready.json"
        # An unfinished preparation older than a day was interrupted; a running one holds the lock.
        if not (stale(marker) if marker.exists() else len(directory.name) == 64 and stale(directory, 86400)):
            continue
        try:
            with FileLock(str(directory) + ".lock", timeout=0):
                active = False
                for path in root.glob(directory.name + ".lease.*"):
                    try:
                        with FileLock(str(path), timeout=0):
                            pass
                        path.unlink(missing_ok=True)
                    except Timeout:
                        active = True
                if not active and (not marker.exists() or stale(marker)):
                    shutil.rmtree(directory)
        except (Timeout, FileNotFoundError):
            continue
        except OSError as error:
            logger.warning("Could not remove unused Python environment %s: %s", directory.name, error)
    for lock in root.glob("*.lock"):
        if len(lock.stem) == 64 and not (root / lock.stem).exists() and stale(lock, 86400):
            lock.unlink(missing_ok=True)
    current = runtime_signature()[:16]
    for wheels in (root / "wheels").glob("*"):
        if wheels.is_dir() and wheels.name != current and stale(wheels):
            try:
                with FileLock(str(root / "runtime.lock"), timeout=0):
                    shutil.rmtree(wheels)
            except Timeout:
                continue
            except OSError as error:
                logger.warning("Could not remove an old Python runtime wheel: %s", error)


def prepare_environment(files, home, project, *, allow_builds=False, progress=None):
    validate_manifest(files["pyproject.toml"])
    if not files.get("uv.lock"):
        raise Problem("Save the Python project to generate uv.lock before execution", 422)
    check_lock_sources(files["uv.lock"])
    root = Path(home) / "python"
    root.mkdir(parents=True, exist_ok=True)
    signature = digest([project, files["pyproject.toml"], files["uv.lock"], runtime_signature()])
    directory = root / signature
    if progress and not (directory / "ready.json").exists():
        progress.start()
    with preparation_lock(root / (signature + ".lock")):
        if not (directory / "ready.json").exists():
            if progress:
                progress.step("runtime")
            shutil.rmtree(directory, ignore_errors=True)
            directory.mkdir()
            try:
                (directory / "pyproject.toml").write_bytes(files["pyproject.toml"].encode("utf-8"))
                (directory / "uv.lock").write_bytes(files["uv.lock"].encode("utf-8"))
                (directory / "README.md").write_bytes(files.get("README.md", "").encode("utf-8"))
                with preparation_lock(root / "runtime.lock"):
                    wheel = runtime_wheel(root / "wheels")
                (directory / ".duckpad-runtime").mkdir()
                shutil.copyfile(wheel, directory / ".duckpad-runtime" / wheel.name)
                if progress:
                    progress.step("installing")
                command(
                    ["sync", "--locked", "--no-install-project", "--python", sys.executable],
                    directory,
                    allow_builds=allow_builds,
                    progress=progress,
                )
                if progress:
                    progress.step("sdk")
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
                check_canceled()
                atomic_write(directory / "ready.json", json.dumps({"signature": signature}))
            except BaseException:
                shutil.rmtree(directory, ignore_errors=True)
                raise
        elif progress and progress.active:
            progress.step("cached")
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
    }
