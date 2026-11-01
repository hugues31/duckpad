"""Shared result views: named samples of node outputs, saved in views.json with the project.

A view only chooses which retained rows the results panel shows (first or random rows, a
filter and a sort); it never changes what runs compute, so saving one makes nothing stale.
Views are keyed like dataset documentation, by `node:port`, and merge view by view.
"""

import json
import re

from .types import Record
from .util import Problem, dumps

FILE = "views.json"
# Samples show at most this many rows, like a preview page.
MAX_SAMPLE_ROWS = 10_000
MAX_FILTER_LENGTH = 4_000
METHODS = ("first", "random")
DIRECTIONS = ("asc", "desc")
FIELDS = {"name", "rows", "method", "seed", "filter", "order"}
KEY = re.compile(r"[^:\s]+(?:::[^:\s]+)*:[^:\s]+")
MAX_NAME_LENGTH = 100


def read(text):
    """The bundle form of views.json: an object, None without the file, or its raw text otherwise."""
    if text is None:
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return text
    return value if isinstance(value, dict) else text


def write(value):
    return value if isinstance(value, str) else dumps(value)


def check_view(key, view):
    if not isinstance(view, dict):
        raise Problem(f"{FILE}: each view of {key} must be an object")
    unknown = sorted(view.keys() - FIELDS)
    if unknown:
        raise Problem(f"{FILE}: a view of {key} has unknown fields: {', '.join(unknown)}")
    name = view.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > MAX_NAME_LENGTH:
        raise Problem(f"{FILE}: each view of {key} needs a name of 1 to {MAX_NAME_LENGTH} characters")
    if view.get("method", "first") not in METHODS:
        raise Problem(f"{FILE}: view {name} uses first or random rows")
    rows = view.get("rows")
    if rows is not None and (type(rows) is not int or not 1 <= rows <= MAX_SAMPLE_ROWS):
        raise Problem(f"{FILE}: view {name} shows between 1 and {MAX_SAMPLE_ROWS} rows")
    seed = view.get("seed", 0)
    if type(seed) is not int or not 0 <= seed < 2**31:
        raise Problem(f"{FILE}: view {name} needs a positive integer seed")
    condition = view.get("filter", "")
    if not isinstance(condition, str) or len(condition) > MAX_FILTER_LENGTH:
        raise Problem(f"{FILE}: the filter of view {name} must be text")
    order = view.get("order", [])
    if not isinstance(order, list) or any(
        not isinstance(item, list)
        or len(item) != 2
        or not isinstance(item[0], str)
        or item[1] not in DIRECTIONS
        for item in order
    ):
        raise Problem(f"{FILE}: view {name} sorts a list of [column, asc or desc] pairs")
    if len({item[0] for item in order}) != len(order):
        raise Problem(f"{FILE}: view {name} sorts each column once")


def declarations(bundle):
    """The views of a bundle by output key, or a Problem describing why views.json is invalid."""
    raw = bundle.get("views")
    if raw is None:
        return {}
    if isinstance(raw, str):
        try:
            json.loads(raw)
        except ValueError as error:
            raise Problem(f"{FILE} is not valid JSON: {error}") from error
    if not isinstance(raw, dict):
        raise Problem(f"{FILE} must contain an object of views by node output")
    for key, views in raw.items():
        if not KEY.fullmatch(key):
            raise Problem(f"{FILE}: {key!r} must name a node output as node:port")
        if not isinstance(views, list):
            raise Problem(f"{FILE}: the views of {key} must be a list")
        for view in views:
            check_view(key, view)
        if len({view["name"] for view in views}) != len(views):
            raise Problem(f"{FILE}: the views of {key} need distinct names")
    return raw


def problems(bundle):
    try:
        declarations(bundle)
        return []
    except Problem as error:
        return [{"file": FILE, "message": str(error)}]


def by_name(value):
    """`{key: {name: view}}` for a three-way merge view by view, or None when names repeat."""
    if not isinstance(value, dict) or not all(
        isinstance(views, list) and all(isinstance(v, dict) and isinstance(v.get("name"), str) for v in views)
        for views in value.values()
    ):
        return None
    result = {key: {view["name"]: view for view in views} for key, views in value.items()}
    if any(len(result[key]) != len(views) for key, views in value.items()):
        return None
    return result


def from_names(merged, sides):
    """Lists of views again, ordered as the current side, then the incoming and base sides."""
    result = {}
    for key, views in merged.items():
        order = [view["name"] for side in sides for view in (side.get(key) or []) if isinstance(view, dict)]
        names = list(dict.fromkeys([*order, *views]))
        result[key] = [views[name] for name in names if name in views]
    return result


def prune(views: Record | None, owners: list[str]) -> bool:
    """Remove the views of deleted nodes, including nodes inside deleted component instances."""
    if not isinstance(views, dict) or not owners:
        return False
    removed = [key for key in views if any(key.startswith(owner + ":") for owner in owners)]
    for key in removed:
        del views[key]
    return bool(removed)
