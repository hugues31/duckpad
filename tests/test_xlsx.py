"""XLSX acceptance coverage against real workbooks and the isolated SQL worker."""

import copy
import shutil

import duckdb
import pytest
from fastapi.testclient import TestClient
from helpers import enable_excel, wait_run
from xlsx_fixture import workbook

from duckpad.app import create_app
from duckpad.auth import Auth
from duckpad.builtin_templates import BUILTINS
from duckpad.bundle import bundle_to_files
from duckpad.services import Services
from duckpad.store import Store
from duckpad.templates import compile_template, parse_template
from duckpad.util import Problem


@pytest.fixture(params=[False, True], ids=["embedded", "isolated"])
def xlsx_services(tmp_path, excel_cache, request):
    instance = Services.open(tmp_path / "instance", enforce_access=request.param)
    shutil.copytree(excel_cache, instance.store.home / "extensions")
    yield instance
    instance.close()


def connect(catalog, roots):
    """A server folder holding workbooks, with a root per environment."""
    catalog.save(
        "connection",
        {
            "id": "workbooks",
            "name": "Workbooks",
            "connector": "local",
            "environments": {env: {"root": str(root)} for env, root in roots.items()},
        },
        create=True,
    )


def source_bundle(params=None):
    return enable_excel(
        {
            "flow": {
                "nodes": [{"id": "source", "template": "load_xlsx", "params": params or {}}],
                "edges": [],
            },
            "templates": BUILTINS.copy(),
            "components": {},
            "documentation": {},
        }
    )


def project(instance, bundle, connections=()):
    worktree = instance.projects.create("Spreadsheets", bundle)
    if instance.engine.access:
        Auth(instance.store)
        instance.engine.access.own(worktree, {"id": "admin"}, list(connections))
    return worktree["id"]


def project_files(instance, worktree):
    """The project's resources, where uploads land and relative project file sources resolve."""
    folder = instance.store.paths.resources(instance.projects.get(worktree)["project"])
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def replace_source(instance, worktree, **params):
    snapshot = instance.projects.snapshot(worktree)
    bundle = snapshot["bundle"]
    bundle["flow"]["nodes"][0]["params"] = params
    instance.projects.write(worktree, snapshot["revision"], bundle_to_files(bundle))


def test_fresh_catalog_offers_no_excel_connector(tmp_path):
    # XLSX is a format: workbooks use project files or a file storage connection.
    store = Store(tmp_path)
    try:
        assert {connector["id"] for connector in store.all("connector")} == {"local", "s3", "oracle"}
    finally:
        store.close()


def test_xlsx_import_transform_lineage_export_replacement_and_environments(xlsx_services, tmp_path):
    instance = xlsx_services
    dev, prod = tmp_path / "dev", tmp_path / "prod"
    dev.mkdir()
    prod.mkdir()
    workbook(dev / "workbook.xlsx")
    connect(instance.catalog, {"dev": dev, "prod": prod})
    bundle = source_bundle({"connection": "workbooks", "sheet": "Orders"})
    bundle["templates"]["totals"] = (
        "-- @input source\n-- @output result\n"
        "SELECT region, SUM(amount) AS amount FROM {{ source }} GROUP BY region ORDER BY region;"
    )
    bundle["flow"]["nodes"] += [
        {"id": "totals", "template": "totals", "params": {}},
        {
            "id": "export",
            "template": "export_xlsx",
            "params": {"connection": "workbooks", "sheet": "Regional totals"},
        },
    ]
    bundle["flow"]["edges"] = [
        {"id": str(i), "source": source, "sourceHandle": "result", "target": target, "targetHandle": "source"}
        for i, (source, target) in enumerate((("source", "totals"), ("totals", "export")))
    ]
    worktree = project(instance, bundle, ["workbooks"])
    for _ in range(2):
        run = wait_run(instance.store, instance.engine.launch(worktree, "dev"), timeout=30)
        assert run["status"] == "success", run
        assert run["nodes"]["export"]["external_outcome"] == "completed"
    preview = instance.engine.preview(worktree, "dev", "source")
    assert preview["rows"][0]["values"] == [1, "North", 12.5, "2024-01-02", True, "O'Brien & Sons"]
    assert preview["rows"][2]["values"][-1] is None
    explanation = instance.lineage.explain(worktree, "dev", preview["id"], 0, "amount")
    assert explanation["complete"] and explanation["kind"] == "source"
    assert explanation["value"] == 12.5
    with duckdb.connect(config={"extension_directory": str(instance.store.home / "extensions")}) as db:
        db.execute("LOAD excel")
        assert db.execute(
            "SELECT * FROM read_xlsx(?, sheet='Regional totals', header=true)", [str(dev / "export.xlsx")]
        ).fetchall() == [("North", 20), ("South", 20)]
        db.execute(
            "COPY (SELECT 'East' AS region, 100 AS amount) TO ? (FORMAT XLSX, HEADER true, SHEET 'Orders')",
            [str(prod / "workbook.xlsx")],
        )
    run = wait_run(instance.store, instance.engine.launch(worktree, "prod"), timeout=30)
    assert run["status"] == "success", run
    assert instance.engine.preview(worktree, "prod", "totals")["rows"][0]["values"] == ["East", 100]
    assert (prod / "export.xlsx").is_file()
    assert instance.engine.preview(worktree, "dev", "totals")["rows"][0]["values"] == ["North", 20]


