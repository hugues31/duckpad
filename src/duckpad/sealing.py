"""Secrets at rest: AES-256-GCM with master keys kept outside the instance database.

The store seals the fields `sealed_fields` lists when writing a record and opens them
when reading it, so services handle plaintext and no code path can forget to encrypt.
A sealed value names its key and is bound to its location: a copy pasted into
another field does not open.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .paths import InstancePaths
from .util import Problem

KEY_VARIABLE = "DUCKPAD_MASTER_KEY"
KEY_FILE_VARIABLE = "DUCKPAD_MASTER_KEY_FILE"
SEALED = re.compile(r"dpenc:1:([0-9a-f]{12}):([A-Za-z0-9_-]+)")
KEY_FILE_HEADER = (
    "# Duckpad master keys, one base64-encoded 32-byte key per line. The first one encrypts\n"
    "# the secrets of instance.sqlite; the next ones only decrypt values sealed before a rotation.\n"
)
# Read once per process, then removed from the environment so Git and SQL workers never inherit it.
_environment_keys: str | None = None


def key_source(home: Path) -> tuple[str, Path | None]:
    """Describe the configured source without reading, consuming or exposing its secret."""
    path = os.environ.get(KEY_FILE_VARIABLE)
    from_environment = KEY_VARIABLE in os.environ or _environment_keys is not None
    if path and from_environment:
        raise Problem(f"Set either {KEY_FILE_VARIABLE} or {KEY_VARIABLE}, not both")
    if path:
        return KEY_FILE_VARIABLE, Path(path).resolve()
    if from_environment:
        return KEY_VARIABLE, None
    return "instance", InstancePaths(home).master_key


def key_id(key: bytes) -> str:
    return hashlib.sha256(b"duckpad master key\0" + key).hexdigest()[:12]


def sealable(value: Any) -> bool:
    """Empty values and references to server secrets hide nothing."""
    return value not in (None, "") and not isinstance(value, dict)


def sealed_with(value: Any) -> str | None:
    """The identifier of the key that sealed a stored value, or None for a plain value."""
    match = SEALED.fullmatch(value) if isinstance(value, str) else None
    return match[1] if match else None


def sealed_fields(kind: str, key: str, record: Any) -> Iterator[tuple[dict, str, str]]:
    """Each secret of a stored record, as (container, field, location)."""
    if kind == "connection":
        for environment, parameters in record["environments"].items():
            for name in record["secret_fields"]:
                if name in parameters:
                    yield parameters, name, f"connection/{key}/{environment}/{name}"
    elif kind == "settings" and key == "oidc" and "client_secret" in record:
        yield record, "client_secret", "settings/oidc/client_secret"
    elif kind == "settings" and key == "assistant":
        for provider in record.get("providers", []):
            for field in ("api_key", "client_secret"):
                if field in provider:
                    yield provider, field, f"settings/assistant/{provider['id']}/{field}"
    elif kind == "ssh_key":
        yield record, "private_key", f"ssh_key/{key}/private_key"


def parse_keys(text: str, source: str) -> list[bytes]:
    keys = []
    lines = (line for line in text.splitlines() if not line.lstrip().startswith("#"))
    for item in (item.strip() for line in lines for item in line.split(",")):
        if not item:
            continue
        try:
            key = base64.b64decode(item.replace("-", "+").replace("_", "/"), validate=True)
        except binascii.Error:
            key = b""
        if len(key) != 32:
            raise Problem(
                f"{source} must contain base64-encoded 32-byte keys, one per line. "
                "Generate one with: openssl rand -base64 32"
            )
        keys.append(key)
    if not keys:
        raise Problem(f"{source} contains no master key")
    return keys


class MasterKeys:
    """The first key seals; the others only open values sealed before a rotation."""

    def __init__(self, keys: list[bytes], *, external: bool) -> None:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        self.ciphers = {key_id(key): AESGCM(key) for key in keys}
        self.primary = key_id(keys[0])
        # False when the key sits next to the database it protects, in the instance home.
        self.external = external

    @classmethod
    def load(cls, home: Path, sealed: set[str]) -> MasterKeys:
        """Keys from DUCKPAD_MASTER_KEY_FILE or DUCKPAD_MASTER_KEY, else the instance home.

        A key is generated in the home only while no value is sealed: losing the key file
        must not silently replace it.
        """
        global _environment_keys
        if KEY_VARIABLE in os.environ:
            _environment_keys = os.environ.pop(KEY_VARIABLE)
        source, path = key_source(home)
        if source == KEY_FILE_VARIABLE:
            assert path is not None
            try:
                text = path.read_text(encoding="utf-8")
            except OSError as error:
                raise Problem(f"Cannot read {KEY_FILE_VARIABLE}: {error.strerror}") from None
            keys = cls(parse_keys(text, KEY_FILE_VARIABLE), external=True)
        elif _environment_keys is not None:
            keys = cls(parse_keys(_environment_keys, KEY_VARIABLE), external=True)
        else:
            file = InstancePaths(home).master_key
            if not file.exists():
                if sealed:
                    raise Problem(
                        f"The secrets of this instance are encrypted with master key {min(sealed)}, "
                        f"but {file} is missing. Restore it, or provide the key with "
                        f"{KEY_FILE_VARIABLE} or {KEY_VARIABLE}."
                    )
                generate(file)
            keys = cls(parse_keys(file.read_text(encoding="utf-8"), str(file)), external=False)
        if unknown := sealed - keys.ciphers.keys():
            raise Problem(
                f"The secrets of this instance are encrypted with master key {min(unknown)}, which is "
                f"not among the keys provided. Provide it with {KEY_FILE_VARIABLE} or {KEY_VARIABLE}; "
                "after a rotation, keep the previous key on a later line until the next start."
            )
        return keys

    def seal(self, value: Any, location: str) -> Any:
        if not sealable(value):
            return value
        nonce = os.urandom(12)
        data = self.ciphers[self.primary].encrypt(nonce, json.dumps(value).encode(), location.encode())
        return f"dpenc:1:{self.primary}:{base64.urlsafe_b64encode(nonce + data).decode().rstrip('=')}"

    def open(self, value: Any, location: str) -> Any:
        from cryptography.exceptions import InvalidTag

        if not sealable(value):
            return value
        match = SEALED.fullmatch(value) if isinstance(value, str) else None
        if not match:
            raise Problem(f"The stored secret {location} is not encrypted", 500)
        try:
            data = base64.urlsafe_b64decode(match[2] + "=" * (-len(match[2]) % 4))
            plain = self.ciphers[match[1]].decrypt(data[:12], data[12:], location.encode())
        except (KeyError, ValueError, InvalidTag):
            raise Problem(f"The stored secret {location} was modified outside Duckpad", 500) from None
        return json.loads(plain)


def generate(file: Path) -> None:
    key = base64.b64encode(os.urandom(32)).decode()
    try:
        descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(KEY_FILE_HEADER + key + "\n")
