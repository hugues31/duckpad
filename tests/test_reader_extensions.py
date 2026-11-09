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


def test_nested_readers_preserve_malformed_extension_documents():
    files = {"components/group.json": dumps({"nodes": [{"id": "sheet", "preset": "load_xlsx"}]})}
    assert "extensions.json" in activate_file_readers({}, files)
    malformed = {**files, "extensions.json": "broken JSON"}
    assert activate_file_readers({}, malformed) == malformed
    assert activate_file_readers({}, {"flow.json": "invalid"}) == {"flow.json": "invalid"}
    malformed_id = {"flow.json": dumps({"nodes": [{"id": [], "template": "load_xlsx"}]})}
    assert activate_file_readers({}, malformed_id) == malformed_id


def test_editing_an_existing_reader_keeps_requirements_and_retained_context_unchanged():
    base = {
        "flow.json": dumps({"nodes": [{"id": "sheet", "preset": "load_xlsx", "params": {"file": "a.xlsx"}}]})
    }
    edited = {
        "flow.json": dumps({"nodes": [{"id": "sheet", "preset": "load_xlsx", "params": {"file": "b.xlsx"}}]})
    }
    assert activate_file_readers(base, edited) == edited
    # Preserve the exact file when Excel is already requested, even for a new reader.
    enabled = {**edited, "extensions.json": '{"excel":{"enabled":true,"source":"core"}}'}
    assert activate_file_readers({}, enabled) == enabled
