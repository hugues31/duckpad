"""Python contracts, project environments and mixed SQL/Python execution."""

import copy
import io
import subprocess
import sys
from pathlib import Path

import pytest
from helpers import wait_run, wait_until

from duckpad.archive import archive_bundle, read_archive, write_archive
from duckpad.bundle import bundle_to_files
from duckpad.lineage import Lineage
from duckpad.python_contract import parse_python
from duckpad.python_environment import lock_files, prepare, validate_manifest
from duckpad.services import Services
from duckpad.util import Problem

SPLIT = """import duckpad as dp
from typing import ClassVar
from duckdb import col

class Split(dp.Node):
    constant: ClassVar[int] = 99
    minimum: int = dp.param(default=2, ge=0)
    column: dp.Column = dp.param(default="x", input="orders")

    class Outputs(dp.Outputs):
        valid: dp.Relation
        rejected: dp.Relation

    def run(self, orders: dp.Relation) -> Outputs:
        print("processing orders")
        return self.Outputs(valid=orders.filter(col(self.column) >= self.minimum),
                            rejected=orders.filter(col(self.column) < self.minimum))
"""


def flow(services, code=SPLIT):
    store, projects, _, _ = services
    worktree = projects.create("Python")
    store.put("settings", "python:" + worktree["project"], {"enabled": True})
    snapshot = projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"].update(
        nodes=[
            {"id": "source", "template": "source", "params": {}},
            {"id": "python", "language": "python", "params": {}},
            {"id": "total", "template": "total", "params": {}},
        ],
        edges=[
            {
                "id": "a",
                "source": "source",
                "sourceHandle": "result",
                "target": "python",
                "targetHandle": "orders",
            },
            {
                "id": "b",
                "source": "python",
                "sourceHandle": "valid",
                "target": "total",
                "targetHandle": "source",
            },
        ],
    )
    bundle["templates"].update(
        source="-- @output result\nSELECT * FROM range(5) t(x)",
        total="-- @input source\n-- @output result\nSELECT sum(x) s FROM {{ source }}",
    )
    bundle["node_sql"] = {"nodes/python.py": code}
    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    return worktree


def test_contract_discovery_never_executes_code(tmp_path):
    marker = tmp_path / "marker"
    parsed = parse_python(f"open({str(marker)!r}, 'w').write('unsafe')\n" + SPLIT)
    assert not marker.exists()
    assert parsed["inputs"] == ["orders"]
    assert parsed["outputs"] == ["valid", "rejected"]
    assert [p["name"] for p in parsed["parameters"]] == ["minimum", "column"]


@pytest.mark.parametrize(
    "change",
    [
        lambda s: s.replace("default=2", "default=int('2')"),
        lambda s: s.replace("orders: dp.Relation", "orders"),
        lambda s: s.replace("class Split(dp.Node):", "class Split(factory()):"),
        lambda s: s.replace("class Split(dp.Node):", "@decorator\nclass Split(dp.Node):"),
        lambda s: s.replace("class Split(dp.Node):", "class Split(dp.Node):\n    exec('value = 1')"),
    ],
)
def test_dynamic_contract_is_rejected(change):
    with pytest.raises(Problem):
        parse_python(change(SPLIT))


def test_mixed_flow_and_parameter_instances(services):
    store, _, _, engine = services
    worktree = flow(services)
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert not run["nodes"]["python"].get("error"), run["nodes"]["python"].get("error")
    assert run["status"] == "success", {k: v.get("error") for k, v in run["nodes"].items()}
    context = engine.context(worktree["id"], "dev")
    assert context.outputs["python"]["valid"].count == 3
    assert context.outputs["python"]["rejected"].count == 2
    total = context.outputs["total"]["result"]
    assert context.db.execute(f'SELECT * FROM "{total.table}"').fetchall() == [(9,)]
    assert run["nodes"]["python"]["parameters"]["minimum"] == 2
    assert any("processing orders" in r["message"] for r in run["nodes"]["python"]["results"])


