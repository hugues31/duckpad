"""Declarative connector definitions and environment-specific connections."""

from __future__ import annotations

import copy
import re

import duckdb

from . import secret_references
from .builtin_connectors import BUILTIN_CONNECTORS
from .secret_references import is_reference
from .templates import IDENTIFIER, REFERENCE
from .types import Connections, Record
from .util import Problem, digest, qi
from .worker_connections import database_files, setup_connections

MASK = "••••"
KINDS = ("connector", "connection")
RESERVED_PARAMETERS = {"alias", "secret_name"}
PARAMETER_TYPES = ("text", "number", "boolean", "file")
# Optional parameter fields the connection form displays instead of the name.
DESCRIPTIVE_FIELDS = ("label", "description")
# Databases are attached and read as tables; file storage is a location for file nodes, below its root.
FAMILIES = ("database", "storage")
# Catalog identifiers.
NAME = re.compile(r"[A-Za-z][\w-]*")


def secret_names(definition):
    """Names of a connector's parameters that must never be displayed or recorded."""
    return {p["name"] for p in definition.get("parameters", []) if p.get("secret")}


def executable(definition):
    """A definition without the documentation that never changes what its setup does."""
    result = {k: v for k, v in definition.items() if k not in ("name", "description", "compatibility")}
    result["parameters"] = [
        {k: v for k, v in parameter.items() if k not in DESCRIPTIVE_FIELDS}
        for parameter in definition.get("parameters", [])
    ]
    return result


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
                    # A reference names where the secret is, not the secret.
                    if values.get(name) and not is_reference(values[name]):
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
        with self.store.transaction():
            if kind == "connector" and data == BUILTIN_CONNECTORS.get(data["id"]):
                # Saving a built-in unchanged keeps it following the release.
                self.store.delete("connector", data["id"])
            else:
                self.store.put(kind, data["id"], data)
            sealed = kind == "connector" and self.track_secret_fields(data["id"])
        if sealed:
            self.store.compact()
        self.on_change()

    def reset(self, identity, *, before_change=None):
        """Delete the override of a customized built-in, which then matches the running release."""
        if identity not in BUILTIN_CONNECTORS:
            raise Problem("Only built-in connectors can be reset", 404)
        if self.store.get("connector", identity) is None:
            return
        if before_change is not None:
            before_change()
        with self.store.transaction():
            self.store.delete("connector", identity)
            sealed = self.track_secret_fields(identity)
        if sealed:
            self.store.compact()
        self.on_change()

    def track_secret_fields(self, connector=None):
        """Record parameters a definition made secret on its connections, so the store seals them.

        A parameter stays sealed after its definition stops marking it secret. Returns whether
        a connection changed; `Store.compact` then drops the pages that held the plain values.
        """
        changed = False
        for connection in self.store.all("connection"):
            if connector is not None and connection["connector"] != connector:
                continue
            fields = sorted(
                set(connection["secret_fields"]) | secret_names(self.connector(connection["connector"]) or {})
            )
            if fields != connection["secret_fields"]:
                self.store.put("connection", connection["id"], {**connection, "secret_fields": fields})
                changed = True
        return changed

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
                for key, value in values.items():
                    if is_reference(value):
                        if key not in secret_names(definition):
                            raise Problem(f"Only secret parameters can name a server secret, not {key}")
                        secret_references.validate(value)
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
            if any(not isinstance(parameter.get(key, ""), str) for key in DESCRIPTIVE_FIELDS):
                raise Problem("Connector parameter labels and descriptions must be text")
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

    def capture(
        self, references: list[str], environment: str, *, resolve: bool = True
    ) -> tuple[Connections, list[str]]:
        """Without `resolve`, server secrets stay references: enough for fingerprints, never for a worker."""
        captured, secrets = {}, []
        for reference in set(references):
            connection = self.store.get("connection", reference)
            if not connection:
                raise Problem(f"Missing connection: {reference}")
            captured[reference], hidden = self.capture_connection(
                reference, connection, environment, resolve=resolve
            )
            secrets += hidden
        return captured, secrets

    def capture_draft(self, data: Record, environment: str) -> tuple[Connections, list[str]]:
        """Capture a connection as edited in its form, saved or not, like a run would in one environment.

        Masked secrets keep the stored values of the connection being edited.
        """
        data = copy.deepcopy(data)
        data["id"] = data.get("id") or "unsaved"
        data = self.check("connection", data, create=self.store.get("connection", data["id"]) is None)
        if environment not in self.environment_names():
            raise Problem("Unknown environment", 404)
        captured, secrets = self.capture_connection(data["id"], data, environment)
        return {data["id"]: captured}, secrets

    def capture_connection(
        self, reference: str, connection: Record, environment: str, *, resolve: bool = True
    ) -> tuple[Record, list[str]]:
        """The definition, values and runtime names of one connection in an environment, with its secrets."""
        secrets = []
        definition = self.connector(connection["connector"])
        if not definition:
            raise Problem(f"Missing connector definition: {connection['connector']}")
        self.validate_definition(definition)
        if environment not in connection["environments"]:
            raise Problem(f"Connection {reference} has no configuration for {environment}")
        values = copy.deepcopy(connection["environments"][environment])
        hidden = secret_names(definition)
        for name, value in values.items():
            if not is_reference(value):
                continue
            if name not in hidden:
                raise Problem(f"Connection {reference}: {name} is no longer secret; enter its value")
            if resolve:
                try:
                    values[name] = secret_references.resolve(value)
                except Problem as error:
                    raise Problem(f"Connection {reference}: {error} ({environment})") from None
        for p in definition.get("parameters", []):
            name = p["name"]
            if name not in values:
                if "default" not in p:
                    raise Problem(f"Connection {reference} requires {name} in {environment}")
                values[name] = p["default"]
            if is_reference(values[name]):
                continue
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
        # The probe and worker must attach the same file, including relative paths,
        # home expansion and symlinks. The sandbox grants its resolved parent.
        for name, path in database_files(definition, values).items():
            resolved = str(path)
            if name in hidden and resolved != values[name]:
                secrets.append(resolved)
            values[name] = resolved
        public_values = {k: v for k, v in values.items() if k not in hidden}
        captured = {
            "definition": definition,
            "values": values,
            "settings": public_values,
            "name": connection["name"],
            # Secret parameters authenticate; the settings that select data are not secret. Rotating
            # a credential therefore never makes results stale.
            "fingerprint": digest([executable(definition), public_values]),
            "alias": "conn_" + digest(reference)[:12],
            "secret_name": "secret_" + digest(reference)[:12],
        }
        return captured, secrets

    def prepare(self, db, captured, offline=None):
        if offline is None:
            offline = self.store.get("settings", "offline_extensions", {}) if self else {}
        if hasattr(db, "setup"):
            db.setup(captured, offline)
        else:
            setup_connections(db, captured, offline)
