"""Project manifests, locked dependency resolution and the environment lifecycle."""

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from helpers import wait_run
from test_python_nodes import flow

from duckpad.bundle import default_pyproject
from duckpad.python_environment import validate_manifest
from duckpad.util import Problem


@pytest.mark.parametrize(
    "setting",
    [
        'cache-dir = "/unapproved"',
        'find-links = ["file:///unapproved"]',
        'index = [{url = "https://unapproved.invalid/simple"}]',
        'override-dependencies = ["duckdb==0.1"]',
    ],
)
def test_manifest_cannot_configure_the_operator_resolver(setting):
    source = default_pyproject("Review").replace("package = false", "package = false\n" + setting)
    with pytest.raises(Problem, match=r"Only tool\.uv"):
        validate_manifest(source)


@pytest.mark.parametrize("table", ["project.optional-dependencies", "dependency-groups"])
@pytest.mark.parametrize(
    "dependency", ["duckpad", "duckpad[server]>=1", "helper @ file:///private", "duckdb>=1"]
)
def test_all_dependency_lists_enforce_the_runtime_policy(table, dependency):
    with pytest.raises(Problem):
        validate_manifest(default_pyproject("Review") + f'\n[{table}]\nextra = ["{dependency}"]\n')


def test_environment_resolution_preserves_windows_bytes(tmp_path, monkeypatch):
    from duckpad import python_environment as environment

    source = default_pyproject("Review").replace("\n", "\r\n")
    lock = "version = 1\r\nrevision = 3\r\n"
    wheel = tmp_path / "runtime.whl"
    wheel.write_bytes(b"runtime")
    monkeypatch.setattr(environment, "runtime_wheel", lambda _: wheel)

    def command(arguments, directory, **options):
        assert (directory / "pyproject.toml").read_bytes() == source.encode()
        assert (directory / "uv.lock").read_bytes() == lock.encode()

    monkeypatch.setattr(environment, "command", command)
    assert environment.resolve_lock({"pyproject.toml": source, "uv.lock": lock}, tmp_path) == lock


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_project_manifest_writes_preserve_existing_newlines(tmp_path, newline):
    from duckpad.util import atomic_write

    path = tmp_path / "pyproject.toml"
    source = default_pyproject("Review").replace("\n", newline)
    for _ in range(3):
        atomic_write(path, source)
        assert path.read_bytes() == source.encode("utf-8")
        source = path.read_bytes().decode("utf-8")
        validate_manifest(source)


