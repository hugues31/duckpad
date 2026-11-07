"""Python partition boundaries use SQL semantics before their only materialization."""

import duckdb
import pytest
from helpers import wait_run
from test_partitions import bundle
from test_python_nodes import single

from duckpad.bundle import bundle_to_files
from duckpad.native import Cursor
from duckpad.partition_filters import filter_statements
from duckpad.python_execution import execute
from duckpad.util import Problem, qi


def payload(tmp_path, query, key):
    return {
        "code": f"""import duckpad as dp
class Source(dp.Node):
    def run(self) -> dp.Relation:
        return self.db.sql({query!r})
""",
        "parameters": {},
        "inputs": {},
        "outputs": {"result": "staged"},
        "workspace": str(tmp_path / "execution"),
        "partition": {"key": key},
        "partition_filters": {"result": {"column": "batch"}},
    }


@pytest.mark.parametrize(
    ("kind", "value", "sql_type", "accepted"),
    [
        *[
            ("number", 42, t, True)
            for t in (
                "TINYINT",
                "SMALLINT",
                "INTEGER",
                "BIGINT",
                "HUGEINT",
                "UTINYINT",
                "USMALLINT",
                "UINTEGER",
                "UBIGINT",
                "UHUGEINT",
                "FLOAT",
                "DOUBLE",
                "DECIMAL(12,2)",
            )
        ],
        ("number", 1.5, "INTEGER", False),
        ("number", 128, "TINYINT", False),
        ("number", -1, "UINTEGER", False),
        ("number", 2**53 - 1, "BIGINT", True),
        ("number", 2**53 + 1, "HUGEINT", False),
        ("number", 0.1, "FLOAT", False),
        ("number", 0.1, "DOUBLE", True),
        ("number", 1.25, "DECIMAL(12,2)", True),
        ("number", 1.251, "DECIMAL(12,2)", False),
        ("number", 1, "VARCHAR", False),
        ("number", 1, "BOOLEAN", False),
        ("number", float("inf"), "DOUBLE", False),
        ("number", float("nan"), "DOUBLE", False),
        ("text", "42", "VARCHAR", True),
        ("text", "42", "INTEGER", False),
        ("text", "2026-01-02", "DATE", False),
        ("text", "x' OR TRUE --", "VARCHAR", True),
        ("boolean", True, "BOOLEAN", True),
        ("boolean", False, "BOOLEAN", True),
        ("boolean", True, "INTEGER", False),
        ("boolean", True, "VARCHAR", False),
        ("date", "2026-01-02", "DATE", True),
        ("date", "2026-01-02", "VARCHAR", True),
        ("date", "2026-01-02", "TIMESTAMP", False),
        ("date", "2026-02-30", "VARCHAR", False),
        ("date", "20260102", "VARCHAR", False),
        ("text", None, "VARCHAR", False),
    ],
)
def test_sql_and_python_accept_the_same_key_column_pairs(tmp_path, kind, value, sql_type, accepted):
    key = {"type": kind, "value": value}
    query = f'SELECT NULL::{sql_type} AS "BaTcH" WHERE FALSE'
    request = payload(tmp_path, query, key)
    statement = {"output": "result", "query": query, "bindings": {}}
    with duckdb.connect() as db:
        try:
            filter_statements([statement], request, request["partition"], db)
            sql_accepted = True
        except (Problem, duckdb.Error):
            sql_accepted = False
        result = execute(Cursor(db), request)
        assert sql_accepted == accepted
        assert ("error" not in result) == accepted, result.get("error")
        assert bool(db.execute("SHOW TABLES").fetchall()) == accepted


class RecordingDatabase:
    def __init__(self, db):
        self.db = db
        self.statements = []

    def __getattr__(self, name):
        return getattr(self.db, name)

    def execute(self, query, parameters=None):
        self.statements.append(query)
        return self.db.execute(query, parameters or [])


