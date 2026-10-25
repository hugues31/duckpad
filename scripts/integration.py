"""Opt-in connector acceptance tests using isolated, disposable resources.

Oracle requires ORADUCK_ORACLE_USER, ORADUCK_ORACLE_PASSWORD and
ORADUCK_ORACLE_DSN. The script creates uniquely named test tables and removes
only those tables. S3 uses an ephemeral Moto endpoint on localhost.
"""

import argparse
import json
import os
import platform
import tempfile
import time
import uuid
from pathlib import Path

import duckdb

from duckpad.catalog import Catalog
from duckpad.engine import Engine
from duckpad.lineage import Lineage
from duckpad.projects import Projects
from duckpad.store import Store
from duckpad.templates import BUILTINS
from duckpad.util import dumps, literal


def wait(store, engine, worktree):
    run = engine.launch(worktree, "dev")
    while store.get("run", run["id"])["status"] in ("preparing", "running", "canceling"):
        time.sleep(0.02)
    result = store.get("run", run["id"])
    assert result["status"] == "success", {
        key: {"status": value["status"], "error": value.get("error")}
        for key, value in result["nodes"].items()
    }
    return result


def edge(source, target, port="source"):
    return {
        "id": source + "_" + target,
        "source": source,
        "sourceHandle": "result",
        "target": target,
        "targetHandle": port,
    }


def node(identity, template, **params):
    return {"id": identity, "template": template, "params": params, "position": {"x": 0, "y": 0}}


def services(home):
    store = Store(home)
    projects, catalog = Projects(store), Catalog(store)
    engine = Engine(store, projects, catalog)
    projects.on_change = engine.invalidate
    catalog.on_change = engine.invalidate
    return store, projects, catalog, engine


def oracle(home):
    import oracledb

    values = {
        "user": os.environ["ORADUCK_ORACLE_USER"],
        "password": os.environ["ORADUCK_ORACLE_PASSWORD"],
        "dsn": os.environ["ORADUCK_ORACLE_DSN"],
    }
    connection = oracledb.connect(**values)
    cursor = connection.cursor()
    suffix = uuid.uuid4().hex[:8].upper()
    source, destination, native = [f"DP_TEST_{role}_{suffix}" for role in ("SRC", "DST", "NATIVE")]
    created = []
    store, projects, catalog, engine = services(home)
    try:
        for name in (source, destination, native):
            cursor.execute(f"CREATE TABLE {name} (ID NUMBER(10), AMOUNT NUMBER(10,2))")
            created.append(name)
        cursor.executemany(f"INSERT INTO {source} VALUES (:1,:2)", [(1, 10), (2, 20), (3, 30)])
        connection.commit()
        catalog.save(
            "connection",
            {
                "id": "oracle_acceptance",
                "name": "Oracle acceptance",
                "connector": "oracle",
                "environments": {"dev": values, "prod": values},
            },
        )
        templates = dict(BUILTINS)
        templates["calculate"] = (
            "-- @input source\n-- @output result\nSELECT ID, AMOUNT * 2 AS AMOUNT FROM {{ source }} WHERE AMOUNT >= 20;"
        )
        bundle = {
            "flow": {
                "nodes": [
                    node(
                        "read",
                        "load_oracle",
                        connection="oracle_acceptance",
                        schema=values["user"],
                        resource=source,
                    ),
                    node("calculate", "calculate"),
                    node("write", "export_oracle", connection="oracle_acceptance", destination=destination),
                ],
                "edges": [edge("read", "calculate"), edge("calculate", "write")],
            },
            "templates": templates,
            "components": {},
            "documentation": {},
        }
        worktree = projects.create("Oracle acceptance", bundle)["id"]
        first = wait(store, engine, worktree)
        preview = engine.preview(worktree, "dev", "calculate")
        explanation = Lineage(engine).explain(
            worktree, "dev", preview["id"], preview["rows"][0]["id"], "AMOUNT"
        )
        assert explanation["complete"] and explanation["total"] == 1, explanation
        # Compare with the same native COPY SQL in the same context and engine.
        context, dataset = engine.find_dataset(worktree, "dev", "calculate")
        sql = first["nodes"]["write"]["statements"][0]["sql"].replace("$destination", literal(native))
        context.db.execute(sql)
        cursor.execute(f"SELECT ID, AMOUNT FROM {destination} ORDER BY ID")
        expected = cursor.fetchall()
        cursor.execute(f"SELECT ID, AMOUNT FROM {native} ORDER BY ID")
        assert cursor.fetchall() == expected == [(2, 40), (3, 60)]
        cursor.execute(f"ALTER TABLE {source} ADD NOTE VARCHAR2(30)")
        cursor.execute(f"INSERT INTO {source} (ID, AMOUNT, NOTE) VALUES (4, 40, 'new schema')")
        connection.commit()
        assert engine.preview(worktree, "dev", "read")["count"] == 3
        second = wait(store, engine, worktree)
        assert engine.preview(worktree, "dev", "read")["count"] == 4
        assert "NOTE" in {c["name"] for c in engine.preview(worktree, "dev", "read")["columns"]}
        cursor.execute(f"SELECT count(*) FROM {destination}")
        assert cursor.fetchone()[0] == 5  # Native append, with no hidden truncation.
        assert values["password"] not in dumps(store.all("run"))
        assert values["password"] not in projects.git(
            projects.get(worktree)["path"], "show", "HEAD:flow.json"
        )
        extensions = context.db.execute(
            "SELECT extension_name, extension_version FROM duckdb_extensions() WHERE loaded"
        ).fetchall()
        return {
            "status": "passed",
            "duckdb": duckdb.__version__,
            "oracle": connection.version,
            "platform": platform.platform(),
            "extensions": extensions,
            "first_run_seconds": first["duration"],
            "refresh_run_seconds": second["duration"],
            "checks": [
                "source",
                "transform",
                "native export equivalence",
                "shared named connection",
                "repeated append",
                "schema refresh",
                "materialized source freshness",
                "cell lineage",
                "secret redaction",
            ],
        }
    finally:
        engine.close()
        store.close()
        for table in created:
            cursor.execute(f"DROP TABLE {table} PURGE")
        cursor.close()
        connection.close()