def test_resolver_uses_only_operator_configuration_and_wheels(tmp_path, monkeypatch):
    from duckpad import python_environment as environment

    observed = []

    popen = subprocess.Popen

    def run(arguments, **options):
        observed.append((arguments, options))
        return popen([sys.executable, "-c", "pass"], **options)

    monkeypatch.setattr(environment.subprocess, "Popen", run)
    monkeypatch.setenv("UV_CONFIG_FILE", "/unapproved/config.toml")
    monkeypatch.setenv("UV_NO_CONFIG", "true")
    monkeypatch.setenv("UV_NO_BUILD", "false")
    for name in ("XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "APPDATA", "SYSTEMDRIVE", "USERPROFILE"):
        monkeypatch.setenv(name, str(tmp_path))
    environment.command(["sync", "--locked"], tmp_path)
    arguments, options = observed[0]
    assert "--no-config" not in arguments and "--no-build" in arguments
    assert "UV_CONFIG_FILE" not in options["env"] and "UV_NO_BUILD" not in options["env"]
    assert "UV_NO_CONFIG" not in options["env"]
    for name in ("XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "APPDATA", "SYSTEMDRIVE", "USERPROFILE"):
        assert options["env"][name] == str(tmp_path)
    assert options["env"]["UV_PYTHON_DOWNLOADS"] == "never"
    assert options["env"]["UV_LINK_MODE"] == "copy"


def test_sql_only_launch_never_resolves_python_dependencies(services, monkeypatch):
    from duckpad import python_environment as environment

    store, _, _, engine = services
    tree = flow(services)

    def forbidden(*args, **kwargs):
        pytest.fail("SQL-only execution must not prepare Python")

    monkeypatch.setattr(environment, "lock_files", forbidden)
    monkeypatch.setattr(environment, "prepare", forbidden)
    assert wait_run(store, engine.launch(tree["id"], "dev", "source"))["status"] == "success"


def test_same_environment_supports_two_live_workers(services):
    store, _, _, engine = services
    tree = flow(services)
    for environment in ("dev", "prod"):
        run = wait_run(store, engine.launch(tree["id"], environment), timeout=30)
        assert run["status"] == "success", run["nodes"]
    assert (
        engine.context(tree["id"], "dev").db.process.pid != engine.context(tree["id"], "prod").db.process.pid
    )


def test_environment_cleanup_preserves_active_leases(tmp_path):
    from filelock import FileLock

    from duckpad.python_environment import prune_environments

    directory = tmp_path / "environment"
    directory.mkdir()
    marker = directory / "ready.json"
    marker.write_text("{}")
    os.utime(marker, (0, 0))
    with FileLock(str(directory) + ".lease.worker"):
        prune_environments(tmp_path)
        assert directory.exists()
    prune_environments(tmp_path)
    assert not directory.exists()


def test_environment_cleanup_errors_and_leftovers(tmp_path, monkeypatch):
    import shutil

    from duckpad import python_environment

    old = time.time() - 8 * 86400
    unused = tmp_path / "unused"
    (unused / "ready.json").parent.mkdir()
    (unused / "ready.json").write_text("{}")
    os.utime(unused / "ready.json", (old, old))
    interrupted = tmp_path / ("a" * 64)
    interrupted.mkdir()
    os.utime(interrupted, (old, old))
    (tmp_path / ("b" * 64 + ".lock")).write_text("")
    os.utime(tmp_path / ("b" * 64 + ".lock"), (old, old))
    wheels = tmp_path / "wheels" / "0123456789abcdef"
    wheels.mkdir(parents=True)
    os.utime(wheels, (old, old))
    real = shutil.rmtree

    def refuse(path, *args, **kwargs):
        if Path(path) == unused:
            raise PermissionError("busy")
        return real(path, *args, **kwargs)

    monkeypatch.setattr(python_environment.shutil, "rmtree", refuse)
    python_environment.prune_environments(tmp_path)
    assert unused.exists()
    assert not interrupted.exists() and not wheels.exists()
    assert not (tmp_path / ("b" * 64 + ".lock")).exists()


def test_unrelated_save_merges_a_concurrent_dependency_change(services):
    _, projects, _, _ = services
    tree = flow(services)
    base = projects.snapshot(tree["id"])
    files = base["files"]
    edited = files["pyproject.toml"].replace('version = "0.1.0"', 'version = "0.1.1"')
    assert edited != files["pyproject.toml"]
    changed = projects.write(tree["id"], base["revision"], {**files, "pyproject.toml": edited})
    saved = projects.write(tree["id"], base["revision"], {**files, "README.md": "Unrelated edit\n"})
    assert saved["files"]["README.md"] == "Unrelated edit\n"
    assert saved["files"]["pyproject.toml"] == edited
    assert saved["files"]["uv.lock"] == changed["files"]["uv.lock"]
    both = files["pyproject.toml"].replace('version = "0.1.0"', 'version = "0.2.0"')
    # Editing the manifest on both sides still needs a reviewed resolution.
    with pytest.raises(Problem) as refused:
        projects.write(tree["id"], base["revision"], {**files, "pyproject.toml": both})
    assert refused.value.status == 409


def test_dependency_resolution_does_not_hold_repository_lock(services, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    from duckpad import python_environment

    _, projects, _, _ = services
    tree = flow(services)
    snapshot = projects.snapshot(tree["id"])
    resolve = python_environment.lock_files

    def resolve_while_readable(*args, **kwargs):
        with ThreadPoolExecutor(1) as executor:
            assert executor.submit(projects.snapshot, tree["id"]).result(timeout=2)["revision"]
        return resolve(*args, **kwargs)

    monkeypatch.setattr(python_environment, "lock_files", resolve_while_readable)
    projects.write(
        tree["id"], snapshot["revision"], {**snapshot["files"], "README.md": "Updated description\n"}
    )


LOCK = """version = 1
revision = 3

[[package]]
name = "pytz"
version = "2024.1"
source = {{ registry = '{registry}' }}
wheels = [{{ {file}, hash = "sha256:00" }}]
"""


def lock(registry="https://pypi.org/simple", file="url = 'https://files.pythonhosted.org/packages/pytz.whl'"):
    return LOCK.format(registry=registry, file=file)


@pytest.mark.parametrize(
    "foreign",
    [
        lock("http://127.0.0.1:9/simple", "url = 'http://127.0.0.1:9/pytz.whl'"),
        lock(file="url = 'http://127.0.0.1:9/pytz.whl'"),
        lock(file="path = '/srv/elsewhere/pytz.whl'"),
    ],
)
def test_locks_only_take_packages_from_operator_sources(tmp_path, monkeypatch, foreign):
    from duckpad import python_environment as environment

    manifest = default_pyproject("Review")
    wheel = tmp_path / "runtime.whl"
    wheel.write_bytes(b"runtime")
    monkeypatch.setattr(environment, "runtime_wheel", lambda _: wheel)
    monkeypatch.setattr(environment, "command", lambda *args, **kwargs: pytest.fail("uv must not run"))
    files = {"pyproject.toml": manifest, "uv.lock": foreign}
    with pytest.raises(Problem, match="source the server does not use"):
        environment.resolve_lock(files, tmp_path, read_only=True)
    with pytest.raises(Problem, match="source the server does not use"):
        environment.prepare_environment(files, tmp_path, "project")

    def command(arguments, directory, **options):
        # An editable branch resolves a foreign lock again from its manifest.
        assert not (directory / "uv.lock").exists()
        (directory / "uv.lock").write_bytes(lock().encode())

    monkeypatch.setattr(environment, "command", command)
    assert environment.resolve_lock(files, tmp_path) == lock()


def test_operator_indexes_replace_pypi_in_locks(tmp_path, monkeypatch):
    from duckpad.python_environment import check_lock_sources

    monkeypatch.setenv("UV_DEFAULT_INDEX", "https://mirror.example/simple/")
    monkeypatch.setenv("UV_FIND_LINKS", f"{tmp_path},https://wheels.example/")
    with pytest.raises(Problem):
        check_lock_sources(lock())
    # Literal TOML strings keep Windows paths intact.
    check_lock_sources(lock("https://mirror.example/simple", "url = 'https://mirror.example/files/pytz.whl'"))
    check_lock_sources(lock(str(tmp_path), f"path = '{tmp_path / 'pytz.whl'}'"))
    check_lock_sources(lock("https://wheels.example", "url = 'https://wheels.example/pytz.whl'"))


def test_manifest_from_another_runtime_blocks_runs_but_not_unrelated_saves(services):
    from duckpad.bundle import bundle_to_files
    from duckpad.python_environment import runtime_tag

    store, projects, _, engine = services
    tree = flow(services)
    project = tree["project"]
    snapshot = projects.snapshot(tree["id"])
    other = runtime_tag().rsplit("-", 3)[0] + "-cp312-abi3-other_platform.whl"
    # A pull from another platform's Duckpad, or a server upgrade, leaves another runtime's manifest.
    store.put("settings", "python:" + project, {"enabled": False})
    foreign = snapshot["files"]["pyproject.toml"].replace(runtime_tag(), other)
    snapshot = projects.write(
        tree["id"], snapshot["revision"], {**snapshot["files"], "pyproject.toml": foreign}
    )
    store.put("settings", "python:" + project, {"enabled": True})
    bundle = snapshot["bundle"]
    bundle["templates"]["total"] += "\n-- unrelated edit"
    snapshot = projects.write(tree["id"], snapshot["revision"], bundle_to_files(bundle))
    with pytest.raises(Problem, match=f'path = ".duckpad-runtime/{runtime_tag()}"'):
        engine.launch(tree["id"], "dev")
    # Editing the manifest still validates it at save time.
    with pytest.raises(Problem, match="must match this server's runtime"):
        projects.write(
            tree["id"],
            snapshot["revision"],
            {**snapshot["files"], "pyproject.toml": foreign.replace("0.1.0", "0.1.1")},
        )


@pytest.mark.parametrize("table", ["optional-dependencies", "dependency-groups"])
def test_dependency_tables_must_be_tables(table):
    manifest = default_pyproject("Review")
    manifest = (
        manifest.replace("[tool.uv]", f'{table} = ["requests"]\n\n[tool.uv]', 1)
        if table == "optional-dependencies"
        else f'{table} = ["requests"]\n' + manifest
    )
    with pytest.raises(Problem, match="tables of lists"):
        validate_manifest(manifest)
