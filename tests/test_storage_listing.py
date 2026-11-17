"""The file browser's listing: one level of a storage connection, below its root."""

import os

import pytest
from fastapi.testclient import TestClient
from helpers import files_connection

from duckpad import s3_listing, storage_listing
from duckpad.app import create_app
from duckpad.services import Services
from duckpad.util import Problem

BUNDLE = {"flow": {"nodes": [], "edges": []}, "templates": {}, "components": {}, "documentation": {}}


@pytest.fixture
def share(tmp_path):
    """A server folder with nested folders, hidden entries and links inside and outside it."""
    root = tmp_path / "share"
    (root / "inbox" / "2024").mkdir(parents=True)
    (root / "Archive").mkdir()
    (root / ".cache").mkdir()
    (root / "orders.csv").write_text("id\n1\n")
    (root / "Budget.xlsx").write_bytes(b"workbook")
    (root / ".hidden.csv").write_text("id\n")
    (root / "inbox" / "2024" / "january.parquet").write_bytes(b"PAR1")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.csv").write_text("id\n")
    (root / "elsewhere").symlink_to(outside)
    (root / "latest.csv").symlink_to(root / "orders.csv")
    return root


def names(listed):
    return [(entry["kind"], entry["name"]) for entry in listed["entries"]]


def test_a_level_lists_folders_then_files_below_the_root(share):
    listed = storage_listing.folder_level(share, "", "")
    # Hidden entries and a link leaving the root are not offered: a run would refuse them.
    assert names(listed) == [
        ("folder", "Archive"),
        ("folder", "inbox"),
        ("file", "Budget.xlsx"),
        ("file", "latest.csv"),
        ("file", "orders.csv"),
    ]
    assert listed["truncated"] is False
    orders = listed["entries"][-1]
    assert orders["size"] == 5 and orders["modified"].endswith("+00:00")
    assert listed["entries"][0] == {"name": "Archive", "kind": "folder", "size": None, "modified": None}
    assert names(storage_listing.folder_level(share, "inbox/2024", "")) == [("file", "january.parquet")]


def test_a_large_level_keeps_its_first_names_and_narrows_by_prefix(share, monkeypatch):
    monkeypatch.setattr(storage_listing, "LIMIT", 2)
    listed = storage_listing.folder_level(share, "", "")
    assert names(listed) == [("folder", "Archive"), ("folder", "inbox")] and listed["truncated"] is True
    narrowed = storage_listing.folder_level(share, "", "b")
    assert names(narrowed) == [("file", "Budget.xlsx")] and narrowed["truncated"] is False


@pytest.mark.parametrize("path", ["..", "inbox/../..", "elsewhere", "inbox/./2024", "in\x00box"])
def test_a_level_never_leaves_the_root(share, path):
    connection = {"name": "Share", "definition": {}, "values": {"root": str(share)}}
    with pytest.raises(Problem, match="Choose a folder below the connection root") as refused:
        storage_listing.level(connection, path)
    assert refused.value.status == 422


def test_a_missing_or_unreadable_folder_is_reported(share):
    with pytest.raises(Problem, match="does not exist on the Duckpad server") as missing:
        storage_listing.folder_level(share, "inbox/2025", "")
    assert missing.value.status == 404
    if os.geteuid():
        (share / "Archive").chmod(0)
        try:
            with pytest.raises(Problem, match="cannot read this folder: Permission denied"):
                storage_listing.folder_level(share, "Archive", "")
        finally:
            (share / "Archive").chmod(0o755)


def test_a_connection_without_a_root_or_a_listing_api_asks_for_a_path():
    definition = {"init_sql": ""}
    with pytest.raises(Problem, match="Share has no root in this environment"):
        storage_listing.level({"name": "Share", "definition": definition, "values": {"root": ""}}, "")
    with pytest.raises(Problem, match="cannot list this type of storage yet"):
        storage_listing.level(
            {"name": "Web", "definition": definition, "values": {"root": "https://data.example.com/x/"}}, ""
        )
    with pytest.raises(Problem, match="name filter cannot contain a path separator"):
        storage_listing.level(
            {"name": "Share", "definition": definition, "values": {"root": "/srv"}}, "", "a/b"
        )


