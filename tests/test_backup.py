"""CLI discovery and recoverable, private instance archives."""

import json
import os
import sqlite3
import stat
import subprocess
import sys
import tarfile
from contextlib import closing

import pytest
from filelock import FileLock
from helpers import example_bundle

from duckpad import __version__, backup, sealing
from duckpad.auth import Auth
from duckpad.services import Services


def command(*args, env=None):
    return subprocess.run(
        [sys.executable, "-m", "duckpad", *map(str, args)],
        capture_output=True,
        text=True,
        timeout=20,
        env=env,
    )


@pytest.mark.parametrize("option", ["--version", "version"])
def test_version_matches_the_installed_package(option):
    result = command(option)
    assert result.returncode == 0, result.stderr
    assert result.stdout == f"Duckpad {__version__}\n"


@pytest.mark.parametrize("args", [["--version"], ["version"], ["paths", "--json"], ["--help"]])
def test_discovery_does_not_import_server_dependencies(args, tmp_path):
    code = """
import sys
class RejectServer:
    def find_spec(self, fullname, *args):
        if fullname.split('.')[0] in {'duckdb', 'uvicorn', 'fastapi', 'sqlmodel', 'cryptography'}:
            raise RuntimeError('Unexpected server import: ' + fullname)
sys.meta_path.insert(0, RejectServer())
from duckpad.cli import main
main()
"""
    result = subprocess.run(
        [sys.executable, "-c", code, *args],
        env={**os.environ, "XDG_DATA_HOME": str(tmp_path)},
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "duckpad").exists()


def test_paths_respect_xdg_and_custom_home_without_creating_them(tmp_path):
    env = {**os.environ, "XDG_DATA_HOME": str(tmp_path / "data")}
    result = command("paths", "--json", env=env)
    paths = json.loads(result.stdout)
    assert paths["home"] == str(tmp_path / "data" / "duckpad")
    assert paths["exists"] is False
    custom = tmp_path / "my instance"
    result = command("paths", "--json", "--home", custom, env=env)
    paths = json.loads(result.stdout)
    assert paths["home"] == str(custom)
    assert paths["database"] == str(custom / "instance.sqlite")
    assert list(tmp_path.iterdir()) == []


def test_paths_report_external_keys_without_reading_or_printing_secrets(tmp_path, monkeypatch, capsys):
    secret = "never-print-this-key"
    monkeypatch.setenv("DUCKPAD_MASTER_KEY", secret)
    monkeypatch.delenv("DUCKPAD_MASTER_KEY_FILE", raising=False)
    backup.print_paths(tmp_path, as_json=True)
    output = capsys.readouterr().out
    assert json.loads(output)["master_key"] == {"source": "DUCKPAD_MASTER_KEY", "path": None}
    assert secret not in output
    key = tmp_path / "external.key"
    key.write_text(secret)
    monkeypatch.delenv("DUCKPAD_MASTER_KEY")
    monkeypatch.setenv("DUCKPAD_MASTER_KEY_FILE", str(key))
    backup.print_paths(tmp_path, as_json=True)
    output = capsys.readouterr().out
    assert json.loads(output)["master_key"] == {"source": "DUCKPAD_MASTER_KEY_FILE", "path": str(key)}
    assert secret not in output


@pytest.fixture
def instance(tmp_path):
    home = tmp_path / "instance"
    home.mkdir()
    with closing(sqlite3.connect(home / "instance.sqlite")) as db, db:
        db.execute("CREATE TABLE example(value TEXT)")
        db.execute("INSERT INTO example VALUES ('preserved')")
    return home


def test_archive_recovers_committed_wal_pages_and_preserves_links(instance, tmp_path):
    external = tmp_path / "external.txt"
    external.write_text("external-secret")
    (instance / "external").symlink_to(external)
    (instance / "notes.txt").write_text("notes")
    destination = tmp_path / "backup.tar.gz"
    # An open connection leaves committed data in WAL, as after an unclean exit.
    with closing(sqlite3.connect(instance / "instance.sqlite")) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("INSERT INTO example VALUES ('from WAL')")
        db.commit()
        result = command("backup", destination, "--home", instance)
        assert result.returncode == 0, result.stderr
    if os.name == "posix":
        assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    with tarfile.open(destination) as archive:
        names = archive.getnames()
        assert "duckpad/instance.lock" not in names
        assert "duckpad/instance.sqlite-wal" not in names
        assert "duckpad/instance.sqlite-shm" not in names
        assert archive.getmember("duckpad/external").issym()
        assert archive.getmember("duckpad/instance.sqlite").mode == 0o600
        assert archive.extractfile("duckpad/notes.txt").read() == b"notes"
        manifest = json.load(archive.extractfile("manifest.json"))
        assert manifest["original_home"] == str(instance)
        assert manifest["duckpad_version"] == __version__
        restored = tmp_path / "restored.sqlite"
        restored.write_bytes(archive.extractfile("duckpad/instance.sqlite").read())
    with closing(sqlite3.connect(restored)) as db:
        assert db.execute("SELECT value FROM example").fetchall() == [("preserved",), ("from WAL",)]


