"""Python payloads, results and managed downloads."""

from __future__ import annotations

import shutil
import time
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING

from .. import variables
from ..catalog import redact
from ..datasets import Dataset
from ..graph import connection_references
from ..materialize import (
    publish_view,
)
from ..python_policy import get_policy
from ..store import Store
from ..types import Record
from ..util import Problem, uid
from .exports import Exports
from .journal import RunJournal
from .messages import check_result, record_result

if TYPE_CHECKING:
    from .runs import Execution


class PythonNodes:
    def __init__(self, store: Store, exports: Exports, journal: RunJournal) -> None:
        self.store, self.exports, self.journal = store, exports, journal

    def compute(
        self,
        execution: Execution,
        key: str,
        inputs: dict[str, Dataset],
        physical: dict[str, str],
        project_files: dict[str, Path],
        created_tables: list[tuple[str, str]],
    ) -> dict[str, Dataset]:
        from ..python_nodes import parameters
        from .nodes import row_count, staged_dataset

        if execution.schema_only:
            raise Problem(
                "Python does not support schema-only or empty-manifest execution; no user code was run", 422
            )
        node = execution.nodes[key]
        state = execution.run["nodes"][key]
        values = parameters(
            node,
            {p: d.columns for p, d in inputs.items()},
            execution.captured,
            project_files,
            variables.expression_values(node),
            bindings=node.get("variables"),
        )
        state["parameters"] = values
        workspace = (
            self.store.paths.exports(execution.context.worktree, execution.context.environment)
            / ".temporary"
            / uid("python_")
        )
        policy = get_policy(self.store, execution.run["project"])
        if not policy.get("enabled"):
            raise Problem("Python execution is disabled", 403)
        workspace.mkdir(parents=True)
        staged = {}
        try:
            state["external_started"] = True
            self.journal.persist(execution.run, execution.secrets)
            cursor = execution.cursor
            from ..sandbox import Cursor as WorkerCursor

            assert isinstance(cursor, WorkerCursor)
            python_start = time.monotonic()
            response = cursor.python(self.payload(execution, key, values, inputs, physical, workspace))
            self.record_response(execution, key, response)
            created_tables.extend((table, table + "_storage") for table in physical.values())
            for port, table in physical.items():
                storage = table + "_storage"
                columns, mapping, _ = publish_view(cursor, table, {"storage": storage, "columns": None})
                count = row_count(cursor, table)
                staged[port] = staged_dataset(
                    execution,
                    key,
                    port,
                    table,
                    columns,
                    storage,
                    python_start,
                    count=count,
                    query="",
                    bindings={},
                    dependencies={d.table: d.id for d in inputs.values()},
                    source_columns=columns,
                    column_map=mapping,
                    opaque_python=True,
                )
            self.capture_artifacts(execution, key, response, workspace)
            state["external_outcome"] = "completed"
            return staged
        finally:
            shutil.rmtree(workspace, ignore_errors=True)

    @staticmethod
    def payload(
        execution: Execution,
        key: str,
        values: Record,
        inputs: dict[str, Dataset],
        physical: dict[str, str],
        workspace: Path,
    ) -> Record:
        return {
            "code": execution.nodes[key]["template_sql"],
            "parameters": values,
            "inputs": {p: inputs[p].table for p in execution.nodes[key]["parsed"]["inputs"]},
            "outputs": {p: name + "_storage" for p, name in physical.items()},
            "workspace": str(workspace),
            "partition": execution.partition,
            "partition_filters": execution.nodes[key].get("partition_filters", {}),
            "filename": "nodes/" + key.replace("::", "/") + ".py",
            "helpers": execution.bundle.get("python_helpers", {}),
            "connections": {
                r: execution.captured[r]["values"] for r in connection_references(execution.nodes[key])
            },
        }

    def record_response(self, execution: Execution, key: str, response: Record) -> None:
        for result in response.get("messages", []):
            record_result(
                execution.run,
                key,
                {
                    **result,
                    "message": redact(result["message"], execution.secrets),
                    "origin": {"kind": "message", "block": "Python"},
                    "output": None,
                },
            )
        if response.get("log"):
            record_result(
                execution.run,
                key,
                {
                    "level": "info",
                    "message": redact(response["log"], execution.secrets),
                    "origin": {"kind": "message", "block": "Python stdout/stderr"},
                    "output": None,
                },
            )
        for check in response.get("checks", []):
            # Recorded like SQL tests, so the Tests tab, badges and history read them the same way.
            record_result(
                execution.run,
                key,
                check_result(
                    check["name"], check["count"], check["severity"], execution.secrets, block="Python"
                ),
            )
        if response.get("error"):
            raise Problem(response["error"].replace(str(self.store.home), "<instance>"), 422)

    def capture_artifacts(self, execution: Execution, key: str, response: Record, workspace: Path) -> None:
        state = execution.run["nodes"][key]
        artifacts = response.get("artifacts", {})
        if artifacts:
            # One download per node: several managed files are bundled without loading them into memory.
            for name, path in artifacts.items():
                if Path(path) != workspace / "artifacts" / name or Path(name).name != name:
                    raise Problem("Invalid managed artifact path", 422)
            if len(artifacts) == 1:
                path = Path(next(iter(artifacts.values())))
            else:
                path = workspace / "artifacts.zip"
                with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
                    from ..artifacts import open_regular

                    for name, source in artifacts.items():
                        with open_regular(Path(source)) as reader, archive.open(name, "w") as writer:
                            shutil.copyfileobj(reader, writer, 65536)
            state["artifact"] = self.exports.artifacts.capture(
                {"path": str(path), "format": path.suffix.lstrip(".") or "bin"},
                execution.run,
                key,
                [workspace],
            )
