"""Malformed project JSON stays diagnosable instead of breaking snapshot serialization."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.archive import archive_bundle
from duckpad.bundle import files_to_bundle
from duckpad.git.workspace import UNREADABLE, graph_node
from duckpad.json_read import loads
from duckpad.merge import merge_files
from duckpad.project_extensions import activate_file_readers
from duckpad.python_nodes import remember_contracts
from duckpad.util import Problem

INVALID = ["NaN", "Infinity", "-Infinity", "1e400", "-1e400", '"\\ud800"', '"\\udfff"']


# A non-finite number and a lone surrogate; the strict read below covers every invalid value.
# charts.json is read like views.json.
@pytest.mark.parametrize("value", ["NaN", '"\\ud800"'])
@pytest.mark.parametrize("file", ["flow.json", "views.json"])
def test_nonstandard_json_in_a_project_file_has_no_snapshot_500(tmp_path, file, value):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password}).raise_for_status()
        worktree = client.post("/api/projects", json={"name": "Strict JSON"}).json()
        endpoint = f"/api/worktrees/{worktree['id']}"
        snapshot = client.get(endpoint).json()
        text = '{"invalid": [' + value + "]}"
        # Simulate a file arriving outside the editor, such as through Git.
        (Path(snapshot["worktree"]["path"]) / file).write_text(text)
        projects = app.state.services.projects
        projects.git(snapshot["worktree"]["path"], "add", file)
        projects.git(snapshot["worktree"]["path"], "commit", "-m", "test: import malformed JSON")
        response = client.get(endpoint)
        assert response.status_code == 200, response.text
        read = response.json()
        assert read["files"][file] == text
        if file == "flow.json":
            assert read["bundle"] is None
            assert any(d["file"] == file and "Invalid JSON" in d["message"] for d in read["diagnostics"])
            with pytest.raises(Problem) as error:
                files_to_bundle(read["files"])
            assert error.value.status == 422
        else:
            assert read["bundle"][file.removesuffix(".json")] == text
            assert any(d["file"] == file and "not valid JSON" in d["message"] for d in read["diagnostics"])


@pytest.mark.parametrize(
    "text",
    # The last one holds the surrogate itself, as a request body decoded from JSON can.
    [
        *INVALID,
        '{"\\ud800": 1}',
        '{"nested": [{"key": "\\udfff"}]}',
        b'["\\ud800"]',
        '{"é": "\ud800"}',
    ],
)
def test_strict_read_rejects_invalid_values_and_keys(text):
    with pytest.raises(ValueError, match="not valid JSON"):
        loads(text)


def test_strict_read_preserves_valid_unicode_and_finite_numbers():
    assert loads('{"\\ud83e\\udd86": [1.5, 1e300, null, true, "café"]}') == {
        "🦆": [1.5, 1e300, None, True, "café"]
    }


def test_strict_read_takes_git_blobs_as_bytes():
    assert loads('{"a": ["é"]}'.encode()) == {"a": ["é"]}
    # json.loads would decode this encoded surrogate.
    with pytest.raises(UnicodeDecodeError):
        loads(b'["\xed\xa0\x80"]')


@pytest.mark.parametrize("value", INVALID)
def test_other_project_readers_treat_nonstandard_json_as_malformed(value):
    text = '{"nodes": [], "value": ' + value + "}"
    files = {"flow.json": text}
    with pytest.raises(Problem, match=r"flow\.json is not valid JSON"):
        archive_bundle(files.copy())
    assert graph_node(text, "missing") is UNREADABLE
    assert remember_contracts(files) == files
    reader = {"flow.json": text.replace('"nodes": []', '"nodes": [{"id": "input", "preset": "load_xlsx"}]')}
    assert activate_file_readers({}, reader) == reader
    current = {"flow.json": text.replace('"nodes": []', '"nodes": [], "current": true')}
    proposal = {"flow.json": text.replace('"nodes": []', '"nodes": [], "incoming": true')}
    merged, conflicts = merge_files(files, current, proposal)
    assert merged == current
    assert conflicts == ["flow.json"]
