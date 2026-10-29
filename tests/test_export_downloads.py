"""Download complete file exports through the authenticated API and isolated worker."""

import csv
import io
import os
import shutil
import threading
import zipfile
from pathlib import Path
from urllib.parse import quote
from xml.etree import ElementTree

import duckdb
import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.artifacts import CHUNK_SIZE, open_regular
from duckpad.builtin_templates import BUILTINS
from duckpad.bundle import bundle_to_files
from duckpad.util import digest


@pytest.fixture(scope="module")
def export_excel_cache(tmp_path_factory):
    cache = tmp_path_factory.mktemp("export-excel")
    with duckdb.connect(config={"extension_directory": str(cache)}) as db:
        db.execute("INSTALL excel")
    return cache


@pytest.fixture
def instance(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        yield app.state.services, client


def create(instance, format_name="csv", **params):
    services, client = instance
    worktree = client.post("/api/projects", json={"name": "Export downloads"}).json()
    bundle = {
        "flow": {
            "nodes": [
                {"id": "source", "template": "rows", "params": {}},
                {"id": "export", "template": "export_" + format_name, "params": params},
            ],
            "edges": [
                {
                    "id": "edge",
                    "source": "source",
                    "sourceHandle": "result",
                    "target": "export",
                    "targetHandle": "source",
                }
            ],
        },
        "templates": {
            **BUILTINS,
            "rows": "-- @kind source\n-- @output result\nSELECT range AS id, 'item;' || range AS label FROM range(1003);",
        },
        "components": {},
        "documentation": {},
    }
    snapshot = services.projects.snapshot(worktree["id"])
    services.projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    return worktree, f"/api/worktrees/{worktree['id']}/exports/export"


def execute(services, worktree, environment="dev", target=None):
    run = services.engine.launch(worktree["id"], environment, target)
    result = services.engine.wait(run["id"], timeout=30)
    assert result["status"] == "success", result
    return result


def edit(services, worktree, change):
    snapshot = services.projects.snapshot(worktree["id"])
    change(snapshot["bundle"])
    services.projects.write(worktree["id"], snapshot["revision"], bundle_to_files(snapshot["bundle"]))


def download(client, endpoint, run, environment="dev", **kwargs):
    return client.get(endpoint + "/download", params={"environment": environment, "run": run["id"]}, **kwargs)


@pytest.mark.parametrize("format_name", ["csv", "xlsx"])
@pytest.mark.parametrize("header", [True, False])
def test_contents_options_and_response_metadata(instance, export_excel_cache, format_name, header):
    services, client = instance
    filename = "Quarterly résumé." + format_name
    if format_name == "xlsx":
        shutil.copytree(export_excel_cache, services.store.home / "extensions")
        client.put(
            "/api/catalog/connection?create=true",
            json={"id": "xlsx", "name": "Sheets", "connector": "xlsx", "environments": {"dev": {}}},
        )
    worktree, endpoint = create(
        instance, format_name, destination=filename, header=header, delimiter=";", sheet="Full export"
    )
    if format_name == "xlsx":
        client.put(
            f"/api/projects/{worktree['project']}/connections", json={"connections": ["local", "xlsx"]}
        )
    assert client.get(endpoint, params={"environment": "dev"}).json()["status"] == "not_run"
    run = execute(services, worktree)
    info = client.get(endpoint, params={"environment": "dev"}).json()
    assert info["status"] == "available", info
    assert info["run"] == run["id"]
    assert info["filename"] == filename
    assert "artifact" not in info and "path" not in info
    response = download(client, endpoint, run)
    assert response.status_code == 200, response.text
    assert response.headers["content-disposition"] == "attachment; filename*=UTF-8''" + quote(
        filename, safe=""
    )
    assert int(response.headers["content-length"]) == len(response.content)
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    original = services.engine.exports(worktree["id"], "dev") / filename
    assert response.content == original.read_bytes()
    if format_name == "csv":
        assert response.headers["content-type"].startswith("text/csv")
        rows = list(csv.reader(io.StringIO(response.text), delimiter=";"))
        if header:
            assert rows.pop(0) == ["id", "label"]
        assert len(rows) == 1003
        assert rows[0] == ["0", "item;0"] and rows[-1] == ["1002", "item;1002"]
    else:
        assert (
            response.headers["content-type"]
            == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            namespace = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            book = ElementTree.fromstring(archive.read("xl/workbook.xml"))
            assert book.find("s:sheets/s:sheet", namespace).attrib["name"] == "Full export"
            sheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            assert len(sheet.findall("s:sheetData/s:row", namespace)) == 1003 + header
        with duckdb.connect(config={"extension_directory": str(export_excel_cache)}) as db:
            db.execute("LOAD excel")
            rows = db.execute(
                "SELECT * FROM read_xlsx(?, sheet='Full export', header=?)", [str(original), header]
            ).fetchall()
            assert len(rows) == 1003
            assert rows[0] == (0, "item;0") and rows[-1] == (1002, "item;1002")
    # This execution's private copy remains exact even if a shared destination is overwritten.
    original.write_bytes(b"a later writer")
    assert download(client, endpoint, run).content == response.content


def test_authentication_roles_and_context_scoping(instance):
    services, client = instance
    worktree, endpoint = create(instance)
    run = execute(services, worktree)
    assert download(client, endpoint, run, headers={"cookie": ""}).status_code == 401
    app = client.app
    reader = app.state.auth.create_user("reader", "export-test-password", "member")
    token = app.state.auth.login("reader", "export-test-password", peer="reader")
    headers = {"cookie": "", "authorization": "Bearer " + token}
    assert download(client, endpoint, run, headers=headers).status_code == 404
    app.state.access.member(worktree["project"], reader["id"], "reader")
    assert download(client, endpoint, run, headers=headers).status_code == 200
    other, other_endpoint = create(instance)
    other_run = execute(services, other)
    assert download(client, endpoint, other_run).status_code == 409
    assert download(client, other_endpoint, run, headers=headers).status_code == 404
    branch = services.projects.branch(worktree["id"], "download-branch")
    assert download(client, f"/api/worktrees/{branch['id']}/exports/export", run).status_code == 409
    assert download(client, endpoint, run, environment="prod").status_code == 409
    assert client.get(endpoint, params={"environment": "../dev"}).status_code == 404
    for identity in (
        "../../instance.sqlite",
        "/etc/passwd",
        run["nodes"]["export"]["artifact"],
        other_run["id"],
    ):
        assert download(client, endpoint, {"id": identity}).status_code == 409
    # Even a corrupted node record cannot borrow another context's artifact.
    key = digest([worktree["id"], "dev", "export"])
    record = services.store.get("export_result", key)
    services.store.put("export_result", key, {**record, "artifact": other_run["nodes"]["export"]["artifact"]})
    assert download(client, endpoint, run).status_code == 404
    app.state.access.member(worktree["project"], reader["id"], None)
    assert download(client, endpoint, run, headers=headers).status_code == 404


def test_stale_failed_running_and_replaced_results(instance, monkeypatch):
    services, client = instance
    worktree, endpoint = create(instance)
    first = execute(services, worktree)
    edit(services, worktree, lambda b: b["flow"]["nodes"][1]["params"].update(delimiter=";"))
    assert client.get(endpoint, params={"environment": "dev"}).json()["status"] == "stale"
    assert download(client, endpoint, first).status_code == 409
    second = execute(services, worktree)
    assert download(client, endpoint, first).status_code == 409
    assert download(client, endpoint, second).status_code == 200
    execute(services, worktree, target="source")
    assert client.get(endpoint, params={"environment": "dev"}).json()["status"] == "stale"
    edit(
        services,
        worktree,
        lambda b: b["templates"].update(
            rows="-- @kind source\n-- @output result\nSELECT error('failed source');"
        ),
    )
    failed = services.engine.wait(services.engine.launch(worktree["id"], "dev")["id"], 30)
    assert failed["status"] == "failed"
    assert client.get(endpoint, params={"environment": "dev"}).json()["status"] == "failed"
    assert download(client, endpoint, second).status_code == 409
    edit(
        services,
        worktree,
        lambda b: b["templates"].update(rows="-- @kind source\n-- @output result\nSELECT 42 AS id;"),
    )
    entered, release = threading.Event(), threading.Event()
    original = services.engine._compute

    def delayed(*args):
        entered.set()
        assert release.wait(10)
        return original(*args)

    monkeypatch.setattr(services.engine, "_compute", delayed)
    pending = services.engine.launch(worktree["id"], "dev")
    try:
        assert entered.wait(5)
        assert client.get(endpoint, params={"environment": "dev"}).json()["status"] == "running"
        assert download(client, endpoint, second).status_code == 409
    finally:
        release.set()
        services.engine.wait(pending["id"], 30)
    assert client.get(endpoint, params={"environment": "dev"}).json()["status"] == "available"


@pytest.mark.parametrize("replacement", ["missing", "symlink", "modified", "directory", "parent_symlink"])
def test_missing_or_replaced_artifacts_are_unavailable(instance, tmp_path, replacement):
    services, client = instance
    worktree, endpoint = create(instance)
    run = execute(services, worktree)
    artifact = services.store.home / "artifacts" / run["nodes"]["export"]["artifact"]
    artifact.unlink()
    if replacement == "symlink":
        artifact.symlink_to(services.store.home / "instance.sqlite")
    elif replacement == "modified":
        artifact.write_text("other data")
    elif replacement == "directory":
        artifact.mkdir()
    elif replacement == "parent_symlink":
        outside = tmp_path / "replacement"
        artifact.parent.rename(outside)
        artifact.parent.symlink_to(outside, target_is_directory=True)
    assert client.get(endpoint, params={"environment": "dev"}).json()["status"] == "missing"
    assert download(client, endpoint, run).status_code == 404


def test_source_capture_rejects_symlinks_traversal_and_special_files(instance, tmp_path):
    services, _ = instance
    worktree, _ = create(instance)
    run = execute(services, worktree)
    root = services.engine.exports(worktree["id"], "dev")
    original = root / "export.csv"
    link = root / "link.csv"
    link.symlink_to(original)
    parent = root / "linked"
    parent.symlink_to(root, target_is_directory=True)
    fifo = root / "pipe.csv"
    os.mkfifo(fifo)
    for path in (
        link,
        parent / "export.csv",
        root / ".." / "dev" / "export.csv",
        fifo,
        root,
        services.store.home / "instance.sqlite",
    ):
        with pytest.raises(OSError, match=r".+"):
            services.engine.artifacts.capture({"path": str(path), "format": "csv"}, run, "export", [root])
    with open_regular(original) as stream:
        assert len(stream.read(CHUNK_SIZE)) > 0


def test_restart_and_project_deletion(instance):
    services, client = instance
    worktree, endpoint = create(instance)
    run = execute(services, worktree)
    expected = download(client, endpoint, run).content
    # Closing live results does not discard the durable export record or its private file.
    services.engine.reset_project(worktree["project"])
    assert download(client, endpoint, run).content == expected
    services.engine.close()
    from duckpad.engine import Engine

    restarted = Engine(services.store, services.projects, services.catalog, services.engine.access)
    try:
        assert restarted.export_result(worktree["id"], "dev", "export")["status"] == "available"
    finally:
        restarted.close()
    assert client.delete(f"/api/projects/{worktree['project']}").status_code == 200
    assert not services.store.all("artifact") and not services.store.all("export_result")
    assert not list((services.store.home / "artifacts").iterdir())


def test_remote_and_non_file_destinations_have_no_download(instance):
    services, client = instance
    worktree, endpoint = create(instance, "oracle")
    assert client.get(endpoint, params={"environment": "dev"}).json()["status"] == "unsupported"
    edit(
        services,
        worktree,
        lambda b: b["flow"]["nodes"][1].update(
            template="export_csv", params={"destination": "s3://bucket/export.csv"}
        ),
    )
    assert client.get(endpoint, params={"environment": "dev"}).json()["status"] == "unsupported"


def test_streams_in_bounded_chunks_and_closes_the_file(instance, monkeypatch):
    from contextlib import contextmanager

    from duckpad import artifacts

    services, client = instance
    worktree, endpoint = create(instance)
    edit(
        services,
        worktree,
        lambda b: b["templates"].update(
            rows="-- @kind source\n-- @output result\nSELECT range AS id, repeat('x', 200) AS label FROM range(1003);"
        ),
    )
    run = execute(services, worktree)
    read_sizes, streams = [], []
    original = artifacts.open_regular

    @contextmanager
    def tracked(path):
        with original(path) as stream:
            if Path(path).parent.name == "artifacts":
                streams.append(stream)
                read = stream.read

                def bounded(size=-1):
                    assert size == CHUNK_SIZE
                    read_sizes.append(size)
                    return read(size)

                monkeypatch.setattr(stream, "read", bounded)
            yield stream

    monkeypatch.setattr(artifacts, "open_regular", tracked)
    response = download(client, endpoint, run)
    assert response.status_code == 200
    assert len(response.content) > 3 * CHUNK_SIZE
    assert len(read_sizes) > 3
    assert streams and all(stream.closed for stream in streams)


def test_completed_contexts_do_not_replace_each_other_and_grants_are_rechecked(instance):
    services, client = instance
    worktree, endpoint = create(instance)
    dev = execute(services, worktree)
    prod = execute(services, worktree, "prod")
    branch = services.projects.branch(worktree["id"], "other-export")
    branch_run = execute(services, branch)
    assert download(client, endpoint, dev).status_code == 200
    assert download(client, endpoint, prod, "prod").status_code == 200
    assert download(client, endpoint, prod).status_code == 409
    assert download(client, endpoint, dev, "prod").status_code == 409
    assert download(client, endpoint, branch_run).status_code == 409
    assert (
        client.put(f"/api/projects/{worktree['project']}/connections", json={"connections": []}).status_code
        == 200
    )
    assert client.get(endpoint, params={"environment": "dev"}).json()["status"] == "stale"
    assert download(client, endpoint, dev).status_code == 409


def test_two_nodes_sharing_a_destination_keep_their_own_export(instance):
    services, client = instance
    worktree, endpoint = create(instance)

    def add_second(bundle):
        bundle["templates"]["other"] = "-- @kind source\n-- @output result\nSELECT 42 AS other_value;"
        bundle["flow"]["nodes"] += [
            {"id": "other", "template": "other", "params": {}},
            {"id": "second", "template": "export_csv", "params": {}},
        ]
        bundle["flow"]["edges"].append(
            {
                "id": "second",
                "source": "other",
                "sourceHandle": "result",
                "target": "second",
                "targetHandle": "source",
            }
        )

    edit(services, worktree, add_second)
    run = execute(services, worktree)
    assert download(client, endpoint, run).text.startswith("id,label\n")
    assert download(client, endpoint.rsplit("/", 1)[0] + "/second", run).text == "other_value\n42\n"
