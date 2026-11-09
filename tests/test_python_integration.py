"""Python integration with reusable components, Git history and runtime policies."""

import copy
import sys
import zipfile
from pathlib import Path

import _duckdb
import duckdb
import pytest
from helpers import wait_run
from test_python_nodes import SPLIT, flow, single

from duckpad.bundle import bundle_to_files
from duckpad.components import group, import_definition
from duckpad.python_environment import lock_files, runtime_tag, runtime_wheel
from duckpad.util import Problem


def test_python_component_import_execution_and_dependency_error(services):
    store, projects, _, engine = services
    source = flow(services)
    snapshot = projects.snapshot(source["id"])
    grouped, _ = group(snapshot["bundle"], ["python", "total"], "Mixed component")
    grouped["python_helpers"] = {"helpers.py": "VALUE = 1\n"}
    component = next(iter(grouped["components"]))
    destination = projects.create("Imported Python")
    store.put("settings", "python:" + destination["project"], {"enabled": True})
    target = projects.snapshot(destination["id"])
    imported, identity = import_definition(target["bundle"], grouped, "components", component, {})
    assert any(
        name.startswith("components/" + identity) and name.endswith(".py") for name in imported["node_sql"]
    )
    assert imported["python_helpers"] == grouped["python_helpers"]
    imported["flow"] = copy.deepcopy(grouped["flow"])
    imported["flow"]["nodes"][-1]["component"] = identity
    imported["templates"]["source"] = grouped["templates"]["source"]
    projects.write(destination["id"], target["revision"], bundle_to_files(imported))
    run = wait_run(store, engine.launch(destination["id"], "dev"), timeout=40)
    assert run["status"] == "success", run["nodes"]
    grouped["pyproject"] = grouped["pyproject"].replace(
        '"pytz>=2024.1"', '"pytz>=2024.1", "humanize==4.13.0"'
    )
    with pytest.raises(Problem, match=r"requires project dependencies.*humanize"):
        import_definition(target["bundle"], grouped, "components", component, {})


def test_python_history_includes_code_changes(services):
    _, projects, _, _ = services
    tree = flow(services)
    snapshot = projects.snapshot(tree["id"])
    before = projects.versioning.element_summary(tree["id"], "node/python")
    changed = projects.write(
        tree["id"],
        snapshot["revision"],
        {
            **snapshot["files"],
            "nodes/python.py": SPLIT.replace("processing orders", "updated implementation"),
        },
    )
    after = projects.versioning.element_summary(tree["id"], "node/python")
    assert after["changes"] == before["changes"] + 1
    assert after["last"]["commit"] == changed["commit"]


def test_multiple_inputs_and_exposed_variable_parameter(services):
    store, projects, _, engine = services
    code = SPLIT.replace("orders: dp.Relation)", "orders: dp.Relation, other: dp.Relation)").replace(
        'print("processing orders")', 'assert other.count("*").fetchall()[0][0] == 5'
    )
    tree = flow(services, code)
    snapshot = projects.snapshot(tree["id"])
    bundle = snapshot["bundle"]
    bundle["flow"]["edges"].append({**bundle["flow"]["edges"][0], "id": "second", "targetHandle": "other"})
    bundle["variables"] = {"threshold": {"type": "number", "default": 3}}
    bundle["flow"]["nodes"][1]["params"] = {"minimum": {"$var": "threshold"}}
    grouped, instance = group(bundle, ["python"], "Parameterized Python")
    assert next(iter(grouped["components"].values()))["parameters"]
    projects.write(tree["id"], snapshot["revision"], bundle_to_files(grouped))
    result = wait_run(store, engine.launch(tree["id"], "dev"), timeout=40)
    assert result["status"] == "success", [state.get("error") for state in result["nodes"].values()]
    assert engine.preview(tree["id"], "dev", "total")["rows"][0]["values"] == [7]
    assert result["nodes"][instance + "::python"]["parameters"]["minimum"] == 3


def test_disabled_python_does_not_block_independent_sql(services):
    store, _, _, engine = services
    tree = flow(services)
    store.put("settings", "python:" + tree["project"], {"enabled": False})
    result = wait_run(store, engine.launch(tree["id"], "dev", "source"), timeout=30)
    assert result["status"] == "success"
    assert engine.preview(tree["id"], "dev", "source")["count"] == 5


