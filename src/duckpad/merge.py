"""Three-way merge of declarative project files with field-level conflicts."""

from . import named_documents, project_files, variables
from .json_read import loads
from .util import Problem, dumps

MISSING = object()


def conflict_details(conflict):
    """Review evidence and an editable merge, without changing the retained conflict."""
    evidence = []
    merged, _ = merge_files(
        conflict["base"],
        conflict["current"],
        conflict["proposal"],
        choices=dict.fromkeys(conflict["paths"], "incoming"),
        evidence=evidence,
    )
    return {**conflict, "fields": evidence, "merged": merged}


def by_identity(value):
    """Index a list of objects by their unique string ids, or None when it cannot merge by identity."""
    if not isinstance(value, list) or not all(
        isinstance(x, dict) and isinstance(x.get("id"), str) for x in value
    ):
        return None
    mapping = {x["id"]: x for x in value}
    # Repeated ids would collapse into one item, so such lists merge as whole values.
    return mapping if len(mapping) == len(value) else None


def merge_values(base, current, proposed, path="", choices=None, evidence=None, resolution=MISSING):
    """Three-way merge logical fields; arrays with stable IDs merge by identity."""
    if current == proposed or proposed == base:
        return current, []
    if current == base:
        return proposed, []
    variable_path = path.startswith(variables.FILE + "/")
    atomic_source = variable_path and path.count("/") == 2 and path.endswith("/from")
    atomic_source |= (
        path.startswith("flow.json/partitions/") and path.count("/") == 3 and path.endswith("/values")
    )
    # Whole entries of a named document, at `file/key/name`, are never merged field by field.
    spec = project_files.matching(path.partition("/")[0]) if path.count("/") == 2 else None
    atomic_source |= spec is not None and spec.merge == "named" and spec.whole_entries
    mode_change = (
        variable_path
        and path.count("/") == 1
        and all(isinstance(v, dict) for v in (base, current, proposed))
        and ("from" in current) != ("from" in proposed)
        and any(
            ("from" in switched) != ("from" in base)
            and any(
                other.get(key, MISSING) != base.get(key, MISSING)
                for key in ("from", "default", "environments")
            )
            for switched, other in ((current, proposed), (proposed, current))
        )
    )
    mode_change |= (
        path.startswith("flow.json/nodes/")
        and path.count("/") == 2
        and all(isinstance(v, dict) for v in (base, current, proposed))
        and current.get("partitions") != proposed.get("partitions")
        and any(
            switched.get("partitions") != base.get("partitions")
            and other.get("outputs") != base.get("outputs")
            for switched, other in ((current, proposed), (proposed, current))
        )
    )
    if not atomic_source and not mode_change and all(isinstance(v, dict) for v in (base, current, proposed)):
        result, conflicts = {}, []
        for key in sorted(base.keys() | current.keys() | proposed.keys()):
            value, errors = merge_values(
                base.get(key, MISSING),
                current.get(key, MISSING),
                proposed.get(key, MISSING),
                path + "/" + key.replace("~", "~0").replace("/", "~1"),
                choices,
                evidence,
                resolution.get(key, MISSING) if isinstance(resolution, dict) else MISSING,
            )
            if value is not MISSING:
                result[key] = value
            conflicts.extend(errors)
        return result, conflicts
    mappings = [by_identity(v) for v in (base, current, proposed)]
    if all(mapping is not None for mapping in mappings):
        resolved = by_identity(resolution)
        result, conflicts = merge_values(
            *mappings, path, choices, evidence, resolved if resolved is not None else MISSING
        )
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
        if choice == "combined":
            return resolution, []
    return current, [path or "/"]


def merge_files(base, current, proposal, choices=None, evidence=None, resolutions=None):
    """Merge independent edits, using combined contents only at conflicting paths."""
    result, conflicts = {}, []
    for name in sorted(base.keys() | current.keys() | proposal.keys()):
        spec = project_files.matching(name)
        values = [v.get(name, MISSING) for v in (base, current, proposal)]
        resolution = (
            (resolutions or {}).get(name, MISSING)
            if any(
                choice == "combined" and (path == name or path.startswith(name + "/"))
                for path, choice in (choices or {}).items()
            )
            else MISSING
        )
        if (
            spec is not None
            and spec.merge in ("declarations", "named")
            and values[0] is MISSING
            and all(v is not MISSING for v in values[1:])
        ):
            # Without the file a project has no declarations. Branches that both create
            # it merge independent variables or extension requirements by name.
            values[0] = "{}"
        try:
            if (
                spec is not None
                and spec.merge in ("json", "declarations", "named")
                and all(v is not MISSING for v in values)
            ):
                parsed = [loads(v) for v in values]
                resolved = MISSING
                if isinstance(resolution, str):
                    try:
                        resolved = loads(resolution)
                    except (ValueError, TypeError) as error:
                        raise Problem(f"Combined contents for {name} must be valid JSON", 422) from error
                named = [named_documents.by_name(v) for v in parsed] if spec.merge == "named" else [None]
                if all(v is not None for v in named):
                    # Branches that both add entries to an output the base lacks merge them by name.
                    for key in (named[1].keys() & named[2].keys()) - named[0].keys():
                        named[0][key] = {}
                    # Named documents merge entry by entry, keyed by output and name.
                    merged, errors = merge_values(
                        *named, name, choices, evidence, named_documents.by_name(resolved)
                    )
                    merged = named_documents.from_names(merged, [parsed[1], parsed[2], parsed[0]])
                else:
                    merged, errors = merge_values(*parsed, name, choices, evidence, resolved)
                content = dumps(merged)
            else:
                content, errors = merge_values(*values, name, choices, evidence, resolution)
        except (ValueError, TypeError):
            content, errors = merge_values(*values, name, choices, evidence, resolution)
        if spec is not None and spec.merge == "generated" and errors:
            # Generated dependency state is resolved again from the merged manifest.
            # Editable saves/runs regenerate it; a tag must carry the resolved lock.
            content, errors = MISSING, []
        if content is not MISSING:
            result[name] = content
        conflicts.extend(errors)
    return result, conflicts