def test_invalid_returns_publish_no_outputs(services):
    store, _, _, engine = services
    worktree = flow(services, SPLIT.replace("return self.Outputs(valid=", "return self.Outputs(wrong="))
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert run["nodes"]["python"]["status"] == "failed"
    assert "Expected output names" in run["nodes"]["python"]["error"]
    assert "python" not in engine.context(worktree["id"], "dev").outputs


def test_rerun_removes_previous_parquet_download(services):
    store, projects, _, engine = services
    code = SPLIT.replace(
        '        print("processing orders")',
        '        orders.write_parquet(str(self.artifact("out.parquet")))',
    )
    worktree = flow(services, code)
    artifacts = engine.exports.artifacts
    first = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert first["status"] == "success", first
    identity = first["nodes"]["python"]["artifact"]
    previous = artifacts.path(store.get("artifact", identity))
    assert previous.is_file()
    second = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert second["status"] == "success", second
    current = store.get("artifact", second["nodes"]["python"]["artifact"])
    assert current["storage_kind"] == "download"
    assert store.get("artifact", identity) is None and not previous.exists()
    assert list(store.paths.artifacts.iterdir()) == [artifacts.path(current)]
    assert not list(store.paths.partition_artifacts(worktree["id"], "dev").glob("artifact_*"))
    with artifacts.open(current["id"], worktree["id"], "dev", "python", second["id"]) as (stream, _):
        assert stream.read(4) == b"PAR1"
    engine.reset_project(worktree["project"])
    projects.delete(worktree["project"])
    assert not artifacts.path(current).exists()


def test_disabled_python_creates_no_workspace(services, monkeypatch):
    store, _, _, engine = services
    worktree = flow(services)
    compute = engine.runs.nodes.python.compute

    def disable(*args):
        store.put("settings", "python:" + worktree["project"], {"enabled": False})
        return compute(*args)

    monkeypatch.setattr(engine.runs.nodes.python, "compute", disable)
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert run["nodes"]["python"]["status"] == "failed"
    assert "Python execution is disabled" in run["nodes"]["python"]["error"]
    temporary = store.paths.exports(worktree["id"], "dev") / ".temporary"
    assert not list(temporary.glob("python_*"))


def test_parameters_validate_before_top_level_code(services, tmp_path):
    store, projects, _, engine = services
    marker = tmp_path / "never"
    worktree = flow(services, f"open({str(marker)!r}, 'w').write('bad')\n" + SPLIT)
    snapshot = projects.snapshot(worktree["id"])
    bundle = copy.deepcopy(snapshot["bundle"])
    bundle["flow"]["nodes"][1]["params"] = {"minimum": 1.5}
    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert "requires an integer" in run["nodes"]["python"]["error"]
    assert not marker.exists()


def test_project_requires_administrator_activation(services):
    store, _, _, engine = services
    worktree = flow(services)
    store.put("settings", "python:" + worktree["project"], {"enabled": False})
    with pytest.raises(Problem, match="disabled") as refused:
        engine.launch(worktree["id"], "dev")
    assert refused.value.detail == {"code": "python_disabled"}


def single(services, code, *, params=None, variables=None):
    store, projects, _, _ = services
    worktree = projects.create("Python source")
    store.put("settings", "python:" + worktree["project"], {"enabled": True})
    snapshot = projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"].update(nodes=[{"id": "python", "language": "python", "params": params or {}}], edges=[])
    if variables:
        bundle["variables"] = variables
    bundle["node_sql"] = {"nodes/python.py": code}
    projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    return worktree


def test_python_file_parameters_resolve_project_variables(services):
    store, _, _, engine = services
    code = """import duckpad as dp
class Report(dp.Node):
    target: dp.Destination = "report.csv"
    def run(self) -> None:
        self.message("info", "target=" + self.target)
"""
    worktree = single(
        services,
        code,
        params={"target": "report_{{ var.region }}.csv"},
        variables={"region": {"type": "text", "default": "eu"}},
    )
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=60)
    state = run["nodes"]["python"]
    assert state["status"] == "success", state.get("error")
    assert state["parameters"]["target"].endswith("report_eu.csv")