@pytest.mark.parametrize("existing_worker", [False, True])
@pytest.mark.parametrize("save_at", ["context", "worker"])
def test_python_worker_uses_run_snapshot_during_dependency_save(
    services, monkeypatch, existing_worker, save_at
):
    store, projects, _, engine = services
    tree = single(
        services,
        """import duckpad as dp
import humanize

class Version(dp.Node):
    def run(self) -> dp.Relation:
        return self.db.sql("SELECT '" + humanize.__version__ + "' AS version")
""",
    )
    snapshot = projects.snapshot(tree["id"])
    files = dict(snapshot["files"])
    files["pyproject.toml"] = files["pyproject.toml"].replace(
        '"pytz>=2024.1"', '"pytz>=2024.1", "humanize==4.13.0"'
    )
    snapshot = projects.write(tree["id"], snapshot["revision"], files)
    if existing_worker:
        warmup = wait_run(store, engine.launch(tree["id"], "dev"), timeout=40)
        assert warmup["status"] == "success", warmup
    captured = projects.write(
        tree["id"],
        snapshot["revision"],
        {
            **snapshot["files"],
            "pyproject.toml": files["pyproject.toml"].replace("4.13.0", "4.12.3"),
        },
    )
    owner, method = (engine.runs.planner, "open_context") if save_at == "context" else (engine.pool, "_open")
    original = getattr(owner, method)
    saved = []

    def save_dependencies(*args, **kwargs):
        if not saved:
            saved.append(projects.write(tree["id"], captured["revision"], files))
        return original(*args, **kwargs)

    monkeypatch.setattr(owner, method, save_dependencies)
    first = wait_run(store, engine.launch(tree["id"], "dev"), timeout=40)
    assert first["status"] == "success", first
    assert len(saved) == 1
    assert first["commit"] == captured["commit"]
    assert engine.preview(tree["id"], "dev", "python")["rows"][0]["values"] == ["4.12.3"]
    second = wait_run(store, engine.launch(tree["id"], "dev"), timeout=40)
    assert second["status"] == "success", second
    assert second["commit"] == saved[0]["commit"]
    assert engine.preview(tree["id"], "dev", "python")["rows"][0]["values"] == ["4.13.0"]
    assert first["nodes"]["python"]["fingerprint"] != second["nodes"]["python"]["fingerprint"]


def test_canceled_cursor_rejects_python_before_reading_its_payload(services):
    _, projects, _, engine = services
    tree = projects.create("Canceled Python")
    context = engine.context(tree["id"], "dev")
    cursor = context.db.cursor()
    cursor.interrupt()
    try:
        with pytest.raises(duckdb.InterruptException, match="Execution canceled"):
            cursor.python({})
        assert context.db.execute("select 1").fetchone() == (1,)
    finally:
        cursor.close()


def test_operator_wheel_cannot_replace_installed_native_binary(tmp_path, monkeypatch):
    wheel = tmp_path / runtime_tag()
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr(Path(_duckdb.__file__).name, b"different native binary")
    monkeypatch.setenv("DUCKPAD_RUNTIME_WHEEL", str(wheel))
    with pytest.raises(Problem, match="exact installed DuckDB binary"):
        runtime_wheel(tmp_path / "runtime")


def test_offline_missing_dependency_has_actionable_error(services, tmp_path, monkeypatch):
    store, projects, _, _ = services
    tree = projects.create("Offline Python")
    files = projects.snapshot(tree["id"])["files"]
    files["pyproject.toml"] = files["pyproject.toml"].replace(
        '"pytz>=2024.1"', '"pytz>=2024.1", "humanize==4.13.0"'
    )
    monkeypatch.setenv("UV_OFFLINE", "1")
    monkeypatch.setenv("UV_CACHE_DIR", str(tmp_path / "empty-cache"))
    with pytest.raises(Problem, match=r"(?s)preparation failed.*(cache|network|offline)"):
        lock_files(files, store.home)


@pytest.mark.skipif(sys.platform != "linux", reason="POSIX native failure reporting")
def test_native_cpu_crash_reports_compatible_wheel(services):
    store, _, _, engine = services
    tree = single(
        services,
        """import duckpad as dp
import signal
import resource
class NativeCrash(dp.Node):
    def run(self) -> None:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGILL})
        # Deliver on this thread before the worker can report a successful return.
        signal.raise_signal(signal.SIGILL)
""",
    )
    result = wait_run(store, engine.launch(tree["id"], "dev"), timeout=30)
    assert result["status"] == "failed"
    assert "compatible wheel" in result["nodes"]["python"]["error"]
    assert "polars[rtcompat]" in result["nodes"]["python"]["error"]


@pytest.mark.parametrize(
    ("required", "available"),
    [
        ('"requests>=2.31"', '"requests>=2.32"'),
        ('"Requests"', '"requests"'),
        ('"requests"', '"requests >= 2"'),
    ],
)
def test_component_import_compares_dependency_names(required, available):
    from duckpad.bundle import default_pyproject

    code = "import duckpad as dp\n\nclass T(dp.Node):\n    def run(self) -> dp.Relation:\n        return self.db.sql('SELECT 1')\n"

    def bundle(dependency):
        manifest = default_pyproject("p").replace('"pytz>=2024.1"]', f'"pytz>=2024.1", {dependency}]')
        return {
            "flow": {"nodes": [], "edges": []},
            "templates": {"t.py": code},
            "components": {},
            "pyproject": manifest,
        }

    import_definition(bundle(available), bundle(required), "templates", "t.py", {})
