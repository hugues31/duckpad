"""The code editors' catalog describes the server's own DuckDB."""

import gzip
import json

import duckdb
import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.code_catalog import code_catalog, sql_functions


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        user = app.state.auth.create_user("reader", "catalog-test-password", "member")
        token = app.state.auth.login(user["username"], "catalog-test-password", peer="reader")
        client.headers.update({"authorization": "Bearer " + token})
        yield client


def test_signed_in_users_read_functions_keywords_types_and_python_members(client):
    response = client.get("/api/code-catalog")
    assert response.status_code == 200
    catalog = response.json()
    assert catalog["duckdb_version"] == duckdb.__version__
    functions = {f["name"]: f for f in catalog["functions"]}
    strftime = functions["strftime"]
    assert strftime["kind"] == "scalar"
    assert strftime["description"] and strftime["examples"]
    assert ["format", "data"] in [[p["name"] for p in s["parameters"]] for s in strftime["signatures"]]
    assert functions["sum"]["kind"] == "aggregate"
    # Named options of table functions are listed apart from their positional argument.
    read_csv = functions["read_csv"]
    assert [p["name"] for p in read_csv["signatures"][0]["parameters"]] == ["path"]
    assert {"name": "header", "type": "BOOLEAN"} in read_csv["options"]
    # Operators and internal helpers cannot be typed as function names.
    assert all(name[0].isalpha() for name in functions)
    keywords = {k["name"]: k["category"] for k in catalog["keywords"]}
    assert keywords["SELECT"] == "reserved"
    assert {"VARCHAR", "DECIMAL", "TIMESTAMP WITH TIME ZONE"} <= set(catalog["types"])
    relation = {m["name"]: m for m in catalog["python"]["relation"]}
    assert relation["filter"]["kind"] == "method"
    assert relation["filter"]["signature"].startswith("(filter_expr")
    assert relation["filter"]["doc"]
    assert relation["columns"]["kind"] == "property"
    assert "sql" in {m["name"] for m in catalog["python"]["connection"]}
    assert {"col", "lit"} <= {m["name"] for m in catalog["python"]["module"]}


def test_catalog_is_sent_compressed_to_browsers(client):
    response = client.get("/api/code-catalog", headers={"accept-encoding": "gzip"})
    assert response.headers["content-encoding"] == "gzip"
    assert response.headers["cache-control"] == "no-store"
    # The test client decodes the body like a browser.
    assert response.json() == json.loads(json.dumps(code_catalog()))
    plain = client.get("/api/code-catalog", headers={"accept-encoding": "identity"})
    assert "content-encoding" not in plain.headers
    assert len(gzip.compress(plain.content)) < len(plain.content) / 5


def test_overloads_fold_into_distinct_parameter_lists():
    rows = [
        ("round", "scalar", "Rounds x", ["round(1.5)"], ["x"], ["INTEGER"], None, "INTEGER"),
        ("round", "scalar", None, [], ["x"], ["DOUBLE"], None, "DOUBLE"),
        ("round", "scalar", None, [], ["x", "precision"], ["DOUBLE", "INTEGER"], None, "DOUBLE"),
        ("~~", "scalar", "Operator", [], ["a", "b"], ["VARCHAR", "VARCHAR"], None, "BOOLEAN"),
    ]
    assert sql_functions(rows) == [
        {
            "name": "round",
            "kind": "scalar",
            "description": "Rounds x",
            "examples": ["round(1.5)"],
            "signatures": [
                # The overloads disagree on the type of x and on the result.
                {"parameters": [{"name": "x", "type": ""}], "returns": ""},
                {
                    "parameters": [{"name": "x", "type": "DOUBLE"}, {"name": "precision", "type": "INTEGER"}],
                    "returns": "DOUBLE",
                },
            ],
        }
    ]
