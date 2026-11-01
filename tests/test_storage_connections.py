"""File storage connections: Server folders and custom storage types as file node locations."""

import shutil

import pytest
from helpers import enable_excel, wait_run
from xlsx_fixture import workbook

from duckpad import sandbox
from duckpad.auth import Auth
from duckpad.builtin_templates import BUILTINS
from duckpad.services import Services


@pytest.fixture(params=[False, True], ids=["embedded", "isolated"])
def instance(tmp_path, excel_cache, request):
    services = Services.open(tmp_path / "instance", enforce_access=request.param)
    shutil.copytree(excel_cache, services.store.home / "extensions")
    yield services
    services.close()


def node(identity, template, **params):
    return {"id": identity, "template": template, "params": params}


def granted_project(instance, nodes, connections):
    """A project whose owner was granted the connections by an instance administrator."""
    bundle = enable_excel(
        {
            "flow": {"nodes": nodes, "edges": []},
            "templates": BUILTINS.copy(),
            "components": {},
            "documentation": {},
        }
    )
    if not instance.engine.access:
        return instance.projects.create("Finance", bundle)
    Auth(instance.store)
    owner = instance.store.get("user", "admin")
    worktree = instance.engine.access.create(
        owner, lambda grant: instance.projects.create("Finance", bundle, record=grant)
    )
    instance.engine.access.grant_connections(worktree["project"], connections)
    return worktree


def test_a_server_folder_reads_the_folder_of_each_environment(instance, tmp_path):
    # Journey 2: an administrator shares a folder with a different path in dev and prod.
    for environment, amount in (("dev", 10), ("prod", 100)):
        inbox = tmp_path / f"finance-{environment}" / "inbox"
        inbox.mkdir(parents=True)
        workbook(inbox / "budget.xlsx")
        (inbox / "budget.csv").write_text(f"id,amount\n1,{amount}\n")
    instance.catalog.save(
        "connection",
        {
            "id": "finance",
            "name": "Finance share",
            "connector": "folder",
            "environments": {env: {"root": str(tmp_path / f"finance-{env}")} for env in ("dev", "prod")},
        },
        create=True,
    )
    worktree = granted_project(
        instance,
        [
            node("workbook", "load_xlsx", connection="finance", file="inbox/budget.xlsx", sheet="Orders"),
            node("csv", "load_csv", connection="finance", file="inbox/budget.csv"),
        ],
        ["finance"],
    )
    identity = worktree["id"]
    commit = instance.projects.snapshot(identity)["commit"]
    for environment, amount in (("dev", 10), ("prod", 100)):
        run = wait_run(instance.store, instance.engine.launch(identity, environment), timeout=30)
        assert run["status"] == "success", run
        root = tmp_path / f"finance-{environment}"
        assert str(root / "inbox" / "budget.xlsx") in run["nodes"]["workbook"]["statements"][0]["sql"]
        assert instance.engine.preview(identity, environment, "workbook")["rows"][0]["values"][:3] == [
            1,
            "North",
            12.5,
        ]
        assert instance.engine.preview(identity, environment, "csv")["rows"][0]["values"] == [1, amount]
    # Switching environments changed connection values, never the project.
    assert instance.projects.snapshot(identity)["commit"] == commit


def test_a_custom_storage_type_works_as_a_location(instance, tmp_path):
    share = tmp_path / "archive"
    share.mkdir()
    (share / "orders.csv").write_text("id\n7\n")
    instance.catalog.save(
        "connector",
        {
            "id": "archive",
            "name": "Archive",
            "family": "storage",
            "parameters": [{"name": "root", "type": "text"}],
            "capabilities": ["read"],
            "init_sql": "",
        },
    )
    instance.catalog.save(
        "connection",
        {
            "id": "archive",
            "name": "Archive",
            "connector": "archive",
            "environments": {"dev": {"root": str(share)}},
        },
        create=True,
    )
    worktree = granted_project(
        instance, [node("orders", "load_csv", connection="archive", file="orders.csv")], ["archive"]
    )
    run = wait_run(instance.store, instance.engine.launch(worktree["id"], "dev"), timeout=30)
    assert run["status"] == "success", run
    assert instance.engine.preview(worktree["id"], "dev", "orders")["rows"][0]["values"] == [7]


def test_uri_roots_open_their_prefix_in_the_isolated_worker(tmp_path, monkeypatch):
    instance = Services.open(tmp_path / "instance", enforce_access=True)
    try:
        instance.catalog.save(
            "connector",
            {
                "id": "landing",
                "name": "Landing",
                "family": "storage",
                "parameters": [{"name": "root", "type": "text"}],
                "capabilities": ["read"],
                "init_sql": "",
            },
        )
        for identity, root in (("landing", "gs://bucket/landing"), ("lake", "s3://lake/raw/")):
            instance.catalog.save(
                "connection",
                {
                    "id": identity,
                    "name": identity,
                    "connector": "landing" if identity == "landing" else "s3",
                    "environments": {"dev": {"root": root, "key_id": "key", "secret": "hidden"}},
                },
                create=True,
            )
        policies = []

        class Recorded:
            """Record the worker policy; reaching object storage is outside this test."""

            closed = False

            def __init__(self, policy):
                policies.append(policy)

            def close(self):
                pass

        monkeypatch.setattr(sandbox, "Database", Recorded)
        monkeypatch.setattr(instance.engine.pool, "_install_extensions", lambda *_: None)
        worktree = granted_project(instance, [], ["landing", "lake"])
        instance.engine.context(worktree["id"], "dev", create=True)
        # Remote roots are not local folders: they never need to exist on the server.
        assert set(policies[0]["remote_paths"]) == {
            "gs://bucket/landing/",
            "s3://",
            "s3a://",
            "s3n://",
            "s3://lake/raw/",
        }
        assert all("bucket" not in path for path in policies[0]["read_paths"])
    finally:
        instance.close()
