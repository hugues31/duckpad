"""Run project statistics in both execution modes with server networking disabled.

Download duckfn_statrs outside the namespace, then pass its compressed binary.
This check uses disposable instances and never downloads or changes an existing instance.
"""

import argparse
import copy
import io
import json
import socket
import tempfile
import time
from pathlib import Path

import duckdb

from duckpad.archive import read_archive, write_archive
from duckpad.bundle import bundle_to_files, files_to_bundle
from duckpad.extensions import database_config, runtime
from duckpad.services import Services
from duckpad.util import Problem

QUERY = """SELECT sr_normal_cdf(0.0, 0.0, 1.0) AS cdf_0,
    sr_normal_cdf(1.96, 0.0, 1.0) AS cdf_196,
    sr_normal_pdf(0.0, 0.0, 1.0) AS pdf_0,
    sr_normal_quantile(0.975, 0.0, 1.0) AS quantile_975"""
EXPECTED = [0.5, 0.9750021048529024, 0.39894228040143265, 1.9599639845400538]
REQUIREMENTS = {"duckfn_statrs": {"source": "community", "enabled": True}}


def wait(instance, worktree):
    run = instance.engine.launch(worktree, "dev", entry_point="scheduler")
    deadline = time.monotonic() + 30
    while run["status"] in ("preparing", "running", "canceling"):
        if time.monotonic() > deadline:
            raise AssertionError("The execution did not finish within 30 seconds")
        time.sleep(0.01)
        run = instance.store.get("run", run["id"])
    return run


def verify(binary):
    assert [name for _, name in socket.if_nameindex()] == ["lo"], "Use an isolated network namespace"
    version, platform = runtime()
    report = {"version": version, "platform": platform, "network_interfaces": ["lo"], "checks": []}
    with tempfile.TemporaryDirectory(prefix="duckpad-project-extensions-") as temporary:
        root = Path(temporary)
        with duckdb.connect(config=database_config(root / "negative")) as db:
            try:
                db.execute("INSTALL duckfn_statrs FROM community")
            except duckdb.Error:
                report["checks"].append("uncached_install_fails_without_network")
            else:
                raise AssertionError("Negative control unexpectedly installed from the Internet")
        for isolated in (False, True):
            mode = "isolated" if isolated else "embedded"
            home = root / mode
            instance = Services.open(home, enforce_access=isolated)
            bundle = {
                "flow": {"nodes": [{"id": "source", "template": "statistics", "params": {}}], "edges": []},
                "templates": {"statistics": "-- @kind source\n-- @output result\n" + QUERY + ";"},
                "documentation": {},
                "components": {},
                "extensions": copy.deepcopy(REQUIREMENTS),
            }
            try:
                with binary.open("rb") as stream:
                    instance.engine.import_extension(binary.name, "community", stream)
                worktree = instance.projects.create("Normal distribution", bundle)
                identity = worktree["id"]
                if isolated:
                    instance.engine.access.grant_connections(worktree["project"], [])
                assert (
                    instance.engine.check_project_extension(identity, "duckfn_statrs", "community")["status"]
                    == "ready"
                )
                run = wait(instance, identity)
                assert run["status"] == "success", run
                assert run["connections"] == {} and run["extensions"] == REQUIREMENTS
                assert instance.engine.preview(identity, "dev", "source")["rows"][0]["values"] == EXPECTED
                report["checks"].append(f"{mode}_cdf_density_quantile_without_connection")
                unrelated = copy.deepcopy(bundle)
                unrelated.pop("extensions")
                other = instance.projects.create("No activation", unrelated)
                if isolated:
                    instance.engine.access.grant_connections(other["project"], [])
                assert wait(instance, other["id"])["status"] == "failed"
                report["checks"].append(f"{mode}_unrelated_project_has_no_statistics")
                snapshot = instance.projects.snapshot(identity)
                archived = write_archive(snapshot["files"])
                snapshot["bundle"]["extensions"]["duckfn_statrs"]["enabled"] = False
                instance.projects.write(identity, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
                assert wait(instance, identity)["status"] == "failed"
                report["checks"].append(f"{mode}_deactivation_removes_functions_from_new_session")
                snapshot = instance.projects.snapshot(identity)
                instance.projects.write(identity, snapshot["revision"], read_archive(io.BytesIO(archived)))
                # Existing connector requirements still work, without a project activation.
                instance.catalog.save(
                    "connector",
                    {
                        "id": "statistics",
                        "family": "database",
                        "name": "Statistics",
                        "parameters": [],
                        "extensions": [{"name": "duckfn_statrs", "repository": "community"}],
                        "capabilities": ["read"],
                        "init_sql": "",
                    },
                )
                instance.catalog.save(
                    "connection",
                    {
                        "id": "statistics",
                        "name": "Statistics",
                        "connector": "statistics",
                        "environments": {"dev": {}},
                    },
                    create=True,
                )
                unrelated["templates"]["statistics"] = (
                    '-- @param statistics: connection = "statistics"\n' + unrelated["templates"]["statistics"]
                )
                connector = instance.projects.create("Connector regression", unrelated)
                if isolated:
                    instance.engine.access.grant_connections(connector["project"], ["statistics"])
                assert wait(instance, connector["id"])["status"] == "success"
                report["checks"].append(f"{mode}_connector_loading_preserved")
                assert not instance.engine.extension_settings()["allow_unsigned_extensions"]
            finally:
                instance.close()
            for _ in range(2):
                instance = Services.open(home, enforce_access=isolated)
                try:
                    assert wait(instance, identity)["status"] == "success"
                    assert instance.engine.preview(identity, "dev", "source")["rows"][0]["values"] == EXPECTED
                finally:
                    instance.close()
            report["checks"].append(f"{mode}_scheduled_entry_after_two_restarts")
            destination = Services.open(root / (mode + "-destination"), enforce_access=isolated)
            try:
                imported = destination.projects.create(
                    "Shared statistics", files_to_bundle(read_archive(io.BytesIO(archived)))
                )
                if isolated:
                    destination.engine.access.grant_connections(imported["project"], [])
                state = destination.engine.project_extensions(imported["id"])["requirements"][0]
                assert state["enabled"] and state["source"] == "community" and state["status"] == "missing"
                try:
                    destination.engine.launch(imported["id"], "dev")
                except Problem as error:
                    if "Import duckfn_statrs from community" not in str(error):
                        raise AssertionError(str(error)) from error
                else:
                    raise AssertionError("Missing requirement was silently ignored")
                report["checks"].append(f"{mode}_shared_requirements_preserved_without_binary")
            finally:
                destination.close()
    report["values"] = dict(zip(("cdf_0", "cdf_196", "pdf_0", "quantile_975"), EXPECTED, strict=True))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = verify(args.binary.resolve())
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
