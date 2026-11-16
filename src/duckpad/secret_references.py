"""Secret connection parameters read by the server from its environment or a secrets directory.

Instead of a value, a secret parameter can hold `{"from": "env", "name": "DUCKPAD_SECRET_..."}`
or `{"from": "file", "name": "<file>"}`. A reference names where the secret is, so it is
stored and displayed as is. The server resolves it on every capture, so a rotated file
applies at the next run; workers only receive the value, and fingerprints never resolve it.
Without the prefix and directory limits, an instance administrator could read any variable
or file of the server and send it to a host they control.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from .sealing import KEY_FILE_VARIABLE
from .util import Problem

ENVIRONMENT_PREFIX = "DUCKPAD_SECRET_"
DIRECTORY_VARIABLE = "DUCKPAD_SECRETS_DIR"
DEFAULT_DIRECTORY = "/run/secrets"
MAX_SIZE = 64 * 1024
VARIABLE = re.compile(ENVIRONMENT_PREFIX + r"[A-Z0-9_]+")
# Directly in the secrets directory: Kubernetes keeps its service account token in a subdirectory.
FILE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]*")


def is_reference(value: Any) -> bool:
    return isinstance(value, dict)


def validate(value: Any) -> None:
    if (
        not isinstance(value, dict)
        or value.keys() != {"from", "name"}
        or value["from"] not in ("env", "file")
        or not isinstance(value["name"], str)
    ):
        raise Problem('A secret reference is {"from": "env" or "file", "name": "..."}')
    if value["from"] == "env" and not VARIABLE.fullmatch(value["name"]):
        raise Problem(
            f"Name an environment variable starting with {ENVIRONMENT_PREFIX}, "
            "in upper case letters, digits and underscores"
        )
    if value["from"] == "file" and not FILE.fullmatch(value["name"]):
        raise Problem(f"Name a file directly in {DIRECTORY_VARIABLE}, without a slash")


def resolve(value: Any) -> str:
    """The secret a reference names; a Problem when the server does not provide it."""
    validate(value)
    name = value["name"]
    if value["from"] == "env":
        if name not in os.environ:
            raise Problem(f"{name} is not set on the server")
        return os.environ[name]
    directory = Path(os.environ.get(DIRECTORY_VARIABLE) or DEFAULT_DIRECTORY)
    try:
        # Kubernetes volumes link each file to a sibling directory; the target must stay inside.
        path = (directory / name).resolve(strict=True)
        if not path.is_relative_to(directory.resolve(strict=True)) or not path.is_file():
            raise FileNotFoundError
        # Docker mounts every secret of a service in /run/secrets, the master key included.
        if (key := os.environ.get(KEY_FILE_VARIABLE)) and path == Path(key).resolve():
            raise Problem(f"Secret file {name} is the master key, which connections cannot read")
        with path.open("rb") as handle:
            data = handle.read(MAX_SIZE + 1)
    except OSError:
        raise Problem(f"Secret file {name} is not in {DIRECTORY_VARIABLE} on the server") from None
    if len(data) > MAX_SIZE:
        raise Problem(f"Secret file {name} is larger than 64 KiB")
    try:
        return data.decode().rstrip("\r\n")
    except UnicodeDecodeError:
        raise Problem(f"Secret file {name} is not UTF-8 text") from None
