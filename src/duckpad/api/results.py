"""Results HTTP routes."""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import ExitStack
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from .. import schemas, table_lineage
from ..artifacts import CHUNK_SIZE
from ..execution.launch import launch_worktree
from ..execution.samples import Sample
from ..partition_storage import run_manifest
from ..types import Record
from ..util import Problem
from .context import Context
from .deps import PartitionQuery, requester
from .http import (
    same_origin_download,
)
from .security import (
    run_role,
    signed_in,
    worktree_role,
)


def router(ctx: Context) -> APIRouter:
    api = APIRouter()
    services = ctx.services
    store = ctx.services.store
    engine = ctx.services.engine
    access = ctx.access

    @api.get(
        "/api/worktrees/{worktree}/status",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def status(worktree: str, environment: str) -> Record:
        return engine.statuses(worktree, environment)

    @api.get(
        "/api/worktrees/{worktree}/lineage/tables",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def tables(
        worktree: str,
        node: str,
        port: str | None = None,
        direction: str = "origin",
        environment: str = "dev",
    ) -> Record:
        if direction not in {"origin", "impact"}:
            raise Problem("Unknown lineage direction", 422)
        return table_lineage.describe(
            services.projects.snapshot(worktree)["bundle"], node, port, direction, environment
        )

    @api.post(
        "/api/worktrees/{worktree}/lineage/rows",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def lineage_rows(worktree: str, data: schemas.LineageRows) -> Record:
        result = services.lineage.explain(
            worktree,
            data.environment,
            data.dataset,
            data.row,
            data.column,
            data.offset,
            data.group,
            data.context,
            page_size=data.page_size,
            partition_context=data.partition_context,
            operand=data.operand,
            rows_dataset=data.input_dataset,
            search=data.search,
        )
        # Sources, Python steps and retained partition origins have no contributing rows.
        if "rows" not in result:
            raise Problem("This value has no contributing rows to open", 422)
        return result

    @api.post(
        "/api/worktrees/{worktree}/runs", response_model=None, dependencies=[Depends(worktree_role("editor"))]
    )
    def launch(worktree: str, data: schemas.Launch, request: Request) -> Record:
        return launch_worktree(services, worktree, data, requester(request))

    @api.post(
        "/api/worktrees/{worktree}/draft-preview/{node}",
        response_model=None,
        dependencies=[Depends(worktree_role("editor"))],
    )
    def draft_preview(worktree: str, node: str, data: schemas.DraftPreview, request: Request) -> Record:
        """Compute a node's code on samples of its inputs without recording or publishing anything."""
        return engine.draft_preview(
            worktree, data.environment, node, data.code, data.rows, request.state.user["id"]
        )

    @api.get(
        "/api/worktrees/{worktree}/input-columns/{node}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def input_columns(
        worktree: str, node: str, environment: str, partition: Annotated[PartitionQuery, Depends()]
    ) -> Record:
        return engine.input_columns(worktree, environment, node, partition.context)

    @api.get("/api/runs", response_model=None, dependencies=[Depends(signed_in)])
    def runs(
        request: Request,
        response: Response,
        worktree: str | None = None,
        include_jobs: bool = False,
        limit: int = Query(50, ge=1, le=100),
        cursor: str | None = None,
    ) -> list[Record]:
        if worktree:
            access.worktree(request.state.user, worktree)
        rows = store.runs(
            request.state.user, worktree, include_jobs, limit=limit + 1, cursor=cursor, summary=True
        )
        if len(rows) > limit:
            response.headers["X-Next-Cursor"] = store.run_cursor(rows[limit - 1])
        return rows[:limit]

    @api.get(
        "/api/worktrees/{worktree}/test-history/{node}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def test_history(worktree: str, node: str, environment: str, limit: int = 10) -> list[Record]:
        return store.test_history(worktree, environment, node, limit)

    @api.get("/api/runs/{run}", response_model=None, dependencies=[Depends(run_role("reader"))])
    def get_run(run: str) -> Record:
        record = store.get("run", run)
        if not record:
            raise Problem("Execution not found", 404)
        return record

    @api.post("/api/runs/{run}/cancel", response_model=None, dependencies=[Depends(run_role("operator"))])
    def cancel(run: str) -> Record:
        return engine.cancel(run)

    @api.get(
        "/api/worktrees/{worktree}/partitions",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def partition_entries(
        worktree: str,
        environment: str,
        manifest: str | None = None,
        node: str | None = None,
        port: str = "result",
        cursor: str | None = None,
        limit: int = 50,
        search: str = "",
        status: str | None = None,
        run: str | None = None,
        key_hash: str | None = None,
    ) -> Record:
        if run:
            record = store.get("run", run)
            if not record:
                raise Problem("Run not found", 404)
            if record["worktree"] != worktree or record["environment"] != environment:
                raise Problem("Run does not belong to this context", 404)
            manifest = run_manifest(record)
        return engine.partitions.page(
            worktree,
            environment,
            manifest=manifest,
            node=node,
            port=port,
            cursor=cursor,
            limit=limit,
            search=search,
            status=status,
            run=run,
            key_hash=key_hash,
        )

    @api.get(
        "/api/worktrees/{worktree}/partition-attempts/{node}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def partition_attempt(
        worktree: str, node: str, environment: str, manifest: str, partition_id: str
    ) -> Record:
        return engine.partitions.attempt(
            worktree, environment, node, {"manifest": manifest, "partition_id": partition_id}
        )

    @api.get(
        "/api/worktrees/{worktree}/compile/{node}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def compile_sql(
        worktree: str,
        node: str,
        environment: str,
        partition: Annotated[PartitionQuery, Depends()],
    ) -> list[Record]:
        selection = partition.context
        return engine.compile(
            worktree,
            environment,
            node,
            partition=engine.partitions.compile_entry(worktree, environment, selection)
            if selection
            else None,
        )

    @api.get(
        "/api/worktrees/{worktree}/exports/{node}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def export_result(
        worktree: str,
        node: str,
        environment: str,
        partition: Annotated[PartitionQuery, Depends()],
    ) -> Record:
        selection = partition.context
        return (
            engine.partitions.export_result(worktree, environment, node, selection)
            if selection
            else engine.export_result(worktree, environment, node)
        )

    @api.get(
        "/api/worktrees/{worktree}/exports/{node}/download",
        response_model=None,
        dependencies=[Depends(worktree_role("reader")), Depends(same_origin_download)],
    )
    def download_export(
        worktree: str,
        node: str,
        run: str,
        environment: str,
        partition: Annotated[PartitionQuery, Depends()],
    ) -> StreamingResponse:
        opened = ExitStack()
        selection = partition.context
        stream, record = opened.enter_context(
            engine.partitions.open_export(worktree, environment, node, run, selection)
            if selection
            else engine.open_export(worktree, environment, node, run)
        )

        def chunks() -> Iterator[bytes]:
            try:
                while chunk := stream.read(CHUNK_SIZE):
                    yield chunk
            finally:
                opened.close()

        return StreamingResponse(
            chunks(),
            media_type=record["media_type"],
            headers={
                "Content-Disposition": "attachment; filename*=UTF-8''" + quote(record["filename"], safe=""),
                "Content-Length": str(record["size"]),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
            background=BackgroundTask(opened.close),
        )

    @api.get(
        "/api/worktrees/{worktree}/preview/{node}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def preview(
        worktree: str,
        node: str,
        environment: str,
        partition: Annotated[PartitionQuery, Depends()],
        port: str = "result",
        limit: int = 100,
        offset: int = 0,
        search: str = "",
        filter: str = "",
        order: str = "[]",
        method: str = "first",
        rows: int | None = None,
        seed: int = 0,
    ) -> Record:
        try:
            order_values = json.loads(order)
        except ValueError as error:
            raise Problem("Invalid sample order") from error
        sample = Sample(method=method, rows=rows, seed=seed, filter=filter, search=search, order=order_values)
        return engine.preview(
            worktree,
            environment,
            node,
            port,
            limit,
            offset,
            sample,
            partition.context,
        )

    @api.get(
        "/api/worktrees/{worktree}/statistics/{node}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def statistics(
        worktree: str,
        node: str,
        environment: str,
        partition: Annotated[PartitionQuery, Depends()],
        port: str = "result",
    ) -> Record:
        return engine.statistics(worktree, environment, node, port, partition.context)

    @api.post(
        "/api/worktrees/{worktree}/statistics/{node}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def compute_statistics(
        worktree: str,
        node: str,
        environment: str,
        partition: Annotated[PartitionQuery, Depends()],
        port: str = "result",
    ) -> Record:
        return engine.compute_statistics(worktree, environment, node, port, partition.context)

    @api.delete(
        "/api/worktrees/{worktree}/statistics/{node}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def cancel_statistics(
        worktree: str,
        node: str,
        environment: str,
        partition: Annotated[PartitionQuery, Depends()],
        port: str = "result",
    ) -> Record:
        return engine.cancel_statistics(worktree, environment, node, port, partition.context)

    @api.get(
        "/api/worktrees/{worktree}/test-rows/{node}/{test}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def test_rows(
        worktree: str,
        node: str,
        test: str,
        environment: str,
        partition: Annotated[PartitionQuery, Depends()],
        limit: int = 100,
        offset: int = 0,
    ) -> Record:
        return engine.test_rows(
            worktree,
            environment,
            node,
            test,
            limit,
            offset,
            partition.context,
        )

    @api.get(
        "/api/worktrees/{worktree}/generations/{identity}",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def generation(worktree: str, identity: str, environment: str) -> Record:
        return {"valid": engine.generation_valid(worktree, environment, identity)}

    @api.post(
        "/api/worktrees/{worktree}/lineage",
        response_model=None,
        dependencies=[Depends(worktree_role("reader"))],
    )
    def explain(worktree: str, data: schemas.Explain) -> Record:
        return services.lineage.explain(
            worktree,
            data.environment,
            data.dataset,
            data.row,
            data.column,
            data.offset,
            data.group,
            data.context,
            partition_context=data.partition_context,
            page_size=data.page_size,
            operand=data.operand,
        )

    return api