@pytest.mark.parametrize(
    ("query", "key", "expected"),
    [
        ("SELECT * FROM (VALUES ('a', 1), ('a', 1), ('b', 2)) t(batch, amount)", "a", [("a", 1), ("a", 1)]),
        ("SELECT * FROM (VALUES ('a'), ('b')) t(batch) ORDER BY batch LIMIT 1", "b", []),
        ("SELECT batch, count(*) FROM (VALUES ('a'), ('a'), ('b')) t(batch) GROUP BY batch", "a", [("a", 2)]),
        ("SELECT 'a' AS batch", "x' OR TRUE --", []),
    ],
)
def test_worker_materializes_only_filtered_rows_once(tmp_path, query, key, expected):
    with duckdb.connect() as db:
        recording = RecordingDatabase(db)
        result = execute(Cursor(recording), payload(tmp_path, query, {"type": "text", "value": key}))
        assert "error" not in result, result.get("error")
        creates = [q for q in recording.statements if q.startswith("CREATE TABLE")]
        assert len(creates) == 1
        assert "WHERE" in creates[0]
        assert db.execute("SELECT * FROM staged").fetchall() == expected
        assert db.execute("SHOW TABLES").fetchall() == [("staged",)]


def test_invalid_later_output_rolls_back_before_write(tmp_path):
    request = payload(tmp_path, "", {"type": "number", "value": 1})
    request["outputs"] = {"first": "staged", "second": "invalid"}
    request["partition_filters"] = {"second": {"column": "batch"}}
    request["code"] = """import duckpad as dp
class Source(dp.Node):
    class Outputs(dp.Outputs):
        first: dp.Relation
        second: dp.Relation
    def run(self) -> Outputs:
        return self.Outputs(first=self.db.sql('SELECT 1 AS batch'),
                            second=self.db.sql('SELECT 2 AS wrong_column'))
    def write(self):
        raise AssertionError('write must not run')
"""
    with duckdb.connect() as db:
        result = execute(Cursor(db), request)
        assert "partition_column" in result["error"]
        assert "write must not run" not in result["error"]
        assert db.execute("SHOW TABLES").fetchall() == []


def test_partitioned_python_outputs_are_published_without_server_copies(services, monkeypatch):
    from duckpad.sandbox import Cursor as WorkerCursor

    store, projects, _, engine = services
    tree = single(services, "import duckpad as dp\nclass Seed(dp.Node):\n    def run(self) -> None: pass\n")
    snapshot = projects.snapshot(tree["id"])
    project = bundle()
    project["pyproject"] = snapshot["bundle"]["pyproject"]
    source = project["flow"]["nodes"][1]
    source.pop("template")
    source["language"] = "python"
    project["node_sql"] = {
        "nodes/source.py": """import duckpad as dp
class Source(dp.Node):
    class Outputs(dp.Outputs):
        result: dp.Relation
        summary: dp.Relation
    def run(self) -> Outputs:
        return self.Outputs(
            result=self.db.sql("SELECT * FROM (VALUES ('a', 1), ('a', 1), ('b', 2)) t(batch, amount)"),
            summary=self.db.sql("SELECT 3 AS total"))
"""
    }
    projects.write(tree["id"], snapshot["revision"], bundle_to_files(project))
    execute_sql = WorkerCursor.execute
    python_call = WorkerCursor.python
    outputs = []
    statements = []
    compute_python = engine.runs._compute_python
    publishing = False

    def observe_publication(*args, **kwargs):
        nonlocal publishing
        publishing = True
        try:
            return compute_python(*args, **kwargs)
        finally:
            publishing = False

    def observe_python(cursor, request):
        response = python_call(cursor, request)
        if "error" not in response:
            # Both the filtered and unfiltered ports are already final in the worker.
            rows = execute_sql(cursor, "SELECT * FROM " + qi(request["outputs"]["result"])).fetchall()
            key = request["partition"]["key"]["value"]
            assert rows == ([("a", 1), ("a", 1)] if key == "a" else [("b", 2)])
            summary = execute_sql(cursor, "SELECT * FROM " + qi(request["outputs"]["summary"])).fetchall()
            assert summary == [(3,)]
            outputs.extend(request["outputs"].values())
        return response

    def observe_sql(cursor, query, parameters=None):
        if publishing:
            statements.append(query)
        return execute_sql(cursor, query, parameters)

    monkeypatch.setattr(engine.runs, "_compute_python", observe_publication)
    monkeypatch.setattr(WorkerCursor, "python", observe_python)
    monkeypatch.setattr(WorkerCursor, "execute", observe_sql)
    run = wait_run(store, engine.launch(tree["id"], "dev"), timeout=60)
    assert run["status"] == "success", run["nodes"]
    assert len(outputs) == 4
    assert not any(q.startswith("CREATE TABLE") and any(t in q for t in outputs) for q in statements)
    assert [r["values"] for r in engine.preview(tree["id"], "dev", "collect")["rows"]] == [
        [10, "one"],
        [10, "one"],
        [20, "two"],
    ]
