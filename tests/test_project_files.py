"""Project files: uploads and exports that file nodes read and write without any connection."""

import shutil

import duckdb
import pytest
from helpers import enable_excel, wait_run
from xlsx_fixture import workbook

from duckpad.auth import Auth
from duckpad.builtin_templates import BUILTINS
from duckpad.bundle import bundle_to_files
from duckpad.services import Services
from duckpad.util import Problem


@pytest.fixture(params=[False, True], ids=["embedded", "isolated"])
def instance(tmp_path, excel_cache, request):
    services = Services.open(tmp_path / "instance", enforce_access=request.param)
    shutil.copytree(excel_cache, services.store.home / "extensions")
    yield services
    services.close()


def node(identity, template, **params):
    return {"id": identity, "template": template, "params": params}


def edge(source, target):
    return {
        "id": f"{source}_{target}",
        "source": source,
        "sourceHandle": "result",
        "target": target,
        "targetHandle": "source",
    }


def budget_bundle():
    bundle = {
        "flow": {
            "nodes": [
                node("budget", "load_xlsx", file="budget.xlsx", sheet="Orders"),
                node("orders", "load_csv", file="orders.csv"),
                node("customers", "load_parquet", file="inbox/customers.parquet"),
                node("orders_export", "export_csv", destination="orders.csv"),
                node("budget_export", "export_xlsx", destination="budget.xlsx", sheet="Budget"),
            ],
            "edges": [edge("orders", "orders_export"), edge("budget", "budget_export")],
        },
        "templates": BUILTINS.copy(),
        "components": {},
        "documentation": {},
    }
    return enable_excel(bundle)


def create(instance, bundle):
    """Create the project as its owner would; access policies grant it no connection."""
    if not instance.engine.access:
        return instance.projects.create("Budget", bundle)
    Auth(instance.store)
    owner = instance.store.get("user", "admin")
    return instance.engine.access.create(
        owner, lambda grant: instance.projects.create("Budget", bundle, record=grant)
    )


def test_file_nodes_read_uploads_and_write_exports_without_a_connection(instance):
    assert instance.store.all("connection") == []
    worktree = create(instance, budget_bundle())
    project, identity = worktree["project"], worktree["id"]
    if instance.engine.access:
        assert instance.engine.access.record(project)["connections"] == []
    resources = instance.store.paths.resources(project)
    (resources / "inbox").mkdir(parents=True)
    workbook(resources / "budget.xlsx")
    (resources / "orders.csv").write_text("id,amount\n1,10\n2,20\n")
    with duckdb.connect() as db:
        db.execute(
            "COPY (SELECT 7 AS customer_id, 'Atlas' AS name) TO ? (FORMAT PARQUET)",
            [str(resources / "inbox" / "customers.parquet")],
        )

    run = wait_run(instance.store, instance.engine.launch(identity, "dev"), timeout=30)

    assert run["status"] == "success", run
    assert run["connections"] == {}
    budget = instance.engine.preview(identity, "dev", "budget")
    assert budget["rows"][0]["values"][:3] == [1, "North", 12.5]
    orders = instance.engine.preview(identity, "dev", "orders")
    assert [row["values"] for row in orders["rows"]] == [[1, 10], [2, 20]]
    customers = instance.engine.preview(identity, "dev", "customers")
    assert [row["values"] for row in customers["rows"]] == [[7, "Atlas"]]
    exports = instance.store.paths.exports(identity, "dev")
    assert (exports / "orders.csv").read_text().splitlines() == ["id,amount", "1,10", "2,20"]
    assert (exports / "budget.xlsx").is_file()
    # The export of the same name never replaces the uploaded source.
    assert (resources / "orders.csv").read_text() == "id,amount\n1,10\n2,20\n"
    assert run["nodes"]["budget_export"]["external_outcome"] == "completed"


def test_a_connection_not_granted_to_the_project_stays_refused(instance, tmp_path):
    share = tmp_path / "share"
    share.mkdir()
    (share / "orders.csv").write_text("id\n1\n")
    instance.catalog.save(
        "connection",
        {
            "id": "share",
            "name": "Finance share",
            "connector": "folder",
            "environments": {"dev": {"root": str(share)}},
        },
        create=True,
    )
    bundle = budget_bundle()
    bundle["flow"]["nodes"] = [node("orders", "load_csv", connection="share", file="orders.csv")]
    bundle["flow"]["edges"] = []
    worktree = create(instance, bundle)
    if not instance.engine.access:
        # Trusted in-process clients have no access policy: every connection is available.
        assert instance.engine.compile(worktree["id"], "dev", "orders")
        return
    with pytest.raises(Problem, match="not authorized") as refused:
        instance.engine.compile(worktree["id"], "dev", "orders")
    assert refused.value.status == 403
    run = wait_run(instance.store, instance.engine.launch(worktree["id"], "dev"), timeout=30)
    assert run["status"] == "failed"
    assert "not authorized" in run["nodes"]["orders"]["error"]
    # Choosing project files again needs no grant.
    snapshot = instance.projects.snapshot(worktree["id"])
    snapshot["bundle"]["flow"]["nodes"][0]["params"]["connection"] = ""
    instance.projects.write(worktree["id"], snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    [statement] = instance.engine.compile(worktree["id"], "dev", "orders")
    resources = instance.store.paths.resources(worktree["project"])
    assert str(resources / "orders.csv") in statement["sql"]
