"""Connection setup used by the lightweight worker; no server dependencies."""

import re
from pathlib import Path

import duckdb

from .util import Problem, literal, qi

REFERENCE = re.compile(r"\{\{\s*(.*?)\s*\}\}")
URI = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")
RESERVED_PARAMETERS = {"alias", "secret_name"}


def database_files(definition, values):
    """Local database files declared by an administrator, excluding URIs and memory databases."""
    if definition.get("family") != "database":
        return {}
    return {
        p["name"]: Path(value).expanduser().resolve()
        for p in definition.get("parameters", [])
        if p.get("type") == "file"
        and isinstance(value := values.get(p["name"]), str)
        and value
        and value != ":memory:"
        and not URI.match(value)
    }


def setup_connections(db, captured, offline):
    """Load each captured connection's extensions, then run its setup SQL, in a DuckDB session.

    Extensions imported for offline use load from their import, never from the network.
    """
    for connection in captured.values():
        definition = connection["definition"]
        for ext in definition.get("extensions", []):
            name = ext["name"]
            if name in offline:
                # Imported files never fall back to a network install when loading fails.
                db.execute(f"LOAD {qi(name)} FROM {qi(offline[name]['repository'])}")
                continue
            try:
                db.execute(f"LOAD {qi(name)}")
            except duckdb.Error:
                repository = ext.get("repository")
                suffix = (
                    (" FROM community" if repository == "community" else f" FROM {literal(repository)}")
                    if repository
                    else ""
                )
                db.execute(f"INSTALL {qi(name)}{suffix}")
                db.execute(f"LOAD {qi(name)}")
        aliases = {r[1] for r in db.execute("PRAGMA database_list").fetchall()}
        if connection["alias"] in aliases:
            db.execute(f"DETACH {qi(connection['alias'])}")
        values = connection["values"]
        types = {p["name"]: p["type"] for p in definition.get("parameters", [])}

        def replace(match, connection=connection, values=values, types=types):
            key = match[1].strip()
            if key in RESERVED_PARAMETERS:
                return qi(connection[key])
            if key not in values:
                raise Problem(f"Undeclared connector parameter: {key}")
            value = values[key]
            if types.get(key) == "number":
                # Drivers such as libpq refuse `5432.0` as a port.
                value = float(value)
                value = int(value) if value.is_integer() else value
            if types.get(key) == "boolean" and not isinstance(value, bool):
                raise Problem(f"{key} requires a boolean")
            return literal(value)

        sql = REFERENCE.sub(replace, definition.get("init_sql", ""))
        if sql.strip():
            try:
                db.execute(sql)
            except duckdb.Error as error:
                if not database_files(definition, values):
                    raise
                raise Problem(
                    f"Cannot initialize connection {connection['name']}: {error}. "
                    "Check its database file settings for this environment and the Duckpad server's "
                    "filesystem permissions. Use an existing dedicated directory outside the instance; "
                    "writing requires the connector's write capability and permission to create journal files "
                    "in that directory. Read-only connectors must attach the database read-only.",
                    422,
                ) from error
