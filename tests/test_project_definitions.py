"""Project definitions agree across editing, validation, history and staleness."""

import copy

import pytest

from duckpad import project_files
from duckpad.bundle import bundle_to_files, files_to_bundle
from duckpad.comparison import CommitContext, commit_message, compare_files
from duckpad.execution.fingerprints import Fingerprints
from duckpad.git.workspace import diagnose
from duckpad.merge import merge_files
from duckpad.util import Problem
from duckpad.validation import validate

PYTHON = """import duckpad as dp

class Report(dp.Node):
    def run(self) -> dp.Relation:
        text = "{{ var.x }}"
        return self.sql("SELECT 1 AS value")
"""


def mixed_bundle():
    return {
        "flow": {
            "nodes": [
                {"id": "python", "language": "python"},
                {"id": "sql", "template": "sql"},
                {"id": "consumer", "template": "consumer"},
            ],
            "edges": [
                {
                    "id": "consume",
                    "source": "python",
                    "sourceHandle": "result",
                    "target": "consumer",
                    "targetHandle": "source",
                }
            ],
        },
        "templates": {
            "sql": "-- @output result\nSELECT 1 AS value;",
            "consumer": "-- @input source\n-- @output result\nSELECT * FROM {{ source }};",
        },
        "node_sql": {"nodes/python.py": PYTHON},
        "components": {},
        "documentation": {},
        "python_helpers": {"helpers.py": "VALUE = 1\n"},
        "python_lock": "version = 1\n",
        "pyproject": '[project]\nname = "example"\nversion = "0.1.0"\n',
    }


@pytest.mark.parametrize(
    ("path", "text"),
    [
        ("modules/helpers.py", "VALUE = 2\n"),
        ("uv.lock", "version = 2\n"),
        ("pyproject.toml", '[project]\nname = "example"\nversion = "0.2.0"\n'),
    ],
)
def test_python_project_inputs_change_entities_impact_fingerprints_and_history(services, path, text):
    _, projects, catalog, engine = services
    before = bundle_to_files(mixed_bundle())
    after = {**before, path: text}
    report = compare_files(before, after)
    changes = [entity for entity in report["entities"] if entity["status"] != "unchanged"]
    assert [(entity["file"], entity["status"]) for entity in changes] == [(path, "modified")]
    assert report["impact"]["direct"] == ["python"]
    assert report["impact"]["downstream"] == ["consumer"]
    assert path in commit_message(before, after)
    fingerprints = Fingerprints(projects, catalog, engine.pool)
    old, new = [fingerprints.of(files_to_bundle(files), "dev") for files in (before, after)]
    assert {key for key in old if old[key] != new[key]} == {"python", "consumer"}


def test_partition_key_column_reaches_partitioned_nodes_and_collectors(services):
    from test_partitions import bundle

    _, projects, catalog, engine = services
    before = bundle()
    after = copy.deepcopy(before)
    after["flow"]["partitions"]["batch"]["values"]["column"] = "other_key"
    files = [bundle_to_files(value) for value in (before, after)]
    report = compare_files(*files)
    assert report["impact"]["direct"] == ["collect", "source", "transform"]
    assert report["counts"]["modified"] == 1
    assert "normalize" not in commit_message(*files)
    fingerprints = Fingerprints(projects, catalog, engine.pool)
    old, new = [fingerprints.of(value, "dev") for value in (before, after)]
    assert {key for key in old if old[key] != new[key]} == {"collect", "source", "transform"}


def test_explicit_commit_messages_are_preserved_with_existing_head(services):
    _, projects, _, _ = services
    worktree = projects.create("History")
    before = projects.snapshot(worktree["id"])
    message = "build(project): lock Python dependencies"
    saved = projects.write(
        worktree["id"],
        before["revision"],
        {**before["files"], "uv.lock": "version = 1\n"},
        message=message,
        relock=False,
    )
    assert projects.git(worktree["path"], "log", "-1", "--format=%B") == message
    override = "docs(project): import notes without changing authorship"
    projects.write(
        worktree["id"], saved["revision"], {**saved["files"], "README.md": "Notes"}, message=override
    )
    assert projects.git(worktree["path"], "log", "-1", "--format=%B") == override
    assert "import:" in commit_message(before["files"], saved["files"], CommitContext.IMPORT)


@pytest.mark.parametrize("content", ['"abc"', "[]", "null", "42", "{"])
def test_invalid_extensions_remain_lossless_and_are_rejected(content):
    files = {**bundle_to_files(mixed_bundle()), "extensions.json": content}
    bundle = files_to_bundle(files)
    assert bundle_to_files(bundle)["extensions.json"] == content
    errors = validate(bundle)
    assert any(error["file"] == "extensions.json" for error in errors)
    with pytest.raises(Problem):
        project_files.EXTENSIONS.declarations(bundle["extensions"])