def test_an_object_storage_root_is_listed_through_its_api(services, monkeypatch):
    _, projects, catalog, engine = services
    catalog.save(
        "connection",
        {
            "id": "lake",
            "name": "Lake",
            "connector": "s3",
            "environments": {
                "dev": {"root": "s3://lake/raw/", "key_id": "key", "secret": "hidden-value"},
                "prod": {"root": "s3://lake/prod/", "key_id": "key", "secret": "hidden-value"},
            },
        },
        create=True,
    )
    worktree = projects.create("Lake", BUNDLE)["id"]
    calls = []

    def listed(settings, root, path, prefix, limit):
        calls.append((settings["key_id"], settings["endpoint"], root, path, prefix, limit))
        if path == "denied":
            raise Problem("The storage refused the listing made with hidden-value", 422)
        return {"entries": [], "truncated": False}

    monkeypatch.setattr(s3_listing, "list_level", listed)
    assert engine.connection_files(worktree, "lake", "prod", "/inbox//2024/", "or") == {
        "entries": [],
        "truncated": False,
    }
    assert calls == [
        ("key", "s3.amazonaws.com", "s3://lake/prod/", "inbox/2024", "or", storage_listing.LIMIT)
    ]
    with pytest.raises(Problem) as denied:
        engine.connection_files(worktree, "lake", "dev", "denied")
    assert "hidden-value" not in str(denied.value) and denied.value.status == 422


def test_the_browser_follows_grants_roles_and_families(tmp_path, share):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        client.post("/api/login", json={"username": "admin", "password": app.state.auth.initial_password})
        catalog = app.state.services.catalog
        files_connection(catalog, "share", str(share))
        worktree = client.post("/api/projects", json={"name": "Files"}).json()
        url = f"/api/worktrees/{worktree['id']}/connections/share/files"
        assert client.get(url, params={"environment": "dev"}).status_code == 403
        client.put(
            f"/api/projects/{worktree['project']}/connections", json={"connections": ["share"]}
        ).raise_for_status()
        listed = client.get(url, params={"environment": "dev", "path": "inbox"})
        assert listed.status_code == 200, listed.text
        assert listed.json() == {
            "entries": [{"name": "2024", "kind": "folder", "size": None, "modified": None}],
            "truncated": False,
        }
        assert client.get(url, params={"environment": "dev", "path": "../outside"}).status_code == 422
        assert client.get(url, params={"environment": "dev", "path": "missing"}).status_code == 404
        assert client.get(url, params={"environment": "staging"}).status_code == 400


def test_an_isolated_instance_never_lists_its_own_metadata(tmp_path):
    instance = Services.open(tmp_path / "instance", enforce_access=True, isolated=True)
    try:
        files_connection(instance.catalog, "home", str(tmp_path))
        worktree = instance.projects.create("Files", BUNDLE)
        instance.engine.access.grant_connections(worktree["project"], ["home"])
        with pytest.raises(Problem, match="must exclude instance metadata and other projects"):
            instance.engine.connection_files(worktree["id"], "home", "dev")
    finally:
        instance.close()


def test_listing_files_needs_a_storage_connection(services, tmp_path):
    _, projects, catalog, engine = services
    catalog.save(
        "connector",
        {
            "id": "native",
            "family": "database",
            "name": "Attached DuckDB",
            "parameters": [{"name": "database", "type": "file"}],
            "capabilities": ["read"],
            "init_sql": "ATTACH {{ database }} AS {{ alias }};",
        },
    )
    catalog.save(
        "connection",
        {
            "id": "warehouse",
            "name": "Warehouse",
            "connector": "native",
            "environments": {"dev": {"database": str(tmp_path / "warehouse.duckdb")}},
        },
        create=True,
    )
    worktree = projects.create("Tables", BUNDLE)["id"]
    with pytest.raises(Problem, match="Connection warehouse is not a file storage location") as refused:
        engine.connection_files(worktree, "warehouse", "dev")
    assert refused.value.status == 422
