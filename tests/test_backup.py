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
from duckpad.instance import print_info
from duckpad.services import Services


def command(*args, env=None):
    return subprocess.run(
        [sys.executable, "-m", "duckpad", *map(str, args)],
        capture_output=True,
        text=True,
        timeout=20,
        env=env,
    )


def test_version_matches_the_installed_package():
    result = command("--version")
    assert result.returncode == 0, result.stderr
    assert result.stdout == f"Duckpad {__version__}\n"


@pytest.mark.parametrize("args", [["--version"], ["info", "--json"], ["--help"]])
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


def test_info_respect_xdg_and_custom_home_without_creating_them(tmp_path):
    env = {**os.environ, "XDG_DATA_HOME": str(tmp_path / "data")}
    result = command("info", "--json", env=env)
    paths = json.loads(result.stdout)
    assert paths["home"] == str(tmp_path / "data" / "duckpad")
    assert paths["exists"] is False
    custom = tmp_path / "my instance"
    result = command("info", "--json", "--home", custom, env=env)
    paths = json.loads(result.stdout)
    assert paths["home"] == str(custom)
    assert paths["database"] == str(custom / "instance.sqlite")
    assert list(tmp_path.iterdir()) == []


def test_info_report_external_keys_without_reading_or_printing_secrets(tmp_path, monkeypatch, capsys):
    secret = "never-print-this-key"
    monkeypatch.setenv("DUCKPAD_MASTER_KEY", secret)
    monkeypatch.delenv("DUCKPAD_MASTER_KEY_FILE", raising=False)
    print_info(tmp_path, as_json=True)
    output = capsys.readouterr().out
    assert json.loads(output)["master_key"] == {"source": "DUCKPAD_MASTER_KEY", "path": None}
    assert secret not in output
    key = tmp_path / "external.key"
    key.write_text(secret)
    monkeypatch.delenv("DUCKPAD_MASTER_KEY")
    monkeypatch.setenv("DUCKPAD_MASTER_KEY_FILE", str(key))
    print_info(tmp_path, as_json=True)
    output = capsys.readouterr().out
    assert json.loads(output)["master_key"] == {"source": "DUCKPAD_MASTER_KEY_FILE", "path": str(key)}
    assert secret not in output
    # Match the server: environment key paths are literal, unlike --home arguments.
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DUCKPAD_MASTER_KEY_FILE", "~/external.key")
    print_info(tmp_path, as_json=True)
    assert json.loads(capsys.readouterr().out)["master_key"]["path"] == str(tmp_path / "~" / "external.key")


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
    assert backup.restore_backup(destination) == home
    restored = Services.open(home, isolated=False, enforce_access=False)
    try:
        assert Auth(restored.store).login("admin", password)
        assert restored.store.get("settings", "oidc")["client_secret"] == "preserved-secret"
        assert restored.projects.git(branch["path"], "rev-parse", "HEAD") == commit
        assert (resources / "data.csv").read_text() == "value\n42\n"
    finally:
        restored.close()


def test_info_reports_versions_and_conflicting_key_configuration(tmp_path, monkeypatch):
    monkeypatch.delenv(sealing.KEY_VARIABLE, raising=False)
    monkeypatch.delenv(sealing.KEY_FILE_VARIABLE, raising=False)
    result = command("info", "--home", tmp_path, "--json")
    info = json.loads(result.stdout)
    assert info["duckpad"] == __version__
    assert info["python"] and info["duckdb"] and info["platform"]
    assert set(info) == {
        "duckpad",
        "python",
        "duckdb",
        "platform",
        "home",
        "exists",
        "database",
        "master_key",
    }
    monkeypatch.setenv(sealing.KEY_VARIABLE, "secret-value")
    monkeypatch.setenv(sealing.KEY_FILE_VARIABLE, "secret-file")
    result = command("info", "--json")
    assert result.returncode == 1
    assert "not both" in result.stderr
    assert "secret-value" not in result.stderr
    assert "usage:" not in result.stderr and not result.stdout