@pytest.mark.parametrize("parameters", [[], {"amount": {"targets": ["source.amount"]}}])
def test_structure_errors_name_the_component_and_keep_independent_file_errors(parameters):
    bundle = mixed_bundle()
    bundle["components"]["report"] = {"parameters": parameters}
    bundle["pyproject"] = "[project"
    bundle["python_helpers"]["duckpad.py"] = ""
    errors = validate(bundle)
    assert {e["file"] for e in errors} == {"components/report.json", "pyproject.toml", "modules/duckpad.py"}
    component = next(e for e in errors if e["file"] == "components/report.json")
    assert "parameters" in component["message"]
    assert "attribute" not in component["message"] and "indices" not in component["message"]


def test_diagnose_attributes_malformed_json_and_structure_to_their_files():
    files = bundle_to_files(mixed_bundle())
    for content in ('{"parameters": []}', "{"):
        parsed, errors = diagnose({**files, "components/report.json": content})
        assert parsed is None
        assert {e["file"] for e in errors} == {"components/report.json"}


def test_computed_variable_chain_is_reported_once():
    bundle = mixed_bundle()
    bundle["templates"]["sql"] = "-- @param amount: number\n-- @output result\nSELECT {{ amount }} AS value;"
    bundle["flow"]["nodes"][1]["params"] = {"amount": {"$var": "first"}}
    bundle["variables"] = {
        "first": {"type": "number", "from": {"node": "python", "column": "value"}},
        "second": {"type": "number", "from": {"node": "sql", "column": "value"}},
    }
    errors = validate(bundle)
    assert [(e.get("node"), e["code"]) for e in errors if e.get("code") == "value_chain"] == [
        ("sql", "value_chain")
    ]


@pytest.mark.parametrize("linked", [False, True])
def test_python_code_does_not_substitute_variable_or_partition_text(linked):
    bundle = mixed_bundle()
    bundle["node_sql"]["nodes/python.py"] = PYTHON.replace("{{ var.x }}", "{{ var.x }} {{ partition.key }}")
    if linked:
        bundle["templates"]["report.py"] = bundle["node_sql"].pop("nodes/python.py")
        bundle["flow"]["nodes"][0]["template"] = "report.py"
    assert validate(bundle) == []
    invalid = copy.deepcopy(bundle)
    if linked:
        invalid["templates"]["report.py"] = "def broken("
        assert any(e["file"] == "templates/report.py" for e in validate(invalid))


def test_registry_round_trip_and_merge_cover_python_modules_and_generated_locks(tmp_path):
    before = bundle_to_files(mixed_bundle())
    before["modules/package/nested.py"] = "VALUE = 3\n"
    for path, text in before.items():
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    assert before.keys() <= set(project_files.definition_names(tmp_path))
    assert bundle_to_files(files_to_bundle(before)) == before
    current = {**before, "uv.lock": "current", "variables.json": '{"a": {"type": "number"}}'}
    incoming = {**before, "uv.lock": "incoming", "variables.json": '{"b": {"type": "text"}}'}
    merged, conflicts = merge_files(before, current, incoming)
    assert not conflicts and "uv.lock" not in merged
    assert files_to_bundle(merged)["variables"].keys() == {"a", "b"}


def test_python_label_changes_are_documentation_in_comparison_and_history():
    before = bundle_to_files(mixed_bundle())
    after = {**before, "nodes/python.py": "# @label New report\n" + PYTHON}
    report = compare_files(before, after)
    assert report["categories"] == {"processing": 0, "documentation": 1, "layout": 0}
    assert report["impact"]["direct"] == []
    assert commit_message(before, after).startswith("docs(node):")


def test_missing_exposed_parameter_node_is_a_component_diagnostic():
    bundle = mixed_bundle()
    bundle["components"]["report"] = {
        "parameters": {"amount": {"targets": [{"node": "missing", "param": "value"}]}}
    }
    bundle["flow"]["nodes"].append({"id": "report", "component": "report"})
    errors = validate(bundle)
    assert any(e["file"] == "components/report.json" and "target" in e["message"] for e in errors)


@pytest.mark.parametrize("definition", [[], {"batch": []}, {"batch": {"values": []}}])
def test_invalid_partition_definitions_remain_comparable(definition):
    from test_partitions import bundle

    before = bundle()
    after = copy.deepcopy(before)
    after["flow"]["partitions"] = definition
    report = compare_files(bundle_to_files(before), bundle_to_files(after))
    assert report["impact"]["status"] == "partial"
    assert report["impact"]["diagnostics"]


def test_impact_lists_each_problem_once_across_versions_and_nodes():
    from test_partitions import bundle

    before = bundle_to_files(mixed_bundle())
    report = compare_files(before, {**before, "extensions.json": '"abc"'})
    assert report["impact"]["direct"] == ["consumer", "python", "sql"]
    assert [d["message"] for d in report["impact"]["diagnostics"]] == [
        "extensions.json must contain an object keyed by extension name"
    ]
    partitioned = bundle()
    partitioned["flow"]["nodes"][3]["params"]["value"] = "{{ partition.missing }}"
    files = bundle_to_files(partitioned)
    report = compare_files(files, {**files, "README.md": "Notes"})
    assert [(d.get("node"), d["message"]) for d in report["impact"]["diagnostics"]] == [
        ("transform", "Unknown partition attribute")
    ]