def test_a_running_instance_is_refused_without_creating_an_archive(instance, tmp_path):
    destination = tmp_path / "backup.tar.gz"
    with FileLock(instance / "instance.lock"):
        result = command("backup", destination, "--home", instance)
    assert result.returncode != 0
    assert "Stop it" in result.stderr and "Traceback" not in result.stderr
    assert not destination.exists()


def test_missing_instance_is_not_created(tmp_path):
    home = tmp_path / "missing"
    result = command("backup", tmp_path / "backup.tar.gz", "--home", home)
    assert result.returncode != 0
    assert "No regular instance.sqlite" in result.stderr
    assert not home.exists()


@pytest.mark.parametrize("symlink", [False, True])
def test_existing_destinations_are_never_overwritten(instance, tmp_path, symlink):
    original = tmp_path / "original"
    original.write_text("keep")
    destination = tmp_path / "backup.tar.gz"
    if symlink:
        destination.symlink_to(original)
    else:
        destination.write_text("keep")
    result = command("backup", destination, "--home", instance)
    assert result.returncode != 0
    assert destination.read_text() == original.read_text() == "keep"


def test_destination_inside_home_is_refused_even_through_a_symlink(instance, tmp_path):
    alias = tmp_path / "alias"
    alias.symlink_to(instance, target_is_directory=True)
    for root in (instance, alias):
        result = command("backup", root / "backup.tar.gz", "--home", instance)
        assert result.returncode != 0
        assert "outside the instance" in result.stderr
    assert not (instance / "backup.tar.gz").exists()


def test_corrupt_database_leaves_no_partial_archive(instance, tmp_path):
    (instance / "instance.sqlite").write_bytes(b"not SQLite")
    destination = tmp_path / "backup.tar.gz"
    result = command("backup", destination, "--home", instance)
    assert result.returncode != 0
    assert "Cannot back up the instance database" in result.stderr
    assert "Traceback" not in result.stderr
    assert not destination.exists()


def test_failed_file_copy_removes_partial_archive_and_releases_lock(instance, tmp_path, monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("Disk full")

    monkeypatch.setattr(tarfile.TarFile, "add", fail)
    destination = tmp_path / "backup.tar.gz"
    with pytest.raises(OSError, match="Disk full"):
        backup.create_backup(instance, destination)
    assert not destination.exists()
    with FileLock(instance / "instance.lock", timeout=0):
        pass


@pytest.mark.parametrize("external_key", [False, True])
def test_restored_instance_keeps_password_secrets_and_git_branches(tmp_path, monkeypatch, external_key):
    monkeypatch.setattr(sealing, "_environment_keys", None)
    monkeypatch.delenv(sealing.KEY_VARIABLE, raising=False)
    monkeypatch.delenv(sealing.KEY_FILE_VARIABLE, raising=False)
    if external_key:
        key = tmp_path / "external.key"
        sealing.generate(key)
        monkeypatch.setenv(sealing.KEY_FILE_VARIABLE, str(key))
    home = tmp_path / "instance"
    services = Services.open(home, isolated=False, enforce_access=False)
    try:
        password = Auth(services.store).initial_password
        services.store.put("settings", "oidc", {"client_secret": "preserved-secret"})
        tree = services.projects.create("Saved project", example_bundle(tmp_path / "input.csv"))
        branch = services.projects.branch(tree["id"], "saved-branch")
        commit = services.projects.git(branch["path"], "rev-parse", "HEAD")
        resources = services.store.paths.resources(tree["project"])
        resources.mkdir(parents=True, exist_ok=True)
        (resources / "data.csv").write_text("value\n42\n")
    finally:
        services.close()
    destination = backup.create_backup(home, tmp_path / "backup.tar.gz")
    home.rename(tmp_path / "old-instance")
    with tarfile.open(destination) as archive:
        assert ("duckpad/duckpad-master.key" in archive.getnames()) is not external_key
        archive.extractall(tmp_path / "restore", filter="data")
    (tmp_path / "restore" / "duckpad").rename(home)
    restored = Services.open(home, isolated=False, enforce_access=False)
    try:
        assert Auth(restored.store).login("admin", password)
        assert restored.store.get("settings", "oidc")["client_secret"] == "preserved-secret"
        assert restored.projects.git(branch["path"], "rev-parse", "HEAD") == commit
        assert (resources / "data.csv").read_text() == "value\n42\n"
    finally:
        restored.close()
