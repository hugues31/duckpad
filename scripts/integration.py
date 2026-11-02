"""Opt-in connector acceptance tests using isolated, disposable resources.

Oracle requires ORADUCK_ORACLE_USER, ORADUCK_ORACLE_PASSWORD and
ORADUCK_ORACLE_DSN. The script creates uniquely named test tables and removes
only those tables. S3 uses an ephemeral Moto endpoint on localhost, through the
built-in connector and a custom storage type, both with a URI root.

Databases run Load table, a transform and Export table in dev and prod, in the
embedded and isolated execution modes (SQLite files: embedded only):

- postgres: DUCKPAD_POSTGRES_HOST, _PORT, _USER, _PASSWORD, _DEV_DATABASE and
  _PROD_DATABASE; DUCKPAD_POSTGRES_SSL=1 when the server accepts TLS. The script
  creates a uniquely named schema in each database and drops only that schema.
- mysql: a dev and a prod server, DUCKPAD_MYSQL_HOST, _DEV_PORT, _PROD_PORT,
  _USER, _PASSWORD and _DATABASE; uniquely named tables, dropped afterwards.
- sqlite: temporary database files.

MySQL and SQLite use the example definitions published in docs/connectors/.
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

from duckpad.auth import Auth
from duckpad.builtin_templates import BUILTINS
from duckpad.execution.runs import UNFINISHED_RUN_STATUSES
from duckpad.lineage import Lineage
from duckpad.services import Services
from duckpad.util import Problem, dumps, literal, qi

RUN_TIMEOUT = 600
EXAMPLES = Path(__file__).resolve().parents[1] / "docs" / "connectors"


def wait(store, engine, worktree, environment="dev"):
    run = engine.launch(worktree, environment)
    deadline = time.monotonic() + RUN_TIMEOUT
    result = store.get("run", run["id"])
    while result["status"] in UNFINISHED_RUN_STATUSES:
        assert time.monotonic() < deadline, "The run did not finish"
        time.sleep(0.05)
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
    instance = Services.open(home)
    store, projects, catalog, engine = instance.store, instance.projects, instance.catalog, instance.engine
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
            create=True,
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
                        "load_table",
                        connection="oracle_acceptance",
                        schema=values["user"],
                        table=source,
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
        context, _dataset = engine.find_dataset(worktree, "dev", "calculate")
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
        instance.close()
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
    instance = Services.open(home)
    store, projects, catalog, engine = instance.store, instance.projects, instance.catalog, instance.engine
    try:
        client.create_bucket(Bucket="duckpad-acceptance")
        client.put_object(
            Bucket="duckpad-acceptance", Key="landing/orders.csv", Body=b"id,amount\n1,10\n2,20\n3,30\n"
        )
        parquet = home / "labels.parquet"
        db = duckdb.connect()
        db.execute(
            f"COPY (SELECT * FROM (VALUES (1,'North'),(2,'South'),(3,'West')) t(id,region)) TO {literal(str(parquet))} (FORMAT PARQUET)"
        )
        db.close()
        client.put_object(
            Bucket="duckpad-acceptance", Key="landing/labels.parquet", Body=parquet.read_bytes()
        )
        values = {
            # Relative paths are appended to the root, which has no trailing slash on purpose.
            "root": "s3://duckpad-acceptance/landing",
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
            create=True,
        )
        # An administrator-declared storage type, as pasted into New connector.
        catalog.save(
            "connector",
            {
                "id": "landing_bucket",
                "name": "Landing bucket",
                "family": "storage",
                "parameters": [
                    {"name": "root", "type": "text"},
                    {"name": "key_id", "type": "text", "secret": True},
                    {"name": "secret", "type": "text", "secret": True},
                    {"name": "endpoint", "type": "text"},
                ],
                "extensions": [{"name": "httpfs"}],
                "init_sql": "CREATE OR REPLACE TEMPORARY SECRET {{ secret_name }} (TYPE S3, KEY_ID {{ key_id }}, SECRET {{ secret }}, ENDPOINT {{ endpoint }}, USE_SSL false, URL_STYLE 'path');",
                "capabilities": ["read"],
            },
            create=True,
        )
        landing = {
            "root": "s3://duckpad-acceptance/landing/",
            "key_id": values["key_id"],
            "secret": values["secret"],
            "endpoint": values["endpoint"],
        }
        catalog.save(
            "connection",
            {
                "id": "landing",
                "name": "Landing",
                "connector": "landing_bucket",
                "environments": {"dev": landing, "prod": landing},
            },
            create=True,
        )
        bundle = {
            "flow": {
                "nodes": [
                    node("csv", "load_csv", connection="s3_acceptance", file="orders.csv"),
                    node("parquet", "load_parquet", connection="s3_acceptance", file="labels.parquet"),
                    node("joined", "join", condition="l.id = r.id", columns="l.*, r.region"),
                    node("export", "export_csv", connection="s3_acceptance", destination="export.csv"),
                    node("custom", "load_csv", connection="landing", file="orders.csv"),
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
        assert "'s3://duckpad-acceptance/landing/orders.csv'" in first["nodes"]["csv"]["statements"][0]["sql"]
        exported = client.get_object(Bucket="duckpad-acceptance", Key="landing/export.csv")["Body"].read()
        assert b"South" in exported and b"20" in exported
        assert [row["values"] for row in engine.preview(worktree, "dev", "custom")["rows"]] == [
            [1, 10],
            [2, 20],
            [3, 30],
        ]
        preview = engine.preview(worktree, "dev", "joined")
        explanation = Lineage(engine).explain(worktree, "dev", preview["id"], 0, "amount")
        assert explanation["complete"] and explanation["total"] == 1, explanation
        second = wait(store, engine, worktree)
        assert (
            client.get_object(Bucket="duckpad-acceptance", Key="landing/export.csv")["Body"].read()
            == exported
        )
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
                "relative paths under a URI root",
                "custom storage type",
                "repeat native replacement",
                "shared connection reuse",
                "cell lineage",
                "secret redaction",
            ],
        }
    finally:
        instance.close()
        server.stop()


def refused(call, expected):
    """Run a call that must fail, and return its message after checking it names the cause."""
    try:
        call()
    except Problem as error:
        message = str(error)
    else:
        raise AssertionError(f"Expected a failure mentioning {expected}")
    assert expected in message.lower(), message
    return message


def table_flow(schema, source, destination):
    """Load table, an aggregate and Export table on one database connection."""
    return {
        "flow": {
            "nodes": [
                node("read", "load_table", connection="warehouse", schema=schema, table=source),
                node("totals", "aggregate", groups="region", measures="CAST(SUM(amount) AS BIGINT) AS total"),
                node("write", "export_table", connection="warehouse", schema=schema, table=destination),
            ],
            "edges": [edge("read", "totals"), edge("totals", "write")],
        },
        "templates": dict(BUILTINS),
        "components": {},
        "documentation": {},
    }


def attached(statements):
    """A DuckDB session outside Duckpad, with the database under test attached as `fixture`."""
    db = duckdb.connect()
    for statement in statements:
        db.execute(statement)
    return db


def seed(statements, schema, source, destination, multiplier, *, create_schema):
    """Create the source table and an existing destination with an extra column."""
    with attached(statements) as db:
        if create_schema:
            db.execute(f"CREATE SCHEMA fixture.{qi(schema)}")
        db.execute(
            f"CREATE TABLE fixture.{qi(schema)}.{qi(source)} (id INTEGER, region VARCHAR, amount INTEGER)"
        )
        db.execute(
            f"INSERT INTO fixture.{qi(schema)}.{qi(source)} VALUES (1, 'North', ?), (2, 'South', ?), (3, 'North', ?)",
            [10 * multiplier, 20 * multiplier, 30 * multiplier],
        )
        db.execute(
            f"CREATE TABLE fixture.{qi(schema)}.{qi(destination)} (region VARCHAR, total BIGINT, note VARCHAR)"
        )


def fetch(statements, query):
    with attached(statements) as db:
        return db.execute(query).fetchall()


def database_run(home, mode, connector, environments, tables, attach, extra=None):
    """Run the table flow through a connection in one execution mode, then check every write."""
    schema, source, destination = tables
    isolated = mode == "isolated"
    instance = Services.open(home / mode, enforce_access=isolated)
    store, projects, catalog, engine = instance.store, instance.projects, instance.catalog, instance.engine
    try:
        if connector != "postgres":
            catalog.save("connector", json.loads((EXAMPLES / f"{connector}.json").read_text()))
        connection = {
            "id": "warehouse",
            "name": "Warehouse",
            "connector": connector,
            "environments": environments,
        }
        catalog.save("connection", json.loads(json.dumps(connection)), create=True)
        tested = engine.test_connection(connection, "dev")
        assert schema in tested["schemas"], tested
        assert {"schema": schema, "name": source, "view": False} in tested["tables"], tested
        bundle = table_flow(schema, source, destination)
        if isolated:
            Auth(store)
            owner = store.get("user", "admin")
            access = engine.access
            assert access is not None
            worktree = access.create(
                owner, lambda grant: projects.create(f"{connector} acceptance", bundle, record=grant)
            )["id"]
            access.grant_connections(projects.get(worktree)["project"], ["warehouse"])
        else:
            worktree = projects.create(f"{connector} acceptance", bundle)["id"]
        first = wait(store, engine, worktree)
        listed = engine.connection_objects(worktree, "warehouse", "dev")
        assert {"schema": schema, "name": destination, "view": False} in listed["tables"], listed
        rows = engine.preview(worktree, "dev", "read")["rows"]
        assert [row["values"][1:] for row in rows] == [["North", 10], ["South", 20], ["North", 30]], rows
        preview = engine.preview(worktree, "dev", "totals")
        north = next(row for row in preview["rows"] if row["values"][0] == "North")
        explanation = Lineage(engine).explain(worktree, "dev", preview["id"], north["id"], "total")
        assert explanation["complete"] and explanation["total"] == 2, explanation
        second = wait(store, engine, worktree)
        production = wait(store, engine, worktree, "prod")
        query = f"SELECT region, total, note FROM fixture.{qi(schema)}.{qi(destination)} ORDER BY ALL"
        # Native appends: two dev runs, nothing truncated, unmapped destination columns left NULL.
        assert fetch(attach["dev"], query) == [("North", 40, None)] * 2 + [("South", 20, None)] * 2
        assert fetch(attach["prod"], query) == [("North", 400, None), ("South", 200, None)]
        details = extra(engine, connection) if extra else {}
        secrets = [values["password"] for values in environments.values() if values.get("password")]
        assert not any(secret in dumps(store.all("run")) for secret in secrets)
        return {
            "first_run_seconds": first["duration"],
            "repeat_run_seconds": second["duration"],
            "production_run_seconds": production["duration"],
            **details,
        }
    finally:
        instance.close()


def database(home, connector, environments, tables, attach, *, modes, extra=None):
    schema, _, destination = tables
    runs = {}
    for mode in modes:
        runs[mode] = database_run(home, mode, connector, environments, tables, attach, extra)
        for statements in attach.values():
            with attached(statements) as db:
                db.execute(f"DELETE FROM fixture.{qi(schema)}.{qi(destination)}")
    with attached(attach["dev"]) as db:
        extensions = db.execute(
            "SELECT extension_name, extension_version, install_mode FROM duckdb_extensions() WHERE loaded "
            "AND extension_name NOT IN ('core_functions', 'icu', 'json', 'parquet')"
        ).fetchall()
    return {
        "status": "passed",
        "duckdb": duckdb.__version__,
        "platform": platform.platform(),
        "extensions": extensions,
        "modes": runs,
        "checks": [
            "test connection lists schemas and tables",
            "inspector listing",
            "Load table",
            "transform",
            "Export table inserts by name into an existing table",
            "repeated append without truncation",
            "dev and prod values",
            "cell lineage",
            "secret redaction",
            *(["Additional options", "wrong password and unreachable host reported"] if extra else []),
        ],
    }


def postgres(home):
    environment = os.environ
    suffix = uuid.uuid4().hex[:8]
    schema = f"duckpad_{suffix}"
    base = {
        "host": environment.get("DUCKPAD_POSTGRES_HOST", "127.0.0.1"),
        "port": int(environment.get("DUCKPAD_POSTGRES_PORT", "5432")),
        "user": environment["DUCKPAD_POSTGRES_USER"],
        "password": environment["DUCKPAD_POSTGRES_PASSWORD"],
    }
    ssl = environment.get("DUCKPAD_POSTGRES_SSL") == "1"
    databases = {
        "dev": environment["DUCKPAD_POSTGRES_DEV_DATABASE"],
        "prod": environment["DUCKPAD_POSTGRES_PROD_DATABASE"],
    }
    application = f"duckpad-validation-{suffix}"
    # Driver settings the definition does not expose go to Additional options as libpq keywords.
    environments = {
        "dev": {**base, "database": databases["dev"], "options": f"application_name={application}"},
        "prod": {
            **base,
            "database": databases["prod"],
            "options": f"application_name={application} sslmode={'require' if ssl else 'disable'}",
        },
    }
    attach = {}
    for name, database_name in databases.items():
        settings = ", ".join(
            f"{key} {literal(value)}"
            for key, value in (
                ("HOST", base["host"]),
                ("PORT", base["port"]),
                ("DATABASE", database_name),
                ("USER", base["user"]),
                ("PASSWORD", base["password"]),
            )
        )
        attach[name] = [
            f"CREATE SECRET fixture_secret (TYPE postgres, {settings})",
            "ATTACH '' AS fixture (TYPE postgres, SECRET fixture_secret)",
        ]
    sessions_query = (
        "SELECT s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid) "
        f"WHERE a.application_name = {literal(application)}"
    )

    def options(engine, connection):
        sessions = fetch(
            attach["prod"], f"SELECT * FROM postgres_query('fixture', {literal(sessions_query)})"
        )
        assert sessions and all(row == (ssl,) for row in sessions), sessions
        details = {"production_sessions_use_tls": ssl}
        wrong = json.loads(json.dumps(connection))
        wrong["environments"]["dev"]["password"] = "not-the-password"
        details["wrong_password"] = refused(
            lambda: engine.test_connection(wrong, "dev"), "password authentication failed"
        )
        assert "not-the-password" not in details["wrong_password"]
        unreachable = json.loads(json.dumps(connection))
        unreachable["environments"]["dev"].update(host="127.0.0.1", port=1)
        details["unreachable_host"] = refused(
            lambda: engine.test_connection(unreachable, "dev"), "connection"
        )
        if ssl:
            # A self-signed server certificate: verify-full must refuse it.
            strict = json.loads(json.dumps(connection))
            strict["environments"]["prod"]["options"] = "sslmode=verify-full sslrootcert=system"
            details["verify_full"] = refused(lambda: engine.test_connection(strict, "prod"), "certificate")
        return details

    for name in databases:
        seed(attach[name], schema, "orders", "order_totals", 1 if name == "dev" else 10, create_schema=True)
    try:
        version = fetch(
            attach["dev"],
            "SELECT * FROM postgres_query('fixture', 'SELECT current_setting(''server_version'')')",
        )[0][0]
        result = database(
            home,
            "postgres",
            environments,
            (schema, "orders", "order_totals"),
            attach,
            modes=("embedded", "isolated"),
            extra=options,
        )
        return {**result, "postgres": version}
    finally:
        for statements in attach.values():
            with attached(statements) as db:
                db.execute(f"CALL postgres_execute('fixture', {literal(f'DROP SCHEMA {schema} CASCADE')})")


def mysql(home):
    environment = os.environ
    suffix = uuid.uuid4().hex[:8]
    database_name = environment.get("DUCKPAD_MYSQL_DATABASE", "duckpad")
    tables = (database_name, f"orders_{suffix}", f"order_totals_{suffix}")
    base = {
        "host": environment.get("DUCKPAD_MYSQL_HOST", "127.0.0.1"),
        "user": environment["DUCKPAD_MYSQL_USER"],
        "password": environment["DUCKPAD_MYSQL_PASSWORD"],
        "database": database_name,
    }
    # The same database on a dev and a prod server: a MySQL schema is a database.
    ports = {
        "dev": int(environment["DUCKPAD_MYSQL_DEV_PORT"]),
        "prod": int(environment["DUCKPAD_MYSQL_PROD_PORT"]),
    }
    environments = {name: {**base, "port": port, "options": ""} for name, port in ports.items()}
    attach = {}
    for name, port in ports.items():
        settings = ", ".join(
            f"{key} {literal(value)}"
            for key, value in (
                ("HOST", base["host"]),
                ("PORT", port),
                ("DATABASE", database_name),
                ("USER", base["user"]),
                ("PASSWORD", base["password"]),
            )
        )
        attach[name] = [
            f"CREATE SECRET fixture_secret (TYPE mysql, {settings})",
            "ATTACH '' AS fixture (TYPE mysql, SECRET fixture_secret)",
        ]
    for name in ports:
        seed(attach[name], *tables, 1 if name == "dev" else 10, create_schema=False)
    try:
        return database(home, "mysql", environments, tables, attach, modes=("embedded", "isolated"))
    finally:
        for statements in attach.values():
            with attached(statements) as db:
                for table in tables[1:]:
                    db.execute(f"DROP TABLE fixture.{qi(database_name)}.{qi(table)}")


def sqlite(home):
    files = {name: home / f"{name}.sqlite" for name in ("dev", "prod")}
    attach = {name: [f"ATTACH {literal(str(path))} AS fixture (TYPE sqlite)"] for name, path in files.items()}
    for name in files:
        seed(attach[name], "main", "orders", "order_totals", 1 if name == "dev" else 10, create_schema=False)
    environments = {name: {"path": str(path)} for name, path in files.items()}
    # The isolated worker opens connection roots and project files, not database files elsewhere.
    return database(
        home, "sqlite", environments, ("main", "orders", "order_totals"), attach, modes=("embedded",)
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("connector", choices=["oracle", "s3", "postgres", "mysql", "sqlite"])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="duckpad-integration-") as directory:
        result = {"connector": args.connector, **globals()[args.connector](Path(directory))}
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(dumps(result))
        print(json.dumps(result, indent=2))
