"""On-demand comparisons of retained branch results, without executing project code."""

import json
from collections import Counter
from contextlib import ExitStack

from .bundle import files_to_bundle
from .comparison import compare_files
from .execution.results import schema_changes
from .execution.samples import reading
from .node_names import node_name
from .util import Problem, clean, qi

MAX_ROWS = 50_000


def available_results(results, review, environment):
    """Only current, complete outputs from both local branches are comparable."""
    if not review["source_worktree"]:
        return []
    report = compare_files(review["current"], review["incoming"])
    nodes = set(report["impact"]["direct"])
    nodes.update(
        entity["id"].removeprefix("node/")
        for entity in report["entities"]
        if entity["kind"] == "node" and not entity["scope"] and entity["status"] == "modified"
    )
    bundle = files_to_bundle(review["incoming"])
    contexts = [results.pool.get(review[key], environment) for key in ("worktree", "source_worktree")]
    entries = []
    with ExitStack() as locks:
        for context in sorted(contexts, key=lambda value: value.worktree):
            locks.enter_context(context.lock)
        for node in sorted(nodes):
            before, after = (context.outputs.get(node, {}) for context in contexts)
            for port in sorted(before.keys() & after.keys()):
                old, new = before[port], after[port]
                if any(
                    value.status != "valid" or value.incomplete or value.partition for value in (old, new)
                ):
                    continue
                entries.append(
                    {
                        "node": node,
                        "name": node_name(bundle, node),
                        "port": port,
                        "before": old.public(),
                        "after": new.public(),
                        "columns": schema_changes(old.columns, new.columns, old.run),
                        "keys": [column["name"] for column in old.columns if column in new.columns],
                    }
                )
    return entries


def compare_result(results, review, environment, node, port, before, after, key=None):
    """Compare whole retained outputs. A unique non-null key separates updates from replacements."""
    entry = next(
        (
            value
            for value in available_results(results, review, environment)
            if value["node"] == node and value["port"] == port
        ),
        None,
    )
    if not entry or entry["before"]["id"] != before or entry["after"]["id"] != after:
        raise Problem("Results changed or are unavailable. Reload the data impact section.", 409)
    if key and key not in entry["keys"]:
        raise Problem("Choose a common column with the same type as the comparison key.", 422)
    if entry["columns"]["retyped"]:
        raise Problem(
            "Column types changed. Row comparison requires matching types; review the column changes.", 422
        )
    columns = entry["keys"]
    if not columns:
        raise Problem("These results have no common columns to compare.", 422)
    if max(entry[side]["count"] for side in ("before", "after")) > MAX_ROWS:
        raise Problem(
            f"Row comparison supports up to {MAX_ROWS:,} rows per result. Column changes are available.", 422
        )
    pairs = [
        results.find_dataset(review[side], environment, node, port)
        for side in ("worktree", "source_worktree")
    ]
    encoded = []
    with ExitStack() as reads:
        cursors = [reads.enter_context(reading(context, [dataset])) for context, dataset in pairs]
        for cursor, (_, dataset) in zip(cursors, pairs, strict=True):
            rows = cursor.execute(
                f"SELECT {', '.join(qi(column) for column in columns)} FROM {qi(dataset.table)} LIMIT {MAX_ROWS + 1}"
            ).fetchall()
            if len(rows) > MAX_ROWS:
                raise Problem("This result exceeds the row comparison limit.", 422)
            if key:
                index = columns.index(key)
                if any(row[index] is None for row in rows):
                    raise Problem(
                        "The comparison key contains null values. Choose a unique non-null key.", 422
                    )
                values = {encode(row[index]): encode(row) for row in rows}
                if len(values) != len(rows):
                    raise Problem("The comparison key contains duplicates. Choose a unique key.", 422)
            else:
                values = Counter(encode(row) for row in rows)
            encoded.append(values)
        # Never label an earlier generation as the result the user asked to compare.
        if [dataset.id for _, dataset in pairs] != [before, after]:
            raise Problem("Results changed during comparison. Reload the data impact section.", 409)
    old, new = encoded
    if key:
        added, removed = len(new.keys() - old.keys()), len(old.keys() - new.keys())
        modified = sum(old[value] != new[value] for value in old.keys() & new.keys())
    else:
        assert isinstance(old, Counter) and isinstance(new, Counter)
        added, removed = sum((new - old).values()), sum((old - new).values())
        modified = None
    return {
        "added": added,
        "removed": removed,
        "modified": modified,
        "key": key,
        "before": before,
        "after": after,
        "columns": entry["columns"],
    }


def encode(value):
    return json.dumps(clean(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