@pytest.mark.parametrize("destination", [None, "existing", "new/folder/", "new/nested/archive.tar.gz"])
def test_default_and_directory_destinations(instance, tmp_path, monkeypatch, destination):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "existing").mkdir()
    args = ["backup", "--home", instance]
    if destination is not None:
        args.append(destination)
    result = command(*args)
    assert result.returncode == 0, result.stderr
    archives = list(tmp_path.rglob("*.tar.gz"))
    assert len(archives) == 1
    assert "bytes)" in result.stdout
    if destination != "new/nested/archive.tar.gz":
        assert archives[0].name.startswith(f"duckpad-{__version__}-")
    else:
        assert archives[0] == tmp_path / destination


@pytest.mark.parametrize("include_cache", [False, True])
def test_backup_omits_rebuildable_cache_but_keeps_offline_extensions(instance, tmp_path, include_cache):
    cached = instance / "python" / ("a" * 64)
    (cached / ".venv").mkdir(parents=True)
    (cached / ".venv" / "library").write_text("rebuildable")
    (cached / "ready.json").write_text("{}")
    (instance / "extensions").mkdir()
    (instance / "extensions" / "offline.duckdb_extension").write_bytes(b"keep")
    destination = backup.create_backup(
        instance, tmp_path / "backup.tar.gz", include_python_cache=include_cache
    )
    with tarfile.open(destination) as archive:
        names = archive.getnames()
        assert any(name.startswith("duckpad/python") for name in names) is include_cache
        assert "duckpad/extensions/offline.duckdb_extension" in names
    instance.rename(tmp_path / "old")
    backup.restore_backup(destination)
    assert cached.exists() is include_cache
    assert (instance / "extensions" / "offline.duckdb_extension").read_bytes() == b"keep"


def test_restore_rejects_existing_data_and_alternate_paths(instance, tmp_path):
    archive = backup.create_backup(instance, tmp_path / "backup.tar.gz")
    before = (instance / "instance.sqlite").read_bytes()
    result = command("restore", archive)
    assert result.returncode == 1 and "not empty" in result.stderr
    assert (instance / "instance.sqlite").read_bytes() == before
    other = tmp_path / "other"
    result = command("restore", archive, "--home", other)
    assert result.returncode == 1 and "original instance path" in result.stderr
    assert not other.exists()


def rewrite_archive(source, destination, *, change_manifest=None, entries=(), corrupt_database=False):
    import io

    with tarfile.open(source) as original, tarfile.open(destination, "w:gz") as target:
        for member in original:
            content = original.extractfile(member).read() if member.isfile() else None
            if member.name == "manifest.json" and change_manifest:
                manifest = json.loads(content)
                manifest.update(change_manifest)
                content = json.dumps(manifest).encode()
            if corrupt_database and member.name == "duckpad/instance.sqlite":
                content = b"not a database"
            if content is not None:
                member.size = len(content)
            target.addfile(member, io.BytesIO(content) if content is not None else None)
        for member in entries:
            target.addfile(member, io.BytesIO(b"") if member.isfile() else None)


def test_restore_checks_version_before_creating_a_destination(instance, tmp_path):
    source = backup.create_backup(instance, tmp_path / "backup.tar.gz")
    changed = tmp_path / "changed.tar.gz"
    rewrite_archive(source, changed, change_manifest={"duckpad_version": "0.0.1"})
    instance.rename(tmp_path / "old")
    result = command("restore", changed)
    assert result.returncode == 1
    assert "Backup requires Duckpad" in result.stderr
    assert not instance.exists()


@pytest.mark.parametrize(
    "attack",
    ["traversal", "absolute", "backslash", "symlink-parent", "hardlink", "duplicate", "device", "journal"],
)
def test_restore_rejects_unsafe_archive_members(instance, tmp_path, attack):
    source = backup.create_backup(instance, tmp_path / "backup.tar.gz")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "marker").write_text("keep")
    if attack == "symlink-parent":
        link = tarfile.TarInfo("duckpad/link")
        link.type, link.linkname = tarfile.SYMTYPE, str(outside)
        entries = [link, tarfile.TarInfo("duckpad/link/marker")]
    elif attack == "hardlink":
        link = tarfile.TarInfo("duckpad/link")
        link.type, link.linkname = tarfile.LNKTYPE, str(outside / "marker")
        entries = [link]
    else:
        names = {
            "traversal": "../outside/marker",
            "absolute": str(outside / "marker"),
            "backslash": r"duckpad\..\outside\marker",
            "duplicate": "duckpad/instance.sqlite",
            "device": "duckpad/device",
            "journal": "duckpad/instance.sqlite-wal",
        }
        member = tarfile.TarInfo(names[attack])
        if attack == "device":
            member.type = tarfile.CHRTYPE
        entries = [member]
    changed = tmp_path / "unsafe.tar.gz"
    rewrite_archive(source, changed, entries=entries)
    instance.rename(tmp_path / "old")
    result = command("restore", changed)
    assert result.returncode == 1, result.stdout
    assert "Traceback" not in result.stderr
    assert not instance.exists()
    assert (outside / "marker").read_text() == "keep"