def test_source_and_managed_zip_export(services):
    import zipfile

    store, _, _, engine = services
    code = """import duckpad as dp
import zipfile

class Export(dp.Node):
    def run(self) -> None:
        self.message("info", "ready to write")

    def write(self):
        with zipfile.ZipFile(self.artifact("export.zip"), "w") as archive:
            archive.writestr("orders.csv", "name;amount\\nCafé;12\\n".encode("cp1252"))
"""
    worktree = single(services, code)
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert run["status"] == "success", run["nodes"]
    assert run["nodes"]["python"]["outputs"] == {}
    with engine.open_export(worktree["id"], "dev", "python", run["id"]) as (reader, metadata):
        assert metadata["filename"] == "export.zip"
        with zipfile.ZipFile(reader) as archive:
            assert archive.read("orders.csv") == b"name;amount\nCaf\xe9;12\n"
    assert not list(store.paths.exports(worktree["id"], "dev").glob(".temporary/python_*"))


def test_checks_run_before_write_and_failed_artifacts_are_removed(services):
    store, _, _, engine = services
    code = """import duckpad as dp
import duckdb

class Export(dp.Node):
    def run(self) -> None:
        self.artifact("early.txt").write_text("staged")
        self.check("invalid", duckdb.sql("select 1"))

    def write(self):
        raise RuntimeError("write must not run")
"""
    worktree = single(services, code)
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert "Python check invalid failed" in run["nodes"]["python"]["error"]
    assert not run["nodes"]["python"].get("artifact")
    assert not list(store.paths.exports(worktree["id"], "dev").glob(".temporary/python_*"))


def test_invalid_edits_keep_contract_edges_and_parameters(services):
    _, projects, _, _ = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree["id"])
    original = snapshot["bundle"]["flow"]
    for text in (
        "class Split(:",
        SPLIT.replace("rejected: dp.Relation", "renamed: dp.Relation").replace(
            "valid: dp.Relation", "accepted: dp.Relation"
        ),
    ):
        proposal = {**snapshot["files"], "nodes/python.py": text}
        snapshot = projects.write(worktree["id"], snapshot["revision"], proposal)
        assert snapshot["bundle"]["flow"]["edges"] == original["edges"]
        node = snapshot["bundle"]["flow"]["nodes"][1]
        assert node["python_contract"]["outputs"] == ["valid", "rejected"]
        from duckpad.components import expand

        nodes, _, _ = expand(snapshot["bundle"], tolerant=True)
        expected = ["valid", "rejected"] + (["accepted", "renamed"] if "accepted" in text else [])
        assert nodes["python"]["parsed"]["outputs"] == expected
        if "accepted" in text:
            assert "connected output valid no longer declared" in nodes["python"]["error"]
        assert nodes["python"].get("error")


def test_python_traceback_starts_at_user_code(services):
    store, _, _, engine = services
    code = SPLIT.replace('print("processing orders")', "1 / 0")
    run = wait_run(store, engine.launch(flow(services, code)["id"], "dev"), timeout=60)
    error = run["nodes"]["python"]["error"]
    assert "ZeroDivisionError" in error and "nodes/python.py" in error
    assert "python_execution" not in error


def test_relabeling_python_code_keeps_fingerprints(services):
    _, projects, _, engine = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree["id"])
    before, _ = engine.fingerprints.batch(snapshot["bundle"], "dev")
    proposal = {**snapshot["files"], "nodes/python.py": "# @label Reusable splitter\n" + SPLIT}
    snapshot = projects.write(worktree["id"], snapshot["revision"], proposal)
    after, _ = engine.fingerprints.batch(snapshot["bundle"], "dev")
    assert after == before
    snapshot = projects.write(
        worktree["id"], snapshot["revision"], {**proposal, "nodes/python.py": SPLIT + "\n# note\n"}
    )
    changed, _ = engine.fingerprints.batch(snapshot["bundle"], "dev")
    assert changed["python"] != before["python"]


