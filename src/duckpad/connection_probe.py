"""Connection setup in a disposable process.

Setup loads native extensions and reaches remote systems. Running it in a child reports an
extension that stops its process, a wrong password or an unreachable host as an error,
instead of stopping the Duckpad server, whatever the execution mode.
"""

import json
import signal
import subprocess
import sys
import threading
from pathlib import Path

import duckdb

from .catalog import redact, setup_connections
from .project_extensions import EXPLICIT_LOADING
from .templates import URI
from .types import Connections, Record, SQLCursor
from .util import Problem

TIMEOUT = 30
# Database objects listed for the inspector; larger databases list their first ones.
MAX_TABLES = 5000
# Catalog schemas that hold no user data: DuckDB's, and PostgreSQL's reserved `pg_` schemas
# (pg_catalog, pg_toast, pg_temp_3...), which users cannot create.
SYSTEM_SCHEMAS = "schema_name = 'information_schema' OR schema_name LIKE 'pg\\_%' ESCAPE '\\'"
COMMAND = [sys.executable, "-m", "duckpad.connection_probe"]

# Extensions this server process has seen load in a child: loading them here cannot crash it.
_verified: set[str] = set()
_verified_lock = threading.Lock()


def run(
    config: Record, captured: Connections, offline: Record, secrets: list[str], *, setup: bool = True
) -> Record:
    """Prepare one captured connection in a child process, or only load its extensions.

    After setup, a database connection lists its schemas and tables, and a storage connection
    checks that a folder root exists. Errors never contain the connection's secrets.
    """
    payload = {"config": config, "captured": captured, "offline": offline, "setup": setup}
    try:
        result = subprocess.run(
            COMMAND,
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise Problem(
            f"The connection did not respond within {TIMEOUT} seconds. Check the host, the port and "
            "network access from the Duckpad server.",
            422,
        ) from None
    if result.returncode < 0:
        try:
            name = signal.Signals(-result.returncode).name
        except ValueError:
            name = f"signal {-result.returncode}"
        raise Problem(
            f"Connection setup stopped its process ({name}). An extension it loads may not run on this "
            "server's processor or DuckDB build: ask an instance administrator for a compatible build.",
            422,
        )
    if result.returncode:
        message = result.stderr.strip() or f"Connection setup exited with code {result.returncode}."
        message = message.replace(config["extension_directory"], "<extensions>")
        raise Problem(redact(message, secrets), 422)
    with _verified_lock:
        _verified.update(key(connection, offline) for connection in captured.values())
    return json.loads(result.stdout)


def key(connection: Record, offline: Record) -> str:
    """The extension binaries a connection loads: its declarations and the imports replacing them."""
    extensions = connection["definition"].get("extensions", [])
    imports = {e["name"]: offline[e["name"]] for e in extensions if e.get("name") in offline}
    return json.dumps([extensions, imports], sort_keys=True)


def check_extensions(config: Record, connection: Record, offline: Record, secrets: list[str]) -> None:
    """Load a connection's extensions in a child before this process relies on them, once per process.

    The child installs missing ones into the instance cache from their declared repository, and its
    failure, crash included, is raised here.
    """
    if not connection["definition"].get("extensions"):
        return
    with _verified_lock:
        if key(connection, offline) in _verified:
            return
    run(config, {"extensions": connection}, offline, secrets, setup=False)


def objects(db: SQLCursor, alias: str) -> Record:
    """The schemas and tables of an attached database, without system schemas."""
    schemas = db.execute(
        "SELECT DISTINCT schema_name FROM information_schema.schemata "
        f"WHERE catalog_name = ? AND NOT ({SYSTEM_SCHEMAS}) ORDER BY schema_name",
        [alias],
    ).fetchall()
    tables = db.execute(
        "SELECT table_schema, table_name, table_type = 'VIEW' FROM information_schema.tables "
        f"WHERE table_catalog = ? AND NOT ({SYSTEM_SCHEMAS.replace('schema_name', 'table_schema')}) "
        f"ORDER BY table_schema, table_name LIMIT {MAX_TABLES + 1}",
        [alias],
    ).fetchall()
    return {
        "schemas": [row[0] for row in schemas],
        "tables": [
            {"schema": schema, "name": name, "view": view} for schema, name, view in tables[:MAX_TABLES]
        ],
        "truncated": len(tables) > MAX_TABLES,
    }


def attached(db: SQLCursor, alias: str) -> bool:
    row = db.execute("SELECT count(*) FROM duckdb_databases() WHERE database_name = ?", [alias]).fetchone()
    return bool(row and row[0])


def main() -> None:
    payload = json.load(sys.stdin)
    (connection,) = payload["captured"].values()
    if not payload["setup"]:
        connection["definition"]["init_sql"] = ""
    with duckdb.connect(config={**payload["config"], "threads": 1, **EXPLICIT_LOADING}) as db:
        setup_connections(db, payload["captured"], payload["offline"])
        if not payload["setup"]:
            result: Record = {}
        elif connection["definition"].get("family") == "database":
            if not attached(db, connection["alias"]):
                raise Problem("The connector setup does not attach a database as {{ alias }}.")
            result = objects(db, connection["alias"])
        else:
            root = connection["values"].get("root")
            if isinstance(root, str) and root and not URI.match(root) and not Path(root).is_dir():
                raise Problem(f"The root folder does not exist on the Duckpad server: {root}")
            result = {"root": root}
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