def test_restore_preserves_links_without_following_them(instance, tmp_path):
    outside = tmp_path / "external"
    outside.write_text("private external content")
    (instance / "linked").symlink_to(outside)
    (instance / "missing").symlink_to(tmp_path / "missing-target")
    (instance / "file").write_text("shared content")
    os.link(instance / "file", instance / "hardlink")
    source = backup.create_backup(instance, tmp_path / "backup.tar.gz")
    instance.rename(tmp_path / "old")
    instance.mkdir()
    result = command("restore", source, "--home", instance)
    assert result.returncode == 0, result.stderr
    assert (instance / "linked").is_symlink()
    assert (instance / "missing").is_symlink()
    assert (instance / "hardlink").read_text() == "shared content"
    assert (instance / "file").stat().st_ino == (instance / "hardlink").stat().st_ino
    assert outside.read_text() == "private external content"


@pytest.mark.parametrize("failure", ["corrupt", "copy"])
def test_restore_failure_cleans_staging_and_leaves_no_partial_instance(
    instance, tmp_path, monkeypatch, failure
):
    source = backup.create_backup(instance, tmp_path / "backup.tar.gz")
    if failure == "corrupt":
        changed = tmp_path / "corrupt.tar.gz"
        rewrite_archive(source, changed, corrupt_database=True)
        source = changed
    else:

        def fail(*args, **kwargs):
            raise OSError("Disk full")

        monkeypatch.setattr(backup.shutil, "copyfileobj", fail)
    instance.rename(tmp_path / "old")
    with pytest.raises((backup.BackupError, OSError)):
        backup.restore_backup(source)
    assert not instance.exists()
    assert list(tmp_path.glob(".duckpad-restore-*")) == []


def test_restore_and_start_share_a_lock_while_home_is_absent(instance, tmp_path):
    from duckpad.instance import instance_lease

    source = backup.create_backup(instance, tmp_path / "backup.tar.gz")
    instance.rename(tmp_path / "old")
    with instance_lease(instance):
        restore = command("restore", source)
        start = command("start", "--home", instance, "--no-browser")
    for result in (restore, start):
        assert result.returncode == 1
        assert "maintenance is in progress" in result.stderr and "usage:" not in result.stderr
    assert not instance.exists()


def test_restore_reports_a_running_instance_before_suggesting_moving_it(instance, tmp_path):
    archive = backup.create_backup(instance, tmp_path / "backup.tar.gz")
    before = (instance / "instance.sqlite").read_bytes()
    with FileLock(instance / "instance.lock"):
        result = command("restore", archive)
    assert result.returncode == 1 and "Stop it" in result.stderr
    assert "Move the existing instance" not in result.stderr
    assert (instance / "instance.sqlite").read_bytes() == before


def test_maintenance_errors_are_distinct_from_invalid_arguments(instance, tmp_path):
    destination = tmp_path / "backup.tar.gz"
    destination.write_text("keep")
    operational = command("backup", destination, "--home", instance)
    syntax = command("backup", "--unknown")
    assert operational.returncode == 1 and "already exists" in operational.stderr
    assert "usage:" not in operational.stderr and "Errno" not in operational.stderr
    assert syntax.returncode == 2 and "usage:" in syntax.stderr


@pytest.mark.parametrize("damage", ["truncated", "checksum"])
def test_restore_rejects_damaged_gzip_streams(instance, tmp_path, damage):
    archive = backup.create_backup(instance, tmp_path / "backup.tar.gz")
    content = bytearray(archive.read_bytes())
    if damage == "truncated":
        del content[-8:]
    else:
        content[-8] ^= 1
    archive.write_bytes(content)
    instance.rename(tmp_path / "old")
    result = command("restore", archive)
    assert result.returncode == 1
    assert "Traceback" not in result.stderr
    assert not instance.exists()