def test_python_syntax_error_is_reported_once_with_other_flow_problems(services):
    _, projects, _, _ = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree["id"])
    snapshot["bundle"]["flow"]["edges"] = [e for e in snapshot["bundle"]["flow"]["edges"] if e["id"] != "b"]
    files = {**bundle_to_files(snapshot["bundle"]), "nodes/python.py": "class Split(:"}
    projects.write(worktree["id"], snapshot["revision"], files)
    diagnostics = projects.snapshot(worktree["id"])["diagnostics"]
    python = [d for d in diagnostics if d["file"] == "nodes/python.py"]
    assert len(python) == 1 and python[0]["message"].startswith("Python line 1")
    assert not any(d["file"] == "flow.json" and d["message"] == python[0]["message"] for d in diagnostics)
    assert any("Connect input 'source'" in d["message"] for d in diagnostics)


def test_opaque_lineage_uses_retained_parent_generation(services):
    store, projects, _, engine = services
    worktree = flow(services)
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert run["status"] == "success"
    context = engine.context(worktree["id"], "dev")
    parent = context.outputs["source"]["result"]
    output = context.outputs["python"]["valid"]
    response = Lineage(engine).explain(worktree["id"], "dev", output.id, 0, "x")
    assert response.get("kind") == "python", response["warnings"]
    assert not response["contributions"]
    assert response["parents"][0]["dataset"] == parent.id
    snapshot = projects.snapshot(worktree["id"])
    files = {**snapshot["files"], "templates/source.sql": "-- @output result\nselect 999 x"}
    projects.write(worktree["id"], snapshot["revision"], files)
    wait_run(store, engine.launch(worktree["id"], "dev", "source"), timeout=30)
    assert context.outputs["source"]["result"].id != parent.id
    response = Lineage(engine).explain(worktree["id"], "dev", output.id, 0, "x")
    assert response["parents"][0]["dataset"] == parent.id
    cell = Lineage(engine).explain(worktree["id"], "dev", parent.id, 0, "x")
    assert cell["value"] == 0


def test_crash_leaves_server_available_and_next_run_restarts_worker(services):
    store, projects, _, engine = services
    worktree = single(
        services,
        "import duckpad as dp\nimport os\nclass Crash(dp.Node):\n    def run(self) -> None:\n        os._exit(23)\n",
    )
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert "worker stopped" in run["nodes"]["python"]["error"]
    assert projects.snapshot(worktree["id"])["bundle"]
    snapshot = projects.snapshot(worktree["id"])
    code = "import duckpad as dp\nclass Source(dp.Node):\n    def run(self) -> dp.Relation:\n        return self.db.sql('select 42 answer')\n"
    projects.write(worktree["id"], snapshot["revision"], {**snapshot["files"], "nodes/python.py": code})
    assert wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)["status"] == "success"


@pytest.mark.skipif(sys.platform != "linux", reason="Landlock requires Linux; trusted local runs on Windows")
def test_python_isolated_filesystem_and_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("DUCKPAD_TEST_API_CREDENTIAL", "must-not-reach-python")
    forbidden = tmp_path / "private.txt"
    forbidden.write_text("synthetic secret")
    configs = [tmp_path / ".config" / "uv" / "uv.toml", tmp_path / "etc" / "uv" / "uv.toml"]
    for config in configs:
        config.parent.mkdir(parents=True)
        config.write_text("")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(configs[0].parent.parent))
    monkeypatch.setenv("XDG_CONFIG_DIRS", str(configs[1].parent.parent))
    instance = Services.open(tmp_path / "instance", enforce_access=True, isolated=True)
    try:
        services = instance.store, instance.projects, instance.catalog, instance.engine
        other = instance.projects.create("Other project")
        other_file = Path(other["path"]) / "pyproject.toml"
        metadata = instance.store.home / "instance.sqlite"
        protected = [str(forbidden), str(other_file), str(metadata), *(str(config) for config in configs)]
        code = f"""import duckpad as dp
import os
from pathlib import Path

class Probe(dp.Node):
    def run(self) -> None:
        assert "DUCKPAD_TEST_API_CREDENTIAL" not in os.environ
        for forbidden in {protected!r}:
            for operation in (lambda p: p.read_bytes(), lambda p: p.write_text("bad")):
                try:
                    operation(Path(forbidden))
                except PermissionError:
                    pass
                else:
                    raise RuntimeError("private path was accessible")
        self.message("info", "private files denied")
"""
        worktree = single(services, code)
        result = wait_run(instance.store, instance.engine.launch(worktree["id"], "dev"), timeout=30)
        assert result["status"] == "success", result["nodes"]
        assert result["nodes"]["python"]["results"][0]["message"] == "private files denied"
    finally:
        instance.close()


