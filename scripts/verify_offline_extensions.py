"""Verify signed H3 installation and Duckpad execution in a network-isolated Linux process.

See docs/OFFLINE_EXTENSIONS.md for preparation and the unshare command.
This opt-in integration check never downloads its input or changes a real instance.
"""

import argparse
import hashlib
import json
import platform
import shutil
import socket
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

import duckdb

from duckpad.services import Services
from duckpad.util import Problem, literal

QUERY = """SELECT h3_is_valid_cell(h3_latlng_to_cell(48.8566, 2.3522, 9)) AS valid,
                  h3_get_resolution(h3_latlng_to_cell(48.8566, 2.3522, 9)) AS resolution"""


def connect(cache):
    return duckdb.connect(
        config={
            "extension_directories": [str(cache)],
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
        }
    )


def verify_loaded(db):
    assert db.execute("SELECT current_setting('allow_unsigned_extensions')").fetchone() == (False,)
    assert db.execute(QUERY).fetchall() == [(True, 9)]
    row = db.execute(
        "SELECT loaded, installed, install_mode, extension_version "
        "FROM duckdb_extensions() WHERE extension_name = 'h3'"
    ).fetchone()
    assert row[0] and row[1] and row[2] != "STATICALLY_LINKED", row
    return row[3]


def verify_duckpad(home, cache, isolated, allow_unsigned=False, import_file=None):
    instance = Services.open(home, enforce_access=isolated)
    try:
        instance.engine.configure_extensions(allow_unsigned)
        if import_file:
            with import_file.open("rb") as stream:
                instance.engine.import_extension(
                    "h3.duckdb_extension.gz", "unsigned" if allow_unsigned else "community", stream
                )
        else:
            shutil.copytree(cache, home / "extensions")
        instance.catalog.save(
            "connector",
            {
                "id": "h3",
                "name": "Offline H3",
                "parameters": [],
                "extensions": [{"name": "h3", "repository": "community"}],
                "capabilities": ["read"],
                "init_sql": "",
            },
        )
        instance.catalog.save(
            "connection",
            {"id": "h3", "name": "Offline H3", "connector": "h3", "environments": {"dev": {}}},
            create=True,
        )
        worktree = instance.projects.create(
            "Offline extension verification",
            {
                "flow": {"nodes": [{"id": "source", "template": "source", "params": {}}], "edges": []},
                "templates": {
                    "source": '-- @kind source\n-- @param connection: connection = "h3"\n-- @output result\n'
                    + QUERY
                    + ";"
                },
                "components": {},
                "documentation": {},
            },
        )
        if isolated:
            instance.engine.access.own(worktree, {"id": "admin"}, ["local", "h3"])
        worktree_id = worktree["id"]
    finally:
        instance.close()

    # Reopen the entire instance twice: success must survive process-local caches.
    for _ in range(2):
        instance = Services.open(home, enforce_access=isolated)
        try:
            run = instance.engine.launch(worktree_id, "dev")
            deadline = time.monotonic() + 30
            while run["status"] in ("preparing", "running", "canceling"):
                if time.monotonic() > deadline:
                    raise AssertionError("Offline pipeline did not finish within 30 seconds")
                time.sleep(0.01)
                run = instance.store.get("run", run["id"])
            assert run["status"] == "success", run.get("error")
            result = instance.engine.preview(worktree_id, "dev", "source")
            assert [row["values"] for row in result["rows"]] == [[True, 9]], result
            if allow_unsigned:
                instance.engine.configure_extensions(False)
                try:
                    context = instance.engine.context(worktree_id, "dev", create=True)
                    captured, _ = instance.catalog.capture(["h3"], "dev")
                    instance.catalog.prepare(context.db, captured)
                except (duckdb.Error, Problem) as error:
                    if "signature" not in str(error).lower():
                        raise AssertionError(
                            "Disabling unsigned extensions must reject the binary"
                        ) from error
                else:
                    raise AssertionError("Unsigned extension remained usable after disabling the option")
                instance.engine.configure_extensions(True)
        finally:
            instance.close()


