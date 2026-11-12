"""Load Delta reads Delta Lake table folders through DuckDB's delta extension."""

import json
import shutil

import duckdb
import pytest
from helpers import wait_run

from duckpad.auth import Auth
from duckpad.builtin_templates import BUILTINS
from duckpad.services import Services


@pytest.fixture(scope="session")
def delta_cache(tmp_path_factory):
    """An extension cache holding delta, as an instance administrator would install it."""
    cache = tmp_path_factory.mktemp("delta-extensions")
    with duckdb.connect(config={"extension_directory": str(cache)}) as db:
        db.execute("INSTALL delta")
        db.execute("LOAD delta")
    return cache


@pytest.fixture(params=[False, True], ids=["embedded", "isolated"])
def delta_services(tmp_path, delta_cache, request):
    instance = Services.open(tmp_path / "instance", enforce_access=request.param, isolated=request.param)
    shutil.copytree(delta_cache, instance.store.home / "extensions")
    yield instance
    instance.close()


def delta_table(folder, rows):
    """A minimal Delta Lake table: one Parquet data file and the commit that adds it."""
    (folder / "_delta_log").mkdir(parents=True)
    data = folder / "part-0.parquet"
    with duckdb.connect() as db:
        db.execute(
            f"COPY (SELECT * FROM (VALUES {', '.join('(?, ?, ?)' for _ in rows)}) AS t(id, region, amount)) "
            "TO ? (FORMAT parquet)",
            [value for row in rows for value in row] + [str(data)],
        )
    fields = [
        {"name": name, "type": kind, "nullable": True, "metadata": {}}
        for name, kind in (("id", "integer"), ("region", "string"), ("amount", "double"))
    ]
    schema = json.dumps({"type": "struct", "fields": fields})
    metadata = {"id": "test", "format": {"provider": "parquet", "options": {}}, "schemaString": schema}
    actions = [
        {"protocol": {"minReaderVersion": 1, "minWriterVersion": 2}},
        {"metaData": {**metadata, "partitionColumns": [], "configuration": {}, "createdTime": 0}},
        {
            "add": {
                "path": data.name,
                "partitionValues": {},
                "size": data.stat().st_size,
                "modificationTime": 0,
                "dataChange": True,
            }
        },
    ]
    (folder / "_delta_log" / f"{0:020}.json").write_text("".join(json.dumps(a) + "\n" for a in actions))


def test_load_delta_reads_each_environments_table_under_a_folder_connection(delta_services, tmp_path):
    instance = delta_services
    roots = {"dev": tmp_path / "dev", "prod": tmp_path / "prod"}
    delta_table(roots["dev"] / "orders", [(1, "North", 12.5), (2, "South", 20.0)])
    delta_table(roots["prod"] / "orders", [(3, "East", 100.0)])
    instance.catalog.save(
        "connection",
        {
            "id": "lake",
            "name": "Lake",
            "connector": "folder",
            "environments": {env: {"root": str(root)} for env, root in roots.items()},
        },
        create=True,
    )
    bundle = {
        "flow": {
            "nodes": [
                {
                    "id": "orders",
                    "template": "load_delta",
                    "params": {"connection": "lake", "table": "orders"},
                }
            ],
            "edges": [],
        },
        "templates": BUILTINS.copy(),
        "components": {},
        "documentation": {},
        "extensions": {"delta": {"source": "core", "enabled": True}},
    }
    worktree = instance.projects.create("Lake", bundle)
    if instance.engine.enforce_access:
        Auth(instance.store)
        instance.engine.access.own(worktree, {"id": "admin"}, ["lake"])
    for environment, rows in (
        ("dev", [[1, "North", 12.5], [2, "South", 20.0]]),
        ("prod", [[3, "East", 100.0]]),
    ):
        run = wait_run(instance.store, instance.engine.launch(worktree["id"], environment), timeout=60)
        assert run["status"] == "success", run
        preview = instance.engine.preview(worktree["id"], environment, "orders")
        assert sorted(row["values"] for row in preview["rows"]) == rows
