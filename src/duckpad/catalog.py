"""Declarative connector definitions and environment-specific connections."""

from __future__ import annotations

import copy
import re

import duckdb

from .builtin_connectors import BUILTIN_CONNECTORS
from .templates import IDENTIFIER, REFERENCE
from .types import Connections, Record
from .util import Problem, digest, literal, qi

MASK = "••••"
KINDS = ("connector", "connection")
RESERVED_PARAMETERS = {"alias", "secret_name"}
PARAMETER_TYPES = ("text", "number", "boolean", "file")
# Databases are attached and read as tables; file storage is a location for file nodes, below its root.
FAMILIES = ("database", "storage")
# Catalog identifiers.
NAME = re.compile(r"[A-Za-z][\w-]*")


def secret_names(definition):
    """Names of a connector's parameters that must never be displayed or recorded."""
    return {p["name"] for p in definition.get("parameters", []) if p.get("secret")}


def redact(text: str, secrets: list[str]) -> str:
    """Mask secret values, including their SQL-escaped form, in displayed text."""
    for value in sorted((str(v) for v in secrets if v is not None and str(v)), key=len, reverse=True):
        text = text.replace(value, MASK).replace(value.replace("'", "''"), MASK)
    return text


class Catalog:
    def __init__(self, store):
        self.store = store
        self._validated = set()
        self.on_change = lambda: None

    def connector(self, identity):
        """The definition in effect: an administrator's version, else the built-in one, else None."""
        stored = self.store.get("connector", identity)
        if stored is None and identity in BUILTIN_CONNECTORS:
            return copy.deepcopy(BUILTIN_CONNECTORS[identity])
        return stored

    def connectors(self):
        """Built-in definitions, customized ones replaced by their override, then custom types.

        `origin` tells them apart: built-in, customized or custom.
        """
        stored = {connector["id"]: connector for connector in self.store.all("connector")}
        listed = []
        for identity, builtin in BUILTIN_CONNECTORS.items():
            override = stored.pop(identity, None)
            listed.append(
                {**override, "origin": "customized"}
                if override is not None
                else {**copy.deepcopy(builtin), "origin": "built-in"}
            )
        return listed + [{**connector, "origin": "custom"} for connector in stored.values()]

    def public(self):
        connections = copy.deepcopy(self.store.all("connection"))
        for connection in connections:
            definition = self.connector(connection["connector"]) or {}
            hidden = set(connection.pop("secret_fields")) | secret_names(definition)
            for values in connection["environments"].values():
                for name in hidden:
                    if values.get(name):
                        values[name] = MASK
        return {
            "connectors": self.connectors(),
            "connections": connections,
            "environments": self.environment_names(),
            "environment_details": self.environments(),
            "duckdb_version": duckdb.__version__,
        }

    def environments(self):
        return self.store.all("environment")

    def environment_names(self):
        return [item["id"] for item in self.environments()]

    def environment(self, identity):
        environment = self.store.get("environment", identity)
        if environment is None:
            raise Problem("Unknown environment", 404)
        return environment

    def save_environment(self, data, *, create=False):
        with self.store.transaction():
            identity = data["id"]
            if create and self.store.get("environment", identity) is not None:
                raise Problem("An environment with this identifier already exists", 409)
            if not create:
                self.environment(identity)
            self.store.put("environment", identity, data)
            if create:
                for connection in self.store.all("connection"):
                    connection["environments"][identity] = {}
                    self.store.put("connection", connection["id"], connection)

    def validate_environment_deletion(self, identity):
        self.environment(identity)
        if len(self.environments()) == 1:
            raise Problem("Keep at least one environment", 409)

    def delete_environment(self, identity):
        with self.store.transaction():
            self.validate_environment_deletion(identity)
            self.store.delete("environment", identity)

    def save(self, kind, data, *, create=False, before_change=None):
        """Validate and prepare the edit before resetting execution state or writing."""
        self.check(kind, data, create=create)
        if before_change is not None:
            before_change()
        if kind == "connector" and data == BUILTIN_CONNECTORS.get(data["id"]):
            # Saving a built-in unchanged keeps it following the release.
            self.store.delete("connector", data["id"])
        else:
            self.store.put(kind, data["id"], data)
        self.on_change()

    def reset(self, identity, *, before_change=None):
        """Delete the override of a customized built-in, which then matches the running release."""
        if identity not in BUILTIN_CONNECTORS:
            raise Problem("Only built-in connectors can be reset", 404)
        if self.store.get("connector", identity) is None:
            return
        if before_change is not None:
            before_change()
        self.store.delete("connector", identity)
        self.on_change()

    def check(self, kind, data: Record, *, create=False):
        """Validate a connector or connection and complete it for storage, without writing it."""
        if kind not in KINDS:
            raise Problem("Unknown catalog entity", 404)
        if not NAME.fullmatch(str(data.get("id", ""))):
            raise Problem(
                "Use an identifier starting with a letter and containing letters, numbers, hyphens or underscores"
            )
        if kind == "connection":
            previous: Record | None = self.store.get("connection", data["id"])
            if create and previous is not None:
                raise Problem(
                    "A connection with this identifier already exists", 409, {"code": "connection_exists"}
                )
            if not create and previous is None:
                raise Problem("Connection does not exist", 404, {"code": "connection_missing"})
            previous = previous or {"environments": {}, "secret_fields": []}
            definition = self.connector(str(data.get("connector", "")))
            if not definition:
                raise Problem("Connector definition does not exist")
            if not isinstance(data.get("environments"), dict):
                raise Problem("A connection needs settings for each environment")
            if set(data["environments"]) - set(self.environment_names()):
                raise Problem("Choose existing environments")
            if previous.get("connector") != data["connector"]:
                names = {parameter["name"] for parameter in definition.get("parameters", [])}
                data["environments"] = {
                    env: {key: value for key, value in values.items() if key in names}
                    for env, values in data["environments"].items()
                }
            data["secret_fields"] = sorted(set(previous["secret_fields"]) | secret_names(definition))
            for env, values in data["environments"].items():
                for key in secret_names(definition):
                    if values.get(key) == MASK:
                        values[key] = previous["environments"].get(env, {}).get(key, "")
        else:
            # Listings add the origin; it is not part of the definition.
            data.pop("origin", None)
            if create and self.connector(data["id"]) is not None:
                raise Problem(
                    "A connector with this identifier already exists", 409, {"code": "connector_exists"}
                )
            self.validate_definition(data)
        return data

    def delete(self, kind, identity, *, before_change=None):
        if kind not in KINDS:
            raise Problem("Unknown catalog entity", 404)
        if kind == "connector" and identity in BUILTIN_CONNECTORS:
            raise Problem("Built-in connectors cannot be deleted; reset a customized one instead", 409)
        if kind == "connector" and any(c["connector"] == identity for c in self.store.all("connection")):
            raise Problem("Remove this connector's connections before deleting it", 409)
        if before_change is not None:
            before_change()
        self.store.delete(kind, identity)
        self.on_change()

    def validate_definition(self, definition):
        fingerprint = digest(definition)
        if fingerprint in self._validated:
            return
        if definition.get("family") not in FAMILIES:
            raise Problem("Connector family must be database or storage")
        parameters = definition.get("parameters", [])
        names = [parameter.get("name", "") for parameter in parameters]
        if len(names) != len(set(names)):
            raise Problem("Connector parameter names must be unique")
        if definition["family"] == "storage" and not any(
            parameter.get("name") == "root" and parameter.get("type", "text") in ("text", "file")
            for parameter in parameters
        ):
            raise Problem("Storage connectors must declare a text root parameter: a folder or a URI prefix")
        for parameter in parameters:
            name, kind = parameter.get("name", ""), parameter.get("type", "text")
            if name in RESERVED_PARAMETERS or not IDENTIFIER.fullmatch(name):
                raise Problem("Connector parameters must be identifiers other than alias and secret_name")
            if kind not in PARAMETER_TYPES and not re.fullmatch(r"choice\([^()]+\)", kind):
                raise Problem(f"Unsupported connector parameter type: {kind}")
        if not set(definition.get("capabilities", [])) <= {"read", "write"}:
            raise Problem("Connector capabilities must be read and/or write")
        for extension in definition.get("extensions", []):
            if not IDENTIFIER.fullmatch(extension.get("name", "")):
                raise Problem("Invalid extension name")
        sql = re.sub(r"--[^\n]*|/\*.*?\*/", "", definition.get("init_sql", ""), flags=re.DOTALL)
        declared = set(names) | RESERVED_PARAMETERS
        for key in REFERENCE.findall(sql):
            if key not in declared:
                raise Problem(f"Undeclared connector parameter: {key}")
        sample = REFERENCE.sub(lambda m: qi(m[1]) if m[1] in RESERVED_PARAMETERS else "'value'", sql)
        try:
            with duckdb.connect() as db:
                statements = db.extract_statements(sample)
            for statement in statements:
                query = statement.query.strip().rstrip(";").strip()
                if statement.type == duckdb.StatementType.ATTACH:
                    if not re.search(r'\bAS\s+"alias"(?:\s*\(|$)', query, re.IGNORECASE):
                        raise Problem("ATTACH must use the assigned {{ alias }}")
                elif statement.type == duckdb.StatementType.CREATE:
                    if not re.match(
                        r'^CREATE\s+OR\s+REPLACE\s+TEMPORARY\s+SECRET\s+"secret_name"\s*\(',
                        query,
                        re.IGNORECASE,
                    ):
                        raise Problem("Connection setup may only create an assigned temporary secret")
                elif statement.type == duckdb.StatementType.LOAD:
                    name = query.split(None, 1)[1].strip("\"'")
                    if name not in {ext["name"] for ext in definition.get("extensions", [])}:
                        raise Problem("LOAD must refer to a declared extension")
                else:
                    raise Problem(
                        "Initialization is reserved for LOAD, temporary secrets and ATTACH; put data operations in source or export nodes"
                    )
        except duckdb.Error as error:
            raise Problem(f"Invalid connector initialization SQL: {error}") from error
        self._validated.add(fingerprint)

    def capture(self, references: list[str], environment: str) -> tuple[Connections, list[str]]:
        captured, secrets = {}, []
        for reference in set(references):
            connection = self.store.get("connection", reference)
            if not connection:
                raise Problem(f"Missing connection: {reference}")
            definition = self.connector(connection["connector"])
            if not definition:
                raise Problem(f"Missing connector definition: {connection['connector']}")
            self.validate_definition(definition)
            if environment not in connection["environments"]:
                raise Problem(f"Connection {reference} has no configuration for {environment}")
            values = copy.deepcopy(connection["environments"][environment])
            for p in definition.get("parameters", []):
                name = p["name"]
                if name not in values:
                    if "default" not in p:
                        raise Problem(f"Connection {reference} requires {name} in {environment}")
                    values[name] = p["default"]
                if p.get("secret"):
                    secrets.append(values[name])
                kind = p.get("type", "text")
                if kind == "number" and (
                    isinstance(values[name], bool) or not isinstance(values[name], (int, float))
                ):
                    raise Problem(f"Connection {reference}: {name} requires a number")
                if kind == "boolean" and not isinstance(values[name], bool):
                    raise Problem(f"Connection {reference}: {name} requires a boolean")
                if kind.startswith("choice(") and values[name] not in kind.removeprefix("choice(")[:-1].split(
                    "|"
                ):
                    raise Problem(f"Connection {reference}: invalid choice for {name}")
            hidden = secret_names(definition)
            public_values = {k: v for k, v in values.items() if k not in hidden}
            captured[reference] = {
                "definition": definition,
                "values": values,
                "settings": public_values,
                "name": connection["name"],
                "fingerprint": digest(
                    [
                        {
                            k: v
                            for k, v in definition.items()
                            if k not in ("name", "description", "compatibility")
                        },
                        values,
                    ]
                ),
                "alias": "conn_" + digest(reference)[:12],
                "secret_name": "secret_" + digest(reference)[:12],
            }
        return captured, secrets

    def prepare(self, db, captured, offline=None):
        if offline is None:
            offline = self.store.get("settings", "offline_extensions", {}) if self else {}
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
                    value = float(value)
                if types.get(key) == "boolean" and not isinstance(value, bool):
                    raise Problem(f"{key} requires a boolean")
                return literal(value)

            sql = REFERENCE.sub(replace, definition.get("init_sql", ""))
            if sql.strip():
                db.execute(sql)