def verify(source_cache):
    interfaces = [name for _, name in socket.if_nameindex()]
    if interfaces != ["lo"]:
        raise SystemExit("Run in an isolated Linux network namespace with only loopback (see the guide).")
    report = {
        "verified_at": datetime.now(UTC).isoformat(),
        "python_version": platform.python_version(),
        "network_interfaces": interfaces,
        "extension": "h3",
        "checks": [],
    }
    with tempfile.TemporaryDirectory(prefix="duckpad-offline-") as temporary:
        root = Path(temporary)
        cache = root / "installed"
        with connect(root / "empty") as db:
            report["duckdb_version"] = db.execute("PRAGMA version").fetchone()[0]
            report["duckdb_platform"] = db.execute("PRAGMA platform").fetchone()[0]
            try:
                db.execute("INSTALL h3 FROM community")
            except duckdb.IOException:
                report["checks"].append("uncached_repository_install_fails_without_network")
            else:
                raise AssertionError("Negative control unexpectedly installed H3 without the bundle")

        relative = Path(report["duckdb_version"]) / report["duckdb_platform"] / "h3.duckdb_extension"
        binary = source_cache / relative
        report["binary_sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
        metadata = binary.with_suffix(".duckdb_extension.info")
        report["metadata_sha256"] = hashlib.sha256(metadata.read_bytes()).hexdigest()
        shutil.copytree(source_cache, cache)
        with connect(cache) as db:
            db.execute("INSTALL h3 FROM community")
            db.execute("LOAD h3")
            report["extension_version"] = verify_loaded(db)
        report["checks"].append("transferred_cache_install_load_and_query_with_signature_checks")

        with connect(cache) as db:
            db.execute("LOAD h3")
            verify_loaded(db)
        report["checks"].append("fresh_database_loads_installed_extension")

        tampered_cache = root / "tampered"
        shutil.copytree(source_cache, tampered_cache)
        tampered = tampered_cache / relative
        data = bytearray(binary.read_bytes())
        data[-1] ^= 1
        tampered.write_bytes(data)
        with connect(tampered_cache) as db:
            try:
                db.execute("LOAD h3")
            except duckdb.IOException as error:
                if "signature" not in str(error).lower():
                    raise AssertionError("Expected a signature rejection") from error
            else:
                raise AssertionError("Tampered extension unexpectedly loaded")
        report["checks"].append("tampered_signature_rejected")

        with connect(root / "bare-file") as db:
            try:
                db.execute(f"INSTALL {literal(str(binary))}")
            except duckdb.IOException as error:
                if "signature" not in str(error).lower():
                    raise AssertionError(
                        "Expected a signature rejection without community metadata"
                    ) from error
            else:
                raise AssertionError(
                    "Bare H3 installation behavior changed; update the documented limitation"
                )
        report["checks"].append("bare_community_binary_without_install_metadata_rejected")

        unsigned_cache = root / "unsigned"
        shutil.copytree(tampered_cache, unsigned_cache)
        (unsigned_cache / relative).with_suffix(".duckdb_extension.info").unlink()
        for isolated in (False, True):
            mode = "isolated_worker" if isolated else "embedded"
            verify_duckpad(root / mode, cache, isolated)
            report["checks"].append(f"duckpad_{mode}_pipeline_after_two_reopens")
            verify_duckpad(root / (mode + "-unsigned"), unsigned_cache, isolated, allow_unsigned=True)
            report["checks"].append(f"duckpad_{mode}_unsigned_opt_in_restart_and_revocation")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "cache", type=Path, help="Transferred extension cache containing H3 and its .info file"
    )
    parser.add_argument("--output", type=Path, help="Write a report without host or instance paths")
    args = parser.parse_args()
    report = json.dumps(verify(args.cache.resolve(strict=True)), indent=2) + "\n"
    if args.output:
        args.output.write_text(report, encoding="utf-8")
    print(report, end="")


if __name__ == "__main__":
    main()
