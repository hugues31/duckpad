"""Three-way merge of declarative project files with field-level conflicts."""

import json

from . import project_extensions, variables, views
from .util import dumps

MISSING = object()


def by_identity(value):
    """Index a list of objects by their unique string ids, or None when it cannot merge by identity."""
    if not isinstance(value, list) or not all(
        isinstance(x, dict) and isinstance(x.get("id"), str) for x in value
    ):
        return None
    mapping = {x["id"]: x for x in value}
    # Repeated ids would collapse into one item, so such lists merge as whole values.
    return mapping if len(mapping) == len(value) else None


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
    mappings = [by_identity(v) for v in (base, current, proposed)]
    if all(mapping is not None for mapping in mappings):
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
        if (
            name in (variables.FILE, project_extensions.FILE, views.FILE)
            and values[0] is MISSING
            and all(v is not MISSING for v in values[1:])
        ):
            # Without the file a project has no declarations. Branches that both create
            # it merge independent variables or extension requirements by name.
            values[0] = "{}"
        try:
            if name.endswith(".json") and all(v is not MISSING for v in values):
                parsed = [json.loads(v) for v in values]
                named = [views.by_name(v) for v in parsed] if name == views.FILE else [None]
                if all(v is not None for v in named):
                    # Shared views merge view by view, keyed by their name.
                    merged, errors = merge_values(*named, name, choices, evidence)
                    merged = views.from_names(merged, [parsed[1], parsed[2], parsed[0]])
                else:
                    merged, errors = merge_values(*parsed, name, choices, evidence)
                content = dumps(merged)
            else:
                content, errors = merge_values(*values, name, choices, evidence)
        except (ValueError, TypeError):
            content, errors = merge_values(*values, name, choices, evidence)
        if content is not MISSING:
            result[name] = content
        conflicts.extend(errors)
    return result, conflicts