def s3(home):
    import boto3
    from moto.server import ThreadedMotoServer

    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id="duckpad-test-key",
        aws_secret_access_key="duckpad-test-secret",
        region_name="us-east-1",
    )
    store, projects, catalog, engine = services(home)
    try:
        client.create_bucket(Bucket="duckpad-acceptance")
        client.put_object(
            Bucket="duckpad-acceptance", Key="orders.csv", Body=b"id,amount\n1,10\n2,20\n3,30\n"
        )
        parquet = home / "labels.parquet"
        db = duckdb.connect()
        db.execute(
            f"COPY (SELECT * FROM (VALUES (1,'North'),(2,'South'),(3,'West')) t(id,region)) TO {literal(str(parquet))} (FORMAT PARQUET)"
        )
        db.close()
        client.put_object(Bucket="duckpad-acceptance", Key="labels.parquet", Body=parquet.read_bytes())
        values = {
            "key_id": "duckpad-test-key",
            "secret": "duckpad-test-secret",
            "region": "us-east-1",
            "endpoint": f"{host}:{port}",
            "use_ssl": False,
            "url_style": "path",
        }
        catalog.save(
            "connection",
            {
                "id": "s3_acceptance",
                "name": "S3 acceptance",
                "connector": "s3",
                "environments": {"dev": values, "prod": values},
            },
        )
        bundle = {
            "flow": {
                "nodes": [
                    node(
                        "csv",
                        "load_csv",
                        connection="s3_acceptance",
                        file="s3://duckpad-acceptance/orders.csv",
                    ),
                    node(
                        "parquet",
                        "load_parquet",
                        connection="s3_acceptance",
                        file="s3://duckpad-acceptance/labels.parquet",
                    ),
                    node("joined", "join", condition="l.id = r.id", columns="l.*, r.region"),
                    node(
                        "export",
                        "export_csv",
                        connection="s3_acceptance",
                        destination="s3://duckpad-acceptance/export.csv",
                    ),
                ],
                "edges": [
                    edge("csv", "joined", "left"),
                    edge("parquet", "joined", "right"),
                    edge("joined", "export"),
                ],
            },
            "templates": dict(BUILTINS),
            "components": {},
            "documentation": {},
        }
        worktree = projects.create("S3 acceptance", bundle)["id"]
        first = wait(store, engine, worktree)
        exported = client.get_object(Bucket="duckpad-acceptance", Key="export.csv")["Body"].read()
        assert b"South" in exported and b"20" in exported
        preview = engine.preview(worktree, "dev", "joined")
        explanation = Lineage(engine).explain(worktree, "dev", preview["id"], 0, "amount")
        assert explanation["complete"] and explanation["total"] == 1, explanation
        second = wait(store, engine, worktree)
        assert client.get_object(Bucket="duckpad-acceptance", Key="export.csv")["Body"].read() == exported
        assert values["secret"] not in dumps(store.all("run"))
        return {
            "status": "passed",
            "duckdb": duckdb.__version__,
            "endpoint": "Moto S3 emulator on localhost",
            "platform": platform.platform(),
            "first_run_seconds": first["duration"],
            "repeat_run_seconds": second["duration"],
            "checks": [
                "CSV read",
                "Parquet read",
                "join",
                "CSV export",
                "repeat native replacement",
                "shared connection reuse",
                "cell lineage",
                "secret redaction",
            ],
        }
    finally:
        engine.close()
        store.close()
        server.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("connector", choices=["oracle", "s3"])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="duckpad-integration-") as directory:
        result = {"connector": args.connector, **globals()[args.connector](Path(directory))}
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(dumps(result))
        print(json.dumps(result, indent=2))
