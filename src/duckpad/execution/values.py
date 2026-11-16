"""Freeze computed variables at the boundary between producers and consumers."""

from __future__ import annotations

import copy
import threading
from typing import TYPE_CHECKING

from .. import value_sources, variables
from ..components import expand_for
from ..graph import connection_references, reachable
from .fingerprints import Fingerprints
from .journal import RunJournal

if TYPE_CHECKING:
    from .launches import Execution


class RunValues:
    def __init__(self, fingerprints: Fingerprints, lock: threading.RLock, journal: RunJournal) -> None:
        self.fingerprints, self.lock, self.journal = fingerprints, lock, journal

    def freeze(self, execution: Execution) -> None:
        """Publish all successful extractions at the phase boundary, then bind consumers."""
        if not execution.sources:
            return
        run, context = execution.run, execution.context
        extracted = {}
        for name, source in execution.sources.items():
            key = source.get("node")
            if key not in execution.value_phase:
                continue
            upstream = reachable({key}, execution.edges, upstream=True)
            invalid = next(
                (execution.validation_errors[n] for n in upstream if n in execution.validation_errors), None
            )
            if invalid:
                entry = value_sources.unavailable(source, invalid["code"], invalid["error"])
            elif run["nodes"][key]["status"] != "success" or execution.canceled:
                entry = value_sources.unavailable(
                    source, "value_source_failed", f"{name}: source {source['from']['node']} failed"
                )
            else:
                dataset = execution.published[key].get(source["port"])
                entry = (
                    value_sources.extract(execution.cursor, dataset, source)
                    if dataset
                    else value_sources.unavailable(
                        source, "value_source_failed", "Source output was not published"
                    )
                )
            if "error" in entry:
                origin = source["from"]
                entry["error"] = (
                    f"{name}: {origin['node']}.{origin['port']}.{origin['column']}: {entry['error']}"
                )
            entry.update(resolution="calculated", producer_run=run["id"], producer_commit=run["commit"])
            extracted[name] = entry
        with self.lock, context.lock:
            if execution.canceled:
                for entry in extracted.values():
                    entry.pop("value", None)
                    entry.update(
                        state="unavailable", code="value_source_failed", error="Value phase canceled"
                    )
            execution.values.update(extracted)
            run["variables"].update(extracted)
            # Persist evidence before any value becomes available to subsequent requests.
            self.journal.persist(run, execution.secrets)
            if not execution.canceled:
                for name, entry in extracted.items():
                    signature = value_sources.identity(execution.sources[name])
                    context.value_attempts[signature] = copy.deepcopy(entry)
                    if entry["state"] == "ready":
                        context.retained_values[signature] = copy.deepcopy(entry)
        rebound, _, _ = expand_for(execution.bundle, context.environment, computed=execution.values)
        for key in execution.order:
            if key not in execution.value_phase:
                # Connection failures captured at admission remain failures after binding.
                for reference in connection_references(rebound[key]):
                    if reference not in execution.captured:
                        rebound[key]["error"] = execution.nodes[key].get("error", "Connection unavailable")
                execution.nodes[key] = rebound[key]
        execution.fingerprints = self.fingerprints.of(
            execution.bundle, context.environment, execution.captured, execution.values
        )
        for key in execution.order:
            run["nodes"][key]["fingerprint"] = execution.fingerprints[key]
        run["variables"].update(
            variables.used(
                execution.bundle, execution.nodes, execution.order, context.environment, execution.values
            )
        )
        self.fingerprints.invalidate(context)
