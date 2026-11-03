"""Small serialization and SQL helpers shared by the services."""

from __future__ import annotations

import hashlib
import json
import math
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any


class Problem(Exception):
    """An expected failure reported to API clients with an HTTP status and optional detail."""

    def __init__(self, message: str, status: int = 400, detail: Any = None) -> None:
        super().__init__(message)
        self.status, self.detail = status, detail


def uid(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:16]


def now() -> str:
    return datetime.now(UTC).isoformat()


def json_default(value: object) -> str:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bytes):
        return value.hex()
    return str(value)


def dumps(value: object) -> str:
    return json.dumps(value, default=json_default, ensure_ascii=False, sort_keys=True, indent=2) + "\n"


def clean(value: Any) -> Any:
    """Convert a value to JSON-compatible data, keeping non-finite floats readable."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [clean(x) for x in value]
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    return json.loads(json.dumps(value, default=json_default))


def digest(value: object) -> str:
    return hashlib.sha256(dumps(value).encode()).hexdigest()


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def qi(value: object) -> str:
    """Quote a SQL identifier."""
    return '"' + str(value).replace('"', '""') + '"'


def literal(value: object) -> str:
    """Render a Python scalar as a SQL literal."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float, Decimal)):
        if isinstance(value, float) and not math.isfinite(value):
            raise Problem("Non-finite SQL parameter")
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def inside(root: Path, relative: str) -> Path:
    """Resolve a relative path, refusing any path that escapes the root."""
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise Problem("Path must stay inside the project")
    return path
