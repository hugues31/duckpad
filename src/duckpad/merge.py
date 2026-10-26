"""Three-way merge of declarative project files with field-level conflicts."""

import json

from .util import dumps

MISSING = object()


def merge_values(base, current, proposed, path=""):
    """Three-way merge logical fields; arrays with stable IDs merge by identity."""
    if current == proposed or proposed == base:
        return current, []
    if current == base:
        return proposed, []
    if all(isinstance(v, dict) for v in (base, current, proposed)):
        result, conflicts = {}, []
        for key in base.keys() | current.keys() | proposed.keys():
            value, errors = merge_values(
                base.get(key, MISSING),
                current.get(key, MISSING),
                proposed.get(key, MISSING),
                path + "/" + key,
            )
            if value is not MISSING:
                result[key] = value
            conflicts.extend(errors)
        return result, conflicts
    if all(
        isinstance(v, list) and all(isinstance(x, dict) and "id" in x for x in v)
        for v in (base, current, proposed)
    ):
        mappings = [{x["id"]: x for x in v} for v in (base, current, proposed)]
        result, conflicts = merge_values(*mappings, path)
        order = list(dict.fromkeys([x["id"] for x in current + proposed]))
        return [result[k] for k in order if k in result], conflicts
    return current, [path or "/"]


def merge_files(base, current, proposal):
    result, conflicts = {}, []
    for name in base.keys() | current.keys() | proposal.keys():
        values = [v.get(name, MISSING) for v in (base, current, proposal)]
        try:
            if name.endswith(".json") and all(v is not MISSING for v in values):
                merged, errors = merge_values(*(json.loads(v) for v in values), name)
                content = dumps(merged)
            else:
                content, errors = merge_values(*values, name)
        except (ValueError, TypeError):
            content, errors = merge_values(*values, name)
        if content is not MISSING:
            result[name] = content
        conflicts.extend(errors)
    return result, conflicts
