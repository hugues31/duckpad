"""Secrets are sealed at rest with a master key kept outside the instance database."""

import base64
import json
import os
import sqlite3
import stat
from contextlib import closing

import pytest
from sqlalchemy import text

from duckpad import sealing
from duckpad.catalog import Catalog
from duckpad.services import Services
from duckpad.store import Store
from duckpad.util import Problem

SECRETS = ("pg-secret-1", "oidc-secret-2", "provider-key-3", "PRIVATE KEY 4")
CONNECTOR = {
    "id": "vault",
    "family": "database",
    "name": "Vault",
    "parameters": [{"name": "host", "type": "text"}, {"name": "password", "type": "text", "secret": True}],
    "capabilities": ["read"],
    "init_sql": "",
}


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    monkeypatch.setattr(sealing, "_environment_keys", None)
    monkeypatch.delenv(sealing.KEY_VARIABLE, raising=False)
    monkeypatch.delenv(sealing.KEY_FILE_VARIABLE, raising=False)


def key():
    return base64.b64encode(os.urandom(32)).decode()


def fill(store):
    catalog = Catalog(store)
    catalog.save("connector", dict(CONNECTOR))
    catalog.save(
        "connection",
        {
            "id": "pg",
            "name": "PG",
            "connector": "vault",
            "environments": {"dev": {"host": "db.internal", "password": SECRETS[0]}, "prod": {}},
        },
        create=True,
    )
    store.put("settings", "oidc", {"enabled": False, "client_id": "duckpad", "client_secret": SECRETS[1]})
    store.put(
        "settings",
        "assistant",
        {
            "providers": [
                {"id": "main", "kind": "openai", "api_key": SECRETS[2]},
                {"id": "local", "api_key": ""},
            ]
        },
    )
    store.put("user", "u1", {"username": "ana", "role": "admin", "active": True, "salt": "s", "hash": "h"})
    store.put(
        "ssh_key",
        "u1",
        {
            "id": "k1",
            "private_key": SECRETS[3],
            "public_key": "ssh-ed25519 AAA",
            "fingerprint": "f",
            "created": "now",
        },
    )


def raw(home):
    """The database bytes as a copy of the instance file would hold them."""
    return b"".join(path.read_bytes() for path in home.iterdir() if path.name.startswith("instance.sqlite"))


def stored(store, sql):
    with store.engine.connect() as connection:
        return connection.execute(text(sql)).scalar_one()


def test_secrets_are_sealed_at_rest_and_read_in_plain(tmp_path):
    store = Store(tmp_path)
    try:
        fill(store)
        key_file = tmp_path / sealing.KEY_FILE
        assert stat.S_IMODE(key_file.stat().st_mode) == 0o600
        assert not store.keys.external
        parameters = json.loads(
            stored(store, "SELECT parameters FROM connection_environment WHERE environment = 'dev'")
        )
        assert parameters["host"] == "db.internal"
        assert sealing.sealed_with(parameters["password"]) == store.keys.primary
        oidc = json.loads(stored(store, "SELECT value FROM setting WHERE id = 'oidc'"))
        assert oidc["client_id"] == "duckpad" and oidc["client_secret"].startswith("dpenc:1:")
        providers = json.loads(stored(store, "SELECT value FROM setting WHERE id = 'assistant'"))["providers"]
        assert providers[0]["api_key"].startswith("dpenc:1:") and providers[1]["api_key"] == ""
        assert stored(store, "SELECT private_key FROM ssh_key").startswith("dpenc:1:")

        assert store.get("connection", "pg")["environments"]["dev"]["password"] == SECRETS[0]
        assert store.get("settings", "oidc")["client_secret"] == SECRETS[1]
        assert store.get("settings", "assistant")["providers"][0]["api_key"] == SECRETS[2]
        assert store.get("ssh_key", "u1")["private_key"] == SECRETS[3]
        assert next(value for _, value in store.items("ssh_key"))["private_key"] == SECRETS[3]
    finally:
        store.close()
    reopened = Store(tmp_path)
    try:
        assert reopened.get("connection", "pg")["environments"]["dev"]["password"] == SECRETS[0]
    finally:
        reopened.close()
    assert not any(secret.encode() in raw(tmp_path) for secret in SECRETS)


def test_a_sealed_value_only_opens_in_its_own_field(tmp_path):
    store = Store(tmp_path)
    try:
        fill(store)
        with store.engine.begin() as connection:
            secret = connection.execute(text("SELECT private_key FROM ssh_key")).scalar_one()
            connection.execute(
                text(
                    "UPDATE setting SET value = json_set(value, '$.client_secret', :secret) WHERE id = 'oidc'"
                ),
                {"secret": secret},
            )
        with pytest.raises(Problem, match="settings/oidc/client_secret was modified outside Duckpad"):
            store.get("settings", "oidc")
    finally:
        store.close()