def test_lock_environment_reuse_runtime_constraints_and_archive(services):
    from concurrent.futures import ThreadPoolExecutor

    store, projects, _, _ = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree["id"])
    files = {**snapshot["files"], "modules/business.py": "FACTOR = 3\n"}
    files["pyproject.toml"] = files["pyproject.toml"].replace(
        '"pytz>=2024.1"', '"pytz>=2024.1", "humanize==4.13.0"'
    )
    snapshot = projects.write(worktree["id"], snapshot["revision"], files)
    assert 'name = "humanize"' in snapshot["files"]["uv.lock"]
    archive = read_archive(io.BytesIO(write_archive(snapshot["files"])))
    assert bundle_to_files(archive_bundle(archive)) == snapshot["files"]
    home = store.paths.home
    first = prepare(archive, home, worktree["project"])
    assert prepare(archive, home, worktree["project"]) == first
    probe = subprocess.run(
        [
            first["interpreter"],
            "-I",
            "-c",
            "import humanize; print(humanize.intcomma(1000)); import importlib.util; assert importlib.util.find_spec('fastapi') is None; import duckpad as dp; assert dp.Node",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert probe.stdout.strip() == "1,000"
    assert lock_files(archive, home, read_only=True) == archive["uv.lock"]
    with pytest.raises(Problem, match=r"valid uv\.lock"):
        lock_files({**archive, "uv.lock": "<<<<<<< conflict"}, home, read_only=True)
    assert "<<<<<<<" not in lock_files({**archive, "uv.lock": "<<<<<<< conflict"}, home)
    changed = {
        **archive,
        "pyproject.toml": archive["pyproject.toml"].replace("humanize==4.13.0", "humanize==4.12.3"),
    }
    with pytest.raises(Problem, match="preparation failed"):
        lock_files(changed, home, read_only=True)
    changed["uv.lock"] = lock_files(changed, home)
    with ThreadPoolExecutor(max_workers=3) as executor:
        prepared = list(executor.map(lambda _: prepare(changed, home, worktree["project"]), range(3)))
    assert prepared[0] == prepared[1] == prepared[2]
    assert prepared[0]["interpreter"] != first["interpreter"]
    assert prepare(archive, home, worktree["project"]) == first
    with pytest.raises(Problem, match="SDK contract"):
        validate_manifest(archive["pyproject.toml"].replace("sdk-contract = 1", "sdk-contract = 999"))
    with pytest.raises(Problem, match="pin duckdb"):
        validate_manifest(archive["pyproject.toml"].replace("duckdb==", "duckdb>="))


def test_adapters_and_native_type_fidelity(services):
    store, projects, _, engine = services
    code = """import duckpad as dp
class Adapters(dp.Node):
    class Outputs(dp.Outputs):
        native: dp.Relation
        arrow: dp.Relation
        reader: dp.Relation
        pandas: dp.Relation
        polars: dp.Relation

    def run(self) -> Outputs:
        import pyarrow as pa
        import pandas as pd
        import polars as pl
        table = pa.table({"number": pa.array([1, None, 3], type=pa.int64()), "text": ["café", "東京", None]})
        native = self.db.sql("SELECT 12345678901234567890123456789012345678::HUGEINT h, 12345678901234567890.12::DECIMAL(30,2) d, DATE '2026-01-01' AS event_date, TIMESTAMPTZ '2026-01-01 12:30:00+02' zoned, [1, NULL] nested, NULL::INTEGER missing")
        return self.Outputs(native=native, arrow=table,
            reader=table.to_reader(max_chunksize=1),
            pandas=table.to_pandas(types_mapper=pd.ArrowDtype), polars=pl.from_arrow(table))
"""
    worktree = single(services, code)
    snapshot = projects.snapshot(worktree["id"])
    files = dict(snapshot["files"])
    files["pyproject.toml"] = files["pyproject.toml"].replace(
        '"pytz>=2024.1"', '"pytz>=2024.1", "pyarrow>=18", "pandas>=2.2", "polars[rtcompat]>=1.30"'
    )
    projects.write(worktree["id"], snapshot["revision"], files)
    result = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=90)
    assert result["status"] == "success", result["nodes"]
    context = engine.context(worktree["id"], "dev")
    for port in ("arrow", "reader", "pandas", "polars"):
        data = context.outputs["python"][port]
        assert context.db.execute(f'SELECT * FROM "{data.table}" ORDER BY number NULLS LAST').fetchall() == [
            (1, "café"),
            (3, None),
            (None, "東京"),
        ]
    data = context.outputs["python"]["native"]
    assert [c["type"] for c in data.columns] == [
        "HUGEINT",
        "DECIMAL(30,2)",
        "DATE",
        "TIMESTAMP WITH TIME ZONE",
        "INTEGER[]",
        "INTEGER",
    ]
    assert context.db.execute(
        f'SELECT CAST(h AS VARCHAR), CAST(d AS VARCHAR), missing IS NULL FROM "{data.table}"'
    ).fetchone() == ("12345678901234567890123456789012345678", "12345678901234567890.12", True)


@pytest.mark.parametrize("timeout", [False, True])
def test_cancel_or_timeout_stops_python_and_preserves_other_contexts(services, monkeypatch, timeout):
    monkeypatch.delenv("DUCKPAD_PYTHON_TIMEOUT_SECONDS", raising=False)
    store, projects, _, engine = services
    other = projects.create("Unaffected SQL")
    other_context = engine.context(other["id"], "dev", create=True)
    worktree = single(
        services,
        "import duckpad as dp\nimport time\nclass Slow(dp.Node):\n    def run(self) -> None:\n        time.sleep(30)\n",
    )
    if timeout:
        monkeypatch.setenv("DUCKPAD_PYTHON_TIMEOUT_SECONDS", "0.1")
    run = engine.launch(worktree["id"], "dev")
    if not timeout:
        wait_until(
            lambda: store.get("run", run["id"])["nodes"].get("python", {}).get("external_started"), timeout=30
        )
        engine.cancel(run["id"])
    result = wait_run(store, run, timeout=10)
    assert result["status"] == ("failed" if timeout else "canceled")
    assert result["nodes"]["python"]["external_outcome"] == "partial or unknown"
    if timeout:
        assert "Python execution timed out" in result["nodes"]["python"]["error"]
    assert engine.context(other["id"], "dev") is other_context
    assert other_context.db.execute("select 7").fetchone() == (7,)


def test_shared_python_template_instances_and_helper_invalidation(services):
    store, projects, _, engine = services
    worktree = single(
        services, "import duckpad as dp\nclass Seed(dp.Node):\n    def run(self) -> None: pass\n"
    )
    snapshot = projects.snapshot(worktree["id"])
    bundle = snapshot["bundle"]
    bundle["node_sql"] = {}
    bundle["python_helpers"] = {"business/logic.py": "FACTOR = 2\n"}
    bundle["templates"] = {
        "shared.py": "import duckpad as dp\nfrom business.logic import FACTOR\nclass Source(dp.Node):\n    number: int = 1\n    def run(self) -> dp.Relation:\n        return self.db.sql('select ? value', params=[self.number * FACTOR])\n"
    }
    bundle["flow"]["nodes"] = [
        {"id": key, "language": "python", "template": "shared.py", "params": {"number": number}}
        for key, number in (("first", 2), ("second", 3))
    ]
    snapshot = projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    result = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert result["status"] == "success", result["nodes"]
    assert engine.preview(worktree["id"], "dev", "first")["rows"][0]["values"][0] == 4
    assert engine.preview(worktree["id"], "dev", "second")["rows"][0]["values"][0] == 6
    old = engine.fingerprints.current(worktree["id"], "dev")
    projects.write(
        worktree["id"],
        snapshot["revision"],
        {**snapshot["files"], "modules/business/logic.py": "FACTOR = 5\n"},
    )
    assert engine.fingerprints.current(worktree["id"], "dev") != old
    result = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert result["status"] == "success", result["nodes"]
    assert engine.preview(worktree["id"], "dev", "first")["rows"][0]["values"][0] == 10


def test_python_partition_context_and_empty_manifest_rejection(services):
    from test_partitions import bundle as partition_bundle

    store, projects, _, engine = services
    worktree = single(
        services, "import duckpad as dp\nclass Seed(dp.Node):\n    def run(self) -> None: pass\n"
    )
    snapshot = projects.snapshot(worktree["id"])
    bundle = partition_bundle()
    bundle["pyproject"] = snapshot["bundle"]["pyproject"]
    transform = bundle["flow"]["nodes"][3]
    transform.pop("template")
    transform.update(language="python", params={})
    bundle["node_sql"] = {
        "nodes/transform.py": """import duckpad as dp
class Transform(dp.Node):
    def run(self, data: dp.Relation, lookup: dp.Relation) -> dp.Relation:
        assert self.partition is not None
        self.message("info", "partition received")
        return data.project("amount * 10 AS amount")
"""
    }
    snapshot = projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=40)
    assert run["status"] == "success", run["nodes"]
    assert [r["values"] for r in engine.preview(worktree["id"], "dev", "collect")["rows"]] == [
        [10],
        [10],
        [20],
    ]
    projects.write(
        worktree["id"],
        snapshot["revision"],
        {
            **snapshot["files"],
            "templates/keys.sql": "-- @output result\nSELECT 'a' batch, 'one' task WHERE FALSE",
        },
    )
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=40)
    assert run["status"] == "failed"
    assert "schema-only" in str(run)


