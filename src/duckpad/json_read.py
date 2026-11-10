"""Read project JSON that can safely round-trip through UTF-8 API responses."""

import json
import math
import re

SURROGATE = re.compile(r"[\ud800-\udfff]")
SURROGATE_ESCAPE = re.compile(r"\\u[dD][89a-fA-F]")


def reject_constant(value):
    raise ValueError(f"Non-finite number {value} is not valid JSON")


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        reject_constant(value)
    return number


def loads(text):
    """Reject non-finite numbers and unpaired Unicode surrogates, including in keys."""
    if isinstance(text, bytes):
        # Strict UTF-8, as project files are read: json.loads would let encoded surrogates pass.
        text = text.decode()
    value = json.loads(text, parse_constant=reject_constant, parse_float=finite_float)
    # Only an escape or a surrogate already in the text puts one in the value: skip the walk otherwise.
    may_hold = SURROGATE_ESCAPE.search(text) or (not text.isascii() and SURROGATE.search(text))
    pending = [value] if may_hold else []
    while pending:
        item = pending.pop()
        if isinstance(item, str) and SURROGATE.search(item):
            raise ValueError("Unpaired Unicode surrogate is not valid JSON")
        if isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    return value
