"""Per-output named documents: the `named` merge strategy in whole-entry mode."""

import json

import pytest

from duckpad import project_files
from duckpad.json_document import Document
from duckpad.merge import merge_files

NOTES = Document("notes.json", "an object of notes by node output")
FIRST = {"name": "First", "body": {"text": "a", "size": 1}}
SECOND = {"name": "Second", "body": {"text": "b", "size": 2}}


@pytest.fixture(autouse=True)
def whole_entry_file(monkeypatch):
    """A named file whose entries merge as one unit, registered for these tests only."""
    notes = project_files.FileType(NOTES.file, "notes", "note", "named", document=NOTES, whole_entries=True)
    monkeypatch.setattr(project_files, "FILES", (*project_files.FILES, notes))


def files(value):
    return {"notes.json": json.dumps(value)}


def test_whole_entries_merge_by_output_and_name():
    base = files({"filter:result": [FIRST]})
    current = files({"filter:result": [FIRST, SECOND]})
    proposal = files(
        {"filter:result": [{**FIRST, "body": {"text": "c", "size": 1}}], "total:result": [SECOND]}
    )
    merged, conflicts = merge_files(base, current, proposal)
    assert conflicts == []
    assert json.loads(merged["notes.json"]) == {
        "filter:result": [{**FIRST, "body": {"text": "c", "size": 1}}, SECOND],
        "total:result": [SECOND],
    }


def test_concurrent_edits_to_one_whole_entry_are_one_conflict():
    base = files({"filter:result": [FIRST]})
    # Field-level merging would combine these edits; a whole entry is never merged field by field.
    current = files({"filter:result": [{**FIRST, "body": {"text": "x", "size": 1}}]})
    proposal = files({"filter:result": [{**FIRST, "body": {"text": "a", "size": 9}}]})
    assert merge_files(base, current, proposal)[1] == ["notes.json/filter:result/First"]
    deleted = files({"filter:result": []})
    assert merge_files(base, deleted, proposal)[1] == ["notes.json/filter:result/First"]


def test_a_conflicting_whole_entry_resolves_to_one_side():
    base = files({"filter:result": [FIRST]})
    current = files({"filter:result": [{**FIRST, "body": {"text": "x", "size": 1}}]})
    proposal = files({"filter:result": [{**FIRST, "body": {"text": "a", "size": 9}}]})
    evidence = []
    merged, conflicts = merge_files(
        base, current, proposal, choices={"notes.json/filter:result/First": "incoming"}, evidence=evidence
    )
    assert conflicts == []
    assert json.loads(merged["notes.json"]) == {
        "filter:result": [{**FIRST, "body": {"text": "a", "size": 9}}]
    }
    [field] = evidence
    assert field["path"] == "notes.json/filter:result/First"
    assert field["incoming"] == {"present": True, "value": {**FIRST, "body": {"text": "a", "size": 9}}}


def test_branches_that_both_create_a_named_file_merge_from_an_empty_document():
    merged, conflicts = merge_files({}, files({"filter:result": [FIRST]}), files({"total:result": [SECOND]}))
    assert conflicts == []
    assert json.loads(merged["notes.json"]) == {"filter:result": [FIRST], "total:result": [SECOND]}