def test_tagged_python_job_uses_locked_environment(services):
    from duckpad.jobs import Jobs
    from duckpad.schemas import JobLaunch, NewJob

    store, projects, catalog, engine = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree["id"])
    projects.versioning.create_tag(worktree["id"], "reviewed", snapshot["commit"], "Reviewed Python flow")
    from types import SimpleNamespace

    jobs = Jobs(SimpleNamespace(store=store, projects=projects, catalog=catalog, engine=engine))
    jobs.create(
        worktree["project"],
        NewJob(
            slug="python-job", name="Python job", environment="dev", target={"kind": "tag", "ref": "reviewed"}
        ),
        {"id": "reviewer", "username": "reviewer"},
    )
    run = wait_run(
        store, jobs.launch("python-job", JobLaunch(), {"id": "operator", "username": "operator"}), timeout=40
    )
    assert run["status"] == "success", run["nodes"]
    assert run["commit"] == snapshot["commit"]
    assert projects.snapshot(run["worktree"])["files"]["uv.lock"] == snapshot["files"]["uv.lock"]


def test_python_activation_includes_authorized_secrets_and_redacts_logs(services):
    store, _, catalog, engine = services
    catalog.save(
        "connector",
        {
            "id": "http_api",
            "name": "HTTP API",
            "family": "database",
            "parameters": [
                {"name": "base_url", "type": "text"},
                {"name": "token", "type": "text", "secret": True},
            ],
            "init_sql": "",
            "capabilities": ["read"],
        },
        create=True,
    )
    catalog.save(
        "connection",
        {
            "id": "api",
            "name": "API",
            "connector": "http_api",
            "environments": {
                "dev": {"base_url": "https://api.example.invalid", "token": "synthetic-python-secret"}
            },
        },
        create=True,
    )
    code = """import duckpad as dp
import os
class Probe(dp.Node):
    api: dp.Connection = "api"
    def run(self) -> None:
        values = self.connection(self.api)
        assert values["base_url"] == "https://api.example.invalid"
        assert values["token"] == "synthetic-python-secret"
        assert "synthetic-python-secret" not in os.environ.values()
        self.message("info", str(values))
"""
    worktree = single(services, code)
    run = wait_run(store, engine.launch(worktree["id"], "dev"), timeout=30)
    assert run["status"] == "success", run["nodes"]
    assert "synthetic-python-secret" not in str(run)


