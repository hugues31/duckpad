"""Read project JSON that can safely round-trip through UTF-8 API responses."""

import json
import math
import re

SURROGATE = re.compile(r"[\ud800-\udfff]")


def reject_constant(value):
    raise ValueError(f"Non-finite number {value} is not valid JSON")


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        reject_constant(value)
    return number


def loads(text):
    """Reject non-finite numbers and unpaired Unicode surrogates, including in keys."""
    value = json.loads(text, parse_constant=reject_constant, parse_float=finite_float)
    pending = [value]
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
