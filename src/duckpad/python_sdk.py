"""Small Python authoring API. This module requires only DuckDB and the standard library."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import ClassVar, Literal, get_args, get_origin, get_type_hints

from duckdb import DuckDBPyRelation as Relation

SDK_CONTRACT = 1

__all__ = [
    "SDK_CONTRACT",
    "Column",
    "Connection",
    "Date",
    "Destination",
    "File",
    "Node",
    "Outputs",
    "Relation",
    "SchemaName",
    "TableName",
    "param",
]


class Column(str):
    """A column name bound to a tabular input."""


class Connection(str):
    """An authorized connection identifier."""


class File(str):
    """An authorized input file."""


class Destination(str):
    """An authorized output file."""


class SchemaName(str):
    """A database schema name."""


class TableName(str):
    """A database table name."""


Date = date
_MISSING = object()


@dataclass
class Parameter:
    default: object = _MISSING
    metadata: dict = field(default_factory=dict)


def param(*, default=_MISSING, **metadata):
    """Describe a UI parameter without executing application code during discovery."""
    return Parameter(default, metadata)


def validate_value(name, annotation, value, metadata):
    choices = get_args(annotation) if get_origin(annotation) is Literal else metadata.get("choices")
    if choices is not None:
        valid = value in choices and all(type(value) is type(x) for x in choices)
    elif annotation is bool:
        valid = type(value) is bool
    elif annotation is int:
        valid = type(value) is int
    elif annotation is float:
        valid = type(value) in (int, float) and math.isfinite(value)
    elif annotation is date:
        try:
            value = date.fromisoformat(value) if isinstance(value, str) else value
            valid = type(value) is date
        except ValueError:
            valid = False
    else:
        valid = isinstance(annotation, type) and issubclass(annotation, str) and isinstance(value, str)
    if not valid:
        raise ValueError(f"Invalid value for parameter {name}")
    for bound, comparison in (
        ("ge", lambda a, b: a >= b),
        ("gt", lambda a, b: a > b),
        ("le", lambda a, b: a <= b),
        ("lt", lambda a, b: a < b),
    ):
        if bound in metadata and not comparison(value, metadata[bound]):
            raise ValueError(f"Parameter {name} must satisfy {bound}={metadata[bound]}")
    return float(value) if annotation is float else value


class Outputs:
    """Fixed named tables, declared as annotated attributes."""

    def __init__(self, **values):
        names = get_type_hints(type(self))
        if set(values) != set(names):
            raise ValueError(f"Expected output names {sorted(names)}, received {sorted(values)}")
        self.__dict__.update(values)


class Node:
    """Fresh configuration per execution; override run and optionally write."""

    def __init__(self, **values):
        annotations = get_type_hints(type(self))
        parameters = {k: v for k, v in annotations.items() if get_origin(v) is not ClassVar}
        unknown = values.keys() - parameters.keys()
        if unknown:
            raise ValueError(f"Unknown parameters: {', '.join(sorted(unknown))}")
        for name, annotation in parameters.items():
            declaration = getattr(type(self), name, _MISSING)
            metadata = declaration.metadata if isinstance(declaration, Parameter) else {}
            default = declaration.default if isinstance(declaration, Parameter) else declaration
            value = values.get(name, default)
            if value is _MISSING:
                raise ValueError(f"Missing parameter: {name}")
            setattr(self, name, validate_value(name, annotation, value, metadata))
        self.partition = None
        self._messages = []
        self._checks = []
        self._artifacts = {}
        self._workspace = None
        self._connections = {}
        self._db = None

    @property
    def db(self):
        """The execution connection, also used by all tabular inputs and outputs."""
        if self._db is None:
            import duckdb

            self._db = duckdb.connect()
        return self._db

    def message(self, level, text):
        if level not in ("info", "warning", "error"):
            raise ValueError("Message level must be info, warning or error")
        self._messages.append({"level": level, "message": str(text)})

    def check(self, name, failing_rows, *, severity="error"):
        """Declare a relation of failing rows, evaluated before write and publication."""
        if not isinstance(failing_rows, Relation) or severity not in ("warning", "error"):
            raise ValueError("A check requires a DuckDB relation and warning or error severity")
        self._checks.append((name, failing_rows, severity))

    def artifact(self, name):
        """A staged downloadable file; it becomes visible only after successful execution."""
        if self._workspace is None:
            raise RuntimeError("Managed artifacts require a Duckpad execution")
        if not name or Path(name).name != name or name in (".", "..") or "/" in name or "\\" in name:
            raise ValueError("An artifact name must be a file name without a directory")
        path = Path(self._workspace) / name
        self._artifacts[name] = str(path)
        return path

    def connection(self, reference):
        """Authorized connection settings, including secrets when Python is enabled."""
        if reference not in self._connections:
            raise PermissionError("Choose an authorized connection parameter before accessing its settings")
        return dict(self._connections[reference])

    def write(self):
        """Optional side effects after run and checks; arbitrary remote writes are not transactional."""