def test_float_defaults_are_normalized_for_direct_calls():
    import duckpad as dp

    class Numeric(dp.Node):
        minimum: float = 1

    assert type(Numeric().minimum) is float
    assert Numeric(minimum=2).minimum == 2.0


def test_helper_modules_cannot_shadow_the_sdk(services):
    _, projects, _, _ = services
    worktree = flow(services)
    snapshot = projects.snapshot(worktree["id"])
    files = {**snapshot["files"], "modules/duckpad.py": "x = 1\n", "modules/2024/report.py": "x = 2\n"}
    projects.write(worktree["id"], snapshot["revision"], files)
    problems = {d["file"]: d["message"] for d in projects.snapshot(worktree["id"])["diagnostics"]}
    assert "replace the Duckpad SDK" in problems["modules/duckpad.py"]
    assert "Python identifiers" in problems["modules/2024/report.py"]


def test_remembered_contracts_keep_flow_json_canonical(services):
    import json

    from duckpad.util import dumps

    _, projects, _, _ = services
    text = projects.snapshot(flow(services)["id"])["files"]["flow.json"]
    assert '"python_contract"' in text and text == dumps(json.loads(text))


@pytest.mark.parametrize("reverse", [False, True])
def test_shared_python_template_contracts_are_retained_per_node(tmp_path, reverse):
    from fastapi.testclient import TestClient

    from duckpad.app import create_app

    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        worktree = client.post("/api/projects", json={"name": "Shared contracts"}).json()
        projects = app.state.services.projects
        snapshot = projects.snapshot(worktree["id"])
        bundle = snapshot["bundle"]
        nodes = [
            {"id": key, "language": "python", "template": "shared.py", "params": {}}
            for key in ("first", "second")
        ]
        bundle["flow"]["nodes"] = (nodes[::-1] if reverse else nodes) + [
            {"id": "sink", "template": "sink", "params": {}}
        ]
        bundle["flow"]["edges"] = [
            {
                "id": "edge",
                "source": "first",
                "sourceHandle": "old",
                "target": "sink",
                "targetHandle": "source",
            }
        ]
        code = "import duckpad as dp\nclass Shared(dp.Node):\n    class Outputs(dp.Outputs):\n        old: dp.Relation\n    def run(self) -> Outputs: pass\n"
        bundle["templates"].update(
            {"shared.py": code, "sink": "-- @input source\n-- @output result\nSELECT * FROM {{ source }}"}
        )
        snapshot = projects.write(worktree["id"], snapshot["revision"], bundle_to_files(bundle))
        projects.write(
            worktree["id"],
            snapshot["revision"],
            {**snapshot["files"], "templates/shared.py": code.replace("old:", "new:")},
        )
        result = client.get(f"/api/worktrees/{worktree['id']}").json()
        assert result["parsed_templates"]["shared.py"]["outputs"] == ["new"]
        assert not result["parsed_templates"]["shared.py"].get("error")
        assert result["parsed_nodes"]["nodes/first.py"]["outputs"] == ["old", "new"]
        assert "Python ports changed" in result["parsed_nodes"]["nodes/first.py"]["error"]
        assert result["parsed_nodes"]["nodes/second.py"]["outputs"] == ["new"]
        assert not result["parsed_nodes"]["nodes/second.py"].get("error")
        assert {d["node"] for d in result["diagnostics"] if d.get("code") == "python_contract"} == {"first"}