def test_startup_seals_plaintext_secrets_and_erases_them_from_the_file(tmp_path):
    store = Store(tmp_path)
    store.close()
    (tmp_path / sealing.KEY_FILE).unlink()
    # An instance created before secrets were sealed.
    with closing(sqlite3.connect(tmp_path / "instance.sqlite")) as connection, connection:
        connection.execute(
            "INSERT INTO connection VALUES ('pg', 'PG', 'postgres', ?)", (json.dumps(["password"]),)
        )
        connection.execute(
            "INSERT INTO connection_environment VALUES ('pg', 'dev', ?)",
            (json.dumps({"host": "db.internal", "password": SECRETS[0]}),),
        )
        connection.execute(
            "INSERT INTO setting VALUES ('oidc', ?)",
            (json.dumps({"enabled": False, "client_secret": SECRETS[1]}),),
        )
        # Deleted rows linger in free pages until the file is rewritten.
        connection.execute("INSERT INTO setting VALUES ('deleted', ?)", (json.dumps(SECRETS[2]),))
        connection.execute("DELETE FROM setting WHERE id = 'deleted'")
    assert SECRETS[0].encode() in raw(tmp_path)

    store = Store(tmp_path)
    try:
        assert (tmp_path / sealing.KEY_FILE).exists()
        assert store.get("connection", "pg")["environments"]["dev"]["password"] == SECRETS[0]
        assert store.get("settings", "oidc")["client_secret"] == SECRETS[1]
        assert not any(secret.encode() in raw(tmp_path) for secret in SECRETS[:2])
    finally:
        store.close()


def test_rotation_reseals_with_the_first_key(tmp_path, monkeypatch):
    first, second = key(), key()
    key_file = tmp_path / "keys"
    key_file.write_text(first + "\n")
    monkeypatch.setenv(sealing.KEY_FILE_VARIABLE, str(key_file))
    store = Store(tmp_path / "instance")
    try:
        assert store.keys.external
        fill(store)
        old = store.keys.primary
    finally:
        store.close()
    assert not (tmp_path / "instance" / sealing.KEY_FILE).exists()

    key_file.write_text(f"# rotated\n{second}\n{first}\n")
    store = Store(tmp_path / "instance")
    try:
        assert store.keys.primary != old
        records = store._sealed_records()
        assert {
            sealing.sealed_with(container[field])
            for kind, identity, record in records
            for container, field, _ in sealing.sealed_fields(kind, identity, record)
            if container[field]
        } == {store.keys.primary}
    finally:
        store.close()

    key_file.write_text(second + "\n")
    store = Store(tmp_path / "instance")
    try:
        assert store.get("settings", "assistant")["providers"][0]["api_key"] == SECRETS[2]
    finally:
        store.close()


def test_a_missing_or_wrong_key_refuses_to_start(tmp_path, monkeypatch):
    store = Store(tmp_path)
    try:
        fill(store)
        identity = store.keys.primary
    finally:
        store.close()
    key_file = tmp_path / sealing.KEY_FILE
    saved = key_file.read_text()
    key_file.unlink()
    with pytest.raises(Problem, match=f"master key {identity}, but .*duckpad-master.key is missing"):
        Store(tmp_path)
    # A lost key is never silently replaced.
    assert not key_file.exists()

    monkeypatch.setenv(sealing.KEY_VARIABLE, key())
    with pytest.raises(Problem, match=f"master key {identity}, which is not among the keys provided"):
        Store(tmp_path)
    assert sealing.KEY_VARIABLE not in os.environ

    sealing._environment_keys = None
    key_file.write_text(saved)
    Store(tmp_path).close()


def test_key_variables(tmp_path, monkeypatch):
    monkeypatch.setenv(sealing.KEY_VARIABLE, key())
    store = Store(tmp_path / "first")
    try:
        # Git and SQL workers never inherit the key.
        assert sealing.KEY_VARIABLE not in os.environ
        assert store.keys.external
        assert not (tmp_path / "first" / sealing.KEY_FILE).exists()
        fill(store)
    finally:
        store.close()
    # Read once per process, so the instance reopens.
    Store(tmp_path / "first").close()

    monkeypatch.setenv(sealing.KEY_FILE_VARIABLE, str(tmp_path / "missing"))
    with pytest.raises(Problem, match="either DUCKPAD_MASTER_KEY_FILE or DUCKPAD_MASTER_KEY"):
        Store(tmp_path / "second")
    sealing._environment_keys = None
    with pytest.raises(Problem, match="Cannot read DUCKPAD_MASTER_KEY_FILE"):
        Store(tmp_path / "second")
    (tmp_path / "invalid").write_text("not a key\n")
    monkeypatch.setenv(sealing.KEY_FILE_VARIABLE, str(tmp_path / "invalid"))
    with pytest.raises(Problem, match="base64-encoded 32-byte keys"):
        Store(tmp_path / "second")


def test_a_parameter_made_secret_is_sealed_at_once(tmp_path):
    services = Services.open(tmp_path)
    try:
        public = {
            **CONNECTOR,
            "parameters": [{"name": "host", "type": "text"}, {"name": "password", "type": "text"}],
        }
        services.catalog.save("connector", public)
        services.catalog.save(
            "connection",
            {
                "id": "pg",
                "name": "PG",
                "connector": "vault",
                "environments": {"dev": {"password": SECRETS[0]}},
            },
            create=True,
        )
        assert stored(services.store, "SELECT parameters FROM connection_environment").count(SECRETS[0]) == 1
        services.catalog.save("connector", dict(CONNECTOR))
        assert SECRETS[0] not in stored(services.store, "SELECT parameters FROM connection_environment")
        assert services.store.get("connection", "pg")["secret_fields"] == ["password"]
        # It stays sealed when the definition no longer marks it secret.
        services.catalog.save("connector", public)
        assert SECRETS[0] not in stored(services.store, "SELECT parameters FROM connection_environment")
    finally:
        services.close()
