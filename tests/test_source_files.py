"""Source discovery and previews never run a flow or expose server paths."""

import io
import json
import zipfile
from pathlib import Path

import duckdb
import pytest
from fastapi.testclient import TestClient
from helpers import wait_run
from xlsx_fixture import workbook

from duckpad.app import create_app
from duckpad.source_files import read_sample


@pytest.fixture
def source(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        tree = client.post("/api/projects", json={"name": "Sources"}).json()
        yield app, client, f"/api/worktrees/{tree['id']}"


def upload(client, url, name="customers.csv", content=b"id;name\n1;Alice\n2;Bob\n"):
    result = client.post(url + "/uploads", files={"file": (name, content)})
    assert result.status_code == 200, result.text
    return result.json()


def test_upload_preview_run_and_zip_use_relative_files(source):
    app, client, url = source
    uploaded = upload(client, url)
    assert not Path(uploaded["path"]).is_absolute()
    assert uploaded["template"] == "load_csv"
    files = client.get(url + "/source-files").json()
    assert files == [{"path": uploaded["path"], "name": "customers.csv"}]
    preview = client.post(url + "/source-preview", json={"file": uploaded["path"]})
    assert preview.status_code == 200, preview.text
    result = preview.json()
    assert result["settings"] == {"delimiter": ";", "header": True}
    assert result["rows"] == [[1, "Alice"], [2, "Bob"]]
    assert result["columns"] == [{"name": "id", "type": "BIGINT"}, {"name": "name", "type": "VARCHAR"}]
    assert app.state.services.store.all("run") == []
    snapshot = client.get(url).json()
    snapshot["bundle"]["flow"]["nodes"] = [
        {
            "id": "customers",
            "label": uploaded["name"],
            "template": uploaded["template"],
            "params": {"file": uploaded["path"], **result["settings"]},
            "position": {"x": 0, "y": 0},
        }
    ]
    saved = client.put(url, json={"revision": snapshot["revision"], "bundle": snapshot["bundle"]})
    assert saved.status_code == 200, saved.text
    services = app.state.services
    run = wait_run(services.store, services.engine.launch(snapshot["worktree"]["id"], "dev"))
    assert run["status"] == "success", run
    archive = client.get(url + "/archive.zip")
    assert archive.status_code == 200, archive.text
    with zipfile.ZipFile(io.BytesIO(archive.content)) as zipped:
        assert all(str(services.store.home) not in zipped.read(name).decode() for name in zipped.namelist())
    assert str(services.store.home) not in json.dumps(client.get(url).json()["files"])


def test_preview_options_limit_and_errors(source):
    app, client, url = source
    data = b"id;name\n" + b"001;Alice\n" * 40
    uploaded = upload(client, url, content=data)
    response = client.post(
        url + "/source-preview",
        json={"file": uploaded["path"], "delimiter": ";", "header": True, "types": {"id": "VARCHAR"}},
    )
    assert response.status_code == 200, response.text
    assert response.json()["rows"] == [["001", "Alice"]] * 20
    no_header = client.post(url + "/source-preview", json={"file": uploaded["path"], "header": False})
    assert no_header.json()["rows"][0] == ["id", "name"]
    bad = client.post(url + "/source-preview", json={"file": uploaded["path"], "types": {"name": "INTEGER"}})
    # A failed override keeps the detected columns, so the types table can correct it.
    assert bad.status_code == 200, bad.text
    assert bad.json()["rows"] == []
    assert [column["name"] for column in bad.json()["detected_columns"]] == ["id", "name"]
    assert str(app.state.services.store.home) not in bad.text
    assert "customers.csv" in bad.json()["error"]
    broken = upload(client, url, name="broken.parquet", content=b"not parquet")
    unreadable = client.post(url + "/source-preview", json={"file": broken["path"]})
    assert unreadable.status_code == 422
    assert str(app.state.services.store.home) not in unreadable.text


@pytest.mark.parametrize(
    "file", ["../outside.csv", "/etc/passwd", "https://example.invalid/data.csv", "missing.csv"]
)
def test_preview_rejects_external_and_missing_paths(source, file):
    _, client, url = source
    response = client.post(url + "/source-preview", json={"file": file})
    assert response.status_code in (400, 404, 422)


def test_uploads_of_the_same_name_are_listed_in_upload_order(source):
    _, client, url = source
    first = upload(client, url, name="b.csv")["path"]
    second = upload(client, url, name="b.csv")["path"]
    other = upload(client, url, name="a.csv")["path"]
    assert [file["path"] for file in client.get(url + "/source-files").json()] == [other, first, second]


def test_file_listing_is_project_scoped_and_hides_symlinks(source, tmp_path):
    app, client, url = source
    uploaded = upload(client, url)
    other = client.post("/api/projects", json={"name": "Other"}).json()
    other_url = f"/api/worktrees/{other['id']}"
    assert client.get(other_url + "/source-files").json() == []
    assert client.post(other_url + "/source-preview", json={"file": uploaded["path"]}).status_code == 404
    tree = app.state.services.projects.get(url.rsplit("/", 1)[1])
    folder = app.state.services.store.paths.resources(tree["project"])
    outside = tmp_path / "outside.csv"
    outside.write_text("secret\n1\n")
    (folder / "linked.csv").symlink_to(outside)
    assert len(client.get(url + "/source-files").json()) == 1
    assert client.post(url + "/source-preview", json={"file": "linked.csv"}).status_code == 400


@pytest.mark.parametrize("kind", ["parquet", "json", "xlsx"])
def test_other_source_formats(kind, tmp_path, excel_cache):
    path = tmp_path / f"source.{kind}"
    with duckdb.connect(config={"extension_directory": str(excel_cache)}) as db:
        if kind == "xlsx":
            workbook(path)
            db.execute("LOAD excel")
            options = {"sheet": "Orders"}
        elif kind == "parquet":
            db.execute("COPY (SELECT 1 AS id) TO ? (FORMAT PARQUET)", [str(path)])
            options = {}
        else:
            path.write_text('[{"id": 1}]')
            options = {}
        result = read_sample(db, str(path), options)
        assert result["rows"][0][0] == 1
