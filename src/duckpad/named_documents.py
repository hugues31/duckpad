"""Per-output named documents: lists of named entries keyed by node output, like views.json.

A key names the output that stores the rows, `node:port`, or `instance::node:port` inside a
component instance. Entries merge, compare and move with their nodes by name.
"""

import re

from .types import Record
from .util import Problem

KEY = re.compile(r"[^:\s]+(?:::[^:\s]+)*:[^:\s]+")
MAX_NAME_LENGTH = 100


def declarations(document, value, fields, check, noun):
    """Entries by output key, or a Problem; `check(key, entry)` validates entry-specific fields."""
    raw = document.declarations(value)
    for key, entries in raw.items():
        if not KEY.fullmatch(key):
            raise Problem(f"{document.file}: {key!r} must name a node output as node:port", 422)
        if not isinstance(entries, list):
            raise Problem(f"{document.file}: the {noun}s of {key} must be a list", 422)
        for entry in entries:
            if not isinstance(entry, dict):
                raise Problem(f"{document.file}: each {noun} of {key} must be an object", 422)
            unknown = sorted(entry.keys() - fields)
            if unknown:
                raise Problem(
                    f"{document.file}: a {noun} of {key} has unknown fields: {', '.join(unknown)}", 422
                )
            name = entry.get("name")
            if not isinstance(name, str) or not name.strip() or len(name) > MAX_NAME_LENGTH:
                raise Problem(
                    f"{document.file}: each {noun} of {key} needs a name of 1 to {MAX_NAME_LENGTH} characters",
                    422,
                )
            check(key, entry)
        if len({entry["name"] for entry in entries}) != len(entries):
            raise Problem(f"{document.file}: the {noun}s of {key} need distinct names", 422)
    return raw


def by_name(value):
    """`{key: {name: entry}}` for a three-way merge entry by entry, or None when names repeat."""
    if not isinstance(value, dict) or not all(
        isinstance(entries, list)
        and all(isinstance(entry, dict) and isinstance(entry.get("name"), str) for entry in entries)
        for entries in value.values()
    ):
        return None
    result = {key: {entry["name"]: entry for entry in entries} for key, entries in value.items()}
    if any(len(result[key]) != len(entries) for key, entries in value.items()):
        return None
    return result


def from_names(merged, sides):
    """Lists of entries again, ordered as the current side, then the incoming and base sides."""
    result = {}
    for key, entries in merged.items():
        order = [
            entry["name"] for side in sides for entry in (side.get(key) or []) if isinstance(entry, dict)
        ]
        names = list(dict.fromkeys([*order, *entries]))
        result[key] = [entries[name] for name in names if name in entries]
    return result


def regroup(document: Record | None, prefixes: list[str], instance: str, selected) -> None:
    """Move the entries of grouped nodes under their new component instance."""
    if not isinstance(document, dict):
        return
    for prefix in prefixes:
        for key in list(document):
            local = key[len(prefix) :] if key.startswith(prefix) else ""
            if any(local.startswith(node + ":") for node in selected):
                document[prefix + instance + "::" + local] = document.pop(key)


def prune(document: Record | None, owners: list[str]) -> bool:
    """Remove the entries of deleted nodes, including nodes inside deleted component instances."""
    if not isinstance(document, dict) or not owners:
        return False
    removed = [key for key in document if any(key.startswith(owner + ":") for owner in owners)]
    for key in removed:
        del document[key]
    return bool(removed)
