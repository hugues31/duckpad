import time

import pytest

from duckpad.catalog import Catalog
from duckpad.engine import Engine
from duckpad.projects import Projects
from duckpad.store import Store


@pytest.fixture
def services(tmp_path):
    store = Store(tmp_path / "instance")
    projects = Projects(store)
    catalog = Catalog(store)
    engine = Engine(store, projects, catalog)
    projects.on_change = engine.invalidate
    catalog.on_change = engine.invalidate
    yield store, projects, catalog, engine
    projects.stop()
    engine.close()
    store.close()


def wait_run(store, run, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = store.get("run", run["id"])
        if result["status"] not in ("preparing", "running", "canceling"):
            return result
        time.sleep(0.01)
    raise AssertionError("Run did not finish")


def example_bundle(path):
    path.write_text("id,region,amount\n1,North,10\n2,North,20\n3,South,30\n")
    return {
        "flow": {
            "name": "Test",
            "nodes": [
                {"id": "source", "template": "source", "params": {"file": str(path)}},
                {"id": "filter", "template": "filter", "params": {"threshold": 0}},
                {"id": "total", "template": "total", "params": {}},
            ],
            "edges": [
                {
                    "id": "a",
                    "source": "source",
                    "sourceHandle": "result",
                    "target": "filter",
                    "targetHandle": "source",
                },
                {
                    "id": "b",
                    "source": "filter",
                    "sourceHandle": "result",
                    "target": "total",
                    "targetHandle": "source",
                },
            ],
        },
        "templates": {
            "source": '-- @kind source\n-- @param connection: connection = "local"\n-- @param file: file(connection)\n-- @output result\nSELECT * FROM read_csv({{ file }});',
            "filter": "-- @input source\n-- @param threshold: number = 0\n-- @output result\nSELECT * FROM {{ source }} WHERE amount > {{ threshold }};",
            "total": "-- @input source\n-- @output result\nSELECT region, SUM(amount) AS total, COUNT(*) AS count FROM {{ source }} GROUP BY region ORDER BY region;",
        },
        "components": {},
        "documentation": {},
    }
