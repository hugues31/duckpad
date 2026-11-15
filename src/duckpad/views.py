"""Shared result views: named samples of node outputs, saved in views.json with the project.

A view only chooses which retained rows the results panel shows (first or random rows, a
filter and a sort); it never changes what runs compute, so saving one makes nothing stale.
Views are keyed like dataset documentation, by `node:port`, and merge view by view.
"""

from . import named_documents
from .project_files import VIEWS as DOCUMENT
from .util import Problem

FILE = DOCUMENT.file
# Samples show at most this many rows, like a preview page.
MAX_SAMPLE_ROWS = 10_000
MAX_FILTER_LENGTH = 4_000
METHODS = ("first", "random")
DIRECTIONS = ("asc", "desc")
FIELDS = {"name", "rows", "method", "seed", "filter", "order"}

read = DOCUMENT.read
write = DOCUMENT.write


def check_view(key, view):
    name = view["name"]
    if view.get("method", "first") not in METHODS:
        raise Problem(f"{FILE}: view {name} uses first or random rows", 422)
    rows = view.get("rows")
    if rows is not None and (type(rows) is not int or not 1 <= rows <= MAX_SAMPLE_ROWS):
        raise Problem(f"{FILE}: view {name} shows between 1 and {MAX_SAMPLE_ROWS} rows", 422)
    seed = view.get("seed", 0)
    if type(seed) is not int or not 0 <= seed < 2**31:
        raise Problem(f"{FILE}: view {name} needs a positive integer seed", 422)
    condition = view.get("filter", "")
    if not isinstance(condition, str) or len(condition) > MAX_FILTER_LENGTH:
        raise Problem(f"{FILE}: the filter of view {name} must be text", 422)
    order = view.get("order", [])
    if not isinstance(order, list) or any(
        not isinstance(item, list)
        or len(item) != 2
        or not isinstance(item[0], str)
        or item[1] not in DIRECTIONS
        for item in order
    ):
        raise Problem(f"{FILE}: view {name} sorts a list of [column, asc or desc] pairs", 422)
    if len({item[0] for item in order}) != len(order):
        raise Problem(f"{FILE}: view {name} sorts each column once", 422)


def declarations(bundle):
    """The views of a bundle by output key, or a Problem describing why views.json is invalid."""
    return named_documents.declarations(DOCUMENT, bundle.get("views"), FIELDS, check_view, "view")


def problems(bundle):
    return DOCUMENT.problems(declarations, bundle)