def test_xlsx_first_sheet_headerless_and_mixed_columns(xlsx_services):
    instance = xlsx_services
    worktree = project(instance, source_bundle())
    workbook(project_files(instance, worktree) / "workbook.xlsx")
    for params, expected in [
        ({}, [[999]]),
        ({"sheet": "Raw", "header": False}, [[1, 10], [2, 20]]),
        ({"sheet": "Mixed", "all_varchar": True}, [["10"], ["pending"]]),
    ]:
        replace_source(instance, worktree, **params)
        run = wait_run(instance.store, instance.engine.launch(worktree, "dev"), timeout=30)
        assert run["status"] == "success", run
        preview = instance.engine.preview(worktree, "dev", "source")
        assert [row["values"] for row in preview["rows"]] == expected


def test_xlsx_failures_preserve_previous_result(xlsx_services):
    instance = xlsx_services
    worktree = project(instance, source_bundle())
    root = project_files(instance, worktree)
    workbook(root / "workbook.xlsx")
    (root / "broken.xlsx").write_text("Not a workbook")
    first = wait_run(instance.store, instance.engine.launch(worktree, "dev"), timeout=30)
    assert first["status"] == "success", first
    for params in [
        {"sheet": "Absent"},
        {"file": "missing.xlsx"},
        {"file": "broken.xlsx"},
        {"sheet": "Mixed"},
    ]:
        replace_source(instance, worktree, **params)
        run = wait_run(instance.store, instance.engine.launch(worktree, "dev"), timeout=30)
        assert run["status"] == "failed", run
        assert run["nodes"]["source"]["error"]
        preview = instance.engine.preview(worktree, "dev", "source")
        assert preview["status"] == "stale"
        assert preview["rows"][0]["values"] == [999]


def test_xlsx_api_upload_needs_no_connection_and_blocks_outside_files(tmp_path, excel_cache):
    app = create_app(tmp_path / "instance", watch=False)
    instance = app.state.services
    shutil.copytree(excel_cache, instance.store.home / "extensions")
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        worktree = client.post("/api/projects", json={"name": "XLSX uploads"}).json()
        identity = worktree["id"]
        source = workbook(tmp_path / "outside.xlsx")
        uploaded = client.post(
            f"/api/worktrees/{identity}/uploads",
            files={
                "file": (
                    "orders.xlsx",
                    source.read_bytes(),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert uploaded.status_code == 200
        snapshot = client.get(f"/api/worktrees/{identity}").json()
        bundle = source_bundle({"file": uploaded.json()["path"], "sheet": "Orders"})
        assert (
            client.put(
                f"/api/worktrees/{identity}", json={"revision": snapshot["revision"], "bundle": bundle}
            ).status_code
            == 200
        )
        assert client.get(f"/api/worktrees/{identity}/compile/source?environment=dev").status_code == 200
        run = client.post(f"/api/worktrees/{identity}/runs", json={"environment": "dev"})
        assert run.status_code == 200, run.text
        assert wait_run(instance.store, run.json(), timeout=30)["status"] == "success"
        replace_source(instance, identity, file=str(source))
        failed = wait_run(instance.store, instance.engine.launch(identity, "dev"), timeout=30)
        assert failed["status"] == "failed", failed
        assert "Permission Error: Cannot access file" in failed["nodes"]["source"]["error"]
        readonly = copy.deepcopy(instance.store.get("connector", "local"))
        readonly.update(id="readonly_folder", capabilities=["read"])
        instance.catalog.save("connector", readonly)
        connection = {
            "id": "workbooks",
            "name": "Workbooks",
            "connector": "readonly_folder",
            "environments": {"dev": {}},
        }
        instance.catalog.save("connection", connection, create=True)
        with pytest.raises(Problem, match="does not support write"):
            compile_template(
                parse_template(BUILTINS["export_xlsx"]),
                {"connection": "workbooks"},
                {"source": '"data"'},
                {},
                instance.catalog.capture(["workbooks"], "dev")[0],
                instance.store.paths.project_files(worktree["project"], identity, "dev"),
            )
