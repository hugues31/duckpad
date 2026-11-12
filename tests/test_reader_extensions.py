"""XLSX uploads and node edits enable Excel as part of the backend save."""

from duckpad.bundle import bundle_to_files
from duckpad.project_extensions import activate_file_readers
from duckpad.util import dumps


def test_saving_an_xlsx_source_enables_excel_and_preserves_other_requirements(services):
    _, projects, _, _ = services
    worktree = projects.create("Excel source")["id"]
    snapshot = projects.snapshot(worktree)
    bundle = snapshot["bundle"]
    bundle["extensions"] = {"json": {"source": "core", "enabled": True}}
    bundle["flow"]["nodes"].append({"id": "sheet", "template": "load_xlsx", "params": {"file": "data.xlsx"}})
    result = projects.write(worktree, snapshot["revision"], bundle_to_files(bundle))
    assert result["bundle"]["extensions"] == {
        "json": {"source": "core", "enabled": True},
        "excel": {"source": "core", "enabled": True},
    }
    # Editing an existing reader respects a later explicit disable.
    bundle = result["bundle"]
    bundle["extensions"]["excel"]["enabled"] = False
    disabled = projects.write(worktree, result["revision"], bundle_to_files(bundle))
    assert not disabled["bundle"]["extensions"]["excel"]["enabled"]
    bundle["flow"]["nodes"][-1]["params"]["file"] = "uploaded.xlsx"
    changed = projects.write(worktree, disabled["revision"], bundle_to_files(bundle))
    assert not changed["bundle"]["extensions"]["excel"]["enabled"]
    bundle["flow"]["nodes"].append({"id": "second", "preset": "load_xlsx", "params": {}})
    added = projects.write(worktree, changed["revision"], bundle_to_files(bundle))
    assert added["bundle"]["extensions"]["excel"]["enabled"]


def test_a_new_delta_reader_enables_delta_beside_excel():
    nodes = [{"id": "lake", "template": "load_delta"}, {"id": "sheet", "preset": "load_xlsx"}]
    files = activate_file_readers({}, {"flow.json": dumps({"nodes": nodes})})
    assert '"delta": {' in files["extensions.json"] and '"excel": {' in files["extensions.json"]
    disabled = {**files, "extensions.json": files["extensions.json"].replace("true", "false")}
    # Unchanged readers keep an explicit disable.
    assert activate_file_readers(disabled, disabled) == disabled
    # So does editing a reader that was already there.
    nodes[0]["params"] = {"table": "lake/orders"}
    edited = {**disabled, "flow.json": dumps({"nodes": nodes})}
    assert activate_file_readers(disabled, edited) == edited


def test_nested_readers_preserve_malformed_extension_documents():
    files = {"components/group.json": dumps({"nodes": [{"id": "sheet", "preset": "load_xlsx"}]})}
    assert "extensions.json" in activate_file_readers({}, files)
    malformed = {**files, "extensions.json": "broken JSON"}
    assert activate_file_readers({}, malformed) == malformed
    assert activate_file_readers({}, {"flow.json": "invalid"}) == {"flow.json": "invalid"}
    malformed_id = {"flow.json": dumps({"nodes": [{"id": [], "template": "load_xlsx"}]})}
    assert activate_file_readers({}, malformed_id) == malformed_id
    # A template reference that is not a name is reported by validation, and can then be corrected.
    malformed_template = {"flow.json": dumps({"nodes": [{"id": "lake", "template": ["load_delta"]}]})}
    assert activate_file_readers({}, malformed_template) == malformed_template
    corrected = {"flow.json": dumps({"nodes": [{"id": "lake", "template": "load_delta"}]})}
    assert '"delta": {' in activate_file_readers(malformed_template, corrected)["extensions.json"]
