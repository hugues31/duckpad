"""Secret parameters can name a server environment variable or secret file instead of a value."""

import copy
import json

import pytest
from helpers import wait_run
from sqlalchemy import text
from test_connection_changes import KEYED, database, keyed_project, results

from duckpad import secret_references
from duckpad.git.command import environment
from duckpad.services import Services
from duckpad.util import Problem

VARIABLE = {"from": "env", "name": "DUCKPAD_SECRET_WAREHOUSE"}
FILE = {"from": "file", "name": "warehouse"}


@pytest.fixture
def directory(tmp_path, monkeypatch):
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    monkeypatch.setenv(secret_references.DIRECTORY_VARIABLE, str(secrets))
    return secrets


def connection(database):
    return {
        "id": "warehouse",
        "name": "Warehouse",
        "connector": "keyed",
        "environments": {"dev": {"database": database, "label": "first"}},
    }


def test_references_resolve_on_capture_and_are_displayed_as_is(services, tmp_path, monkeypatch):
    store, _, catalog, _ = services
    monkeypatch.delenv(VARIABLE["name"], raising=False)
    catalog.save("connector", copy.deepcopy(KEYED))
    catalog.save("connection", connection(VARIABLE), create=True)
    # It names where the secret is: neither masked nor encrypted.
    assert catalog.public()["connections"][0]["environments"]["dev"]["database"] == VARIABLE
    with store.engine.connect() as raw:
        stored = raw.execute(text("SELECT parameters FROM connection_environment WHERE environment = 'dev'"))
        assert json.loads(stored.scalar_one())["database"] == VARIABLE
    with pytest.raises(
        Problem, match=r"Connection warehouse: DUCKPAD_SECRET_WAREHOUSE is not set on the server \(dev\)"
    ):
        catalog.capture(["warehouse"], "dev")
    # Fingerprints never resolve references, so a missing secret leaves results valid.
    unresolved = catalog.capture(["warehouse"], "dev", resolve=False)[0]["warehouse"]["fingerprint"]

    path = database(tmp_path, "first", 10)
    monkeypatch.setenv(VARIABLE["name"], path)
    captured, secrets = catalog.capture(["warehouse"], "dev")
    assert captured["warehouse"]["values"]["database"] == path
    assert path in secrets
    assert captured["warehouse"]["fingerprint"] == unresolved
    # Saving a masked form keeps the reference.
    catalog.save("connection", catalog.public()["connections"][0])
    assert store.get("connection", "warehouse")["environments"]["dev"]["database"] == VARIABLE
    # Git commands and their hooks never see server secrets.
    assert VARIABLE["name"] not in environment()


@pytest.mark.parametrize(
    ("parameters", "message"),
    [
        ({"database": {"from": "env", "name": "AWS_SECRET_ACCESS_KEY"}}, "starting with DUCKPAD_SECRET_"),
        ({"database": {"from": "env", "name": "DUCKPAD_MASTER_KEY"}}, "starting with DUCKPAD_SECRET_"),
        ({"database": {"from": "env", "name": "DUCKPAD_SECRET_lower"}}, "in upper case"),
        ({"database": {"from": "file", "name": "../instance.sqlite"}}, "without a slash"),
        ({"database": {"from": "file", "name": "kubernetes.io/serviceaccount/token"}}, "without a slash"),
        ({"database": {"from": "file", "name": ".."}}, "without a slash"),
        ({"database": {"from": "vault", "name": "warehouse"}}, "A secret reference is"),
        ({"database": {"from": "env", "name": "DUCKPAD_SECRET_X", "default": "x"}}, "A secret reference is"),
        ({"database": "x", "label": VARIABLE}, "Only secret parameters can name a server secret, not label"),
    ],
)
def test_references_are_limited_to_secret_parameters_and_server_secrets(services, parameters, message):
    _, _, catalog, _ = services
    catalog.save("connector", copy.deepcopy(KEYED))
    with pytest.raises(Problem, match=message):
        catalog.save(
            "connection",
            {
                "id": "warehouse",
                "name": "Warehouse",
                "connector": "keyed",
                "environments": {"dev": parameters},
            },
            create=True,
        )


def test_secret_files_stay_in_their_directory(directory, tmp_path, monkeypatch):
    (directory / "plain").write_text("s3cret\r\n\n")
    assert secret_references.resolve({"from": "file", "name": "plain"}) == "s3cret"
    # Kubernetes links each key to a timestamped sibling directory and swaps it on rotation.
    (directory / "..2026_11_02").mkdir()
    (directory / "..2026_11_02" / "password").write_text("rotated")
    (directory / "..data").symlink_to("..2026_11_02")
    (directory / "password").symlink_to("..data/password")
    assert secret_references.resolve({"from": "file", "name": "password"}) == "rotated"

    (tmp_path / "outside").write_text("server file")
    (directory / "escape").symlink_to(tmp_path / "outside")
    (directory / "kubernetes.io").mkdir()
    (directory / "large").write_bytes(b"x" * (64 * 1024 + 1))
    (directory / "binary").write_bytes(b"\xff\xfe")
    (directory / "duckpad_master_key").write_text("master key")
    monkeypatch.setenv("DUCKPAD_MASTER_KEY_FILE", str(directory / "duckpad_master_key"))
    for name, message in [
        ("escape", "Secret file escape is not in DUCKPAD_SECRETS_DIR"),
        ("kubernetes.io", "is not in DUCKPAD_SECRETS_DIR"),
        ("missing", "is not in DUCKPAD_SECRETS_DIR"),
        ("large", "larger than 64 KiB"),
        ("binary", "not UTF-8 text"),
        ("duckpad_master_key", "is the master key, which connections cannot read"),
    ]:
        with pytest.raises(Problem, match=message):
            secret_references.resolve({"from": "file", "name": name})


@pytest.fixture(params=[False, True], ids=["embedded", "isolated"])
def instance(tmp_path, request):
    services = Services.open(tmp_path / "instance", enforce_access=request.param)
    try:
        yield services
    finally:
        services.close()


def test_a_rotated_secret_file_applies_at_the_next_run_without_stale_results(instance, directory, tmp_path):
    worktree, saved = keyed_project(instance, tmp_path)
    (directory / "warehouse").write_text(saved["environments"]["dev"]["database"] + "\n")
    saved["environments"]["dev"]["database"] = FILE
    instance.catalog.save("connection", copy.deepcopy(saved))
    before = results(instance, worktree)

    # A missing file only blocks the nodes that use the connection; results stay valid.
    (directory / "warehouse").unlink()
    assert results(instance, worktree) == before
    run = wait_run(instance.store, instance.engine.launch(worktree, "dev", "other"), timeout=30)
    assert run["status"] == "success", run
    run = wait_run(instance.store, instance.engine.launch(worktree, "dev"), timeout=30)
    assert "Secret file warehouse is not in DUCKPAD_SECRETS_DIR on the server (dev)" in json.dumps(run)

    (directory / "warehouse").write_text(database(tmp_path, "second", 20))
    run = wait_run(instance.store, instance.engine.launch(worktree, "dev"), timeout=30)
    assert run["status"] == "success", run
    assert instance.engine.preview(worktree, "dev", "double")["rows"][0]["values"] == [0, 40]
