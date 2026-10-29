"""Three-way merge of declarative project files with field-level conflicts."""

import json

from .util import dumps

MISSING = object()


def merge_values(base, current, proposed, path="", choices=None, evidence=None):
    """Three-way merge logical fields; arrays with stable IDs merge by identity."""
    if current == proposed or proposed == base:
        return current, []
    if current == base:
        return proposed, []
    if all(isinstance(v, dict) for v in (base, current, proposed)):
        result, conflicts = {}, []
        for key in sorted(base.keys() | current.keys() | proposed.keys()):
            value, errors = merge_values(
                base.get(key, MISSING),
                current.get(key, MISSING),
                proposed.get(key, MISSING),
                path + "/" + key.replace("~", "~0").replace("/", "~1"),
                choices,
                evidence,
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
        result, conflicts = merge_values(*mappings, path, choices, evidence)
        order = list(dict.fromkeys([x["id"] for x in current + proposed + base]))
        return [result[k] for k in order if k in result], conflicts
    if evidence is not None:
        values = {"base": base, "current": current, "incoming": proposed}
        choice = (choices or {}).get(path)
        evidence.append(
            {
                "path": path,
                "choice": choice,
                **{
                    key: {"present": value is not MISSING, "value": None if value is MISSING else value}
                    for key, value in values.items()
                },
            }
        )
        if choice in values:
            return values[choice], []
    return current, [path or "/"]


def merge_files(base, current, proposal, choices=None, evidence=None):
    result, conflicts = {}, []
    for name in sorted(base.keys() | current.keys() | proposal.keys()):
        values = [v.get(name, MISSING) for v in (base, current, proposal)]
        try:
            if name.endswith(".json") and all(v is not MISSING for v in values):
                merged, errors = merge_values(*(json.loads(v) for v in values), name, choices, evidence)
                content = dumps(merged)
            else:
                content, errors = merge_values(*values, name, choices, evidence)
        except (ValueError, TypeError):
            content, errors = merge_values(*values, name, choices, evidence)
        if content is not MISSING:
            result[name] = content
        conflicts.extend(errors)
    return result, conflicts
