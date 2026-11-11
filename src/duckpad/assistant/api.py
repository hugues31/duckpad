"""Authenticated assistant endpoints; the application middleware validates every session."""

from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from ..api.security import instance_admin
from .actions import UndoRequest
from .approvals import ApprovalRequest
from .config import ConnectionCheck, ProviderSettings, Settings
from .service import Assistant, Rename, TurnRequest
from .tools import PageContext


def router(assistant: Assistant):
    routes = APIRouter(prefix="/api/assistant")
    configuration = assistant.configuration

    @routes.get("/options")
    def options():
        return configuration.options()

    @routes.get("/settings", dependencies=[Depends(instance_admin)])
    def settings(request: Request):
        return configuration.public()

    @routes.put("/settings", dependencies=[Depends(instance_admin)])
    def save_settings(request: Request, data: Settings):
        return configuration.save(data)

    @routes.post("/test", dependencies=[Depends(instance_admin)])
    async def test(request: Request, check: ConnectionCheck | None = None):
        return await configuration.test(check)

    @routes.post("/models", dependencies=[Depends(instance_admin)])
    async def discover(request: Request, provider: ProviderSettings):
        """List the models of unsaved provider settings, reusing the saved key when allowed."""
        return await configuration.discover(await run_in_threadpool(configuration.draft, provider))

    @routes.get("/conversations")
    def conversations(request: Request, offset: int = Query(default=0, ge=0)):
        return assistant.list(request.state.user, offset)

    @routes.post("/conversations")
    def create(request: Request, context: PageContext):
        return assistant.create(request.state.user, context)

    @routes.get("/conversations/{identity}")
    def get(request: Request, identity: str):
        return assistant.public(assistant.owned(request.state.user, identity))

    @routes.patch("/conversations/{identity}")
    def rename(request: Request, identity: str, data: Rename):
        return assistant.rename(request.state.user, identity, data.title)

    @routes.delete("/conversations/{identity}")
    def delete(request: Request, identity: str):
        return assistant.delete(request.state.user, identity)

    @routes.post("/conversations/{identity}/stop")
    def stop(request: Request, identity: str):
        return assistant.stop(request.state.user, identity)

    @routes.post("/conversations/{identity}/undo")
    def undo(request: Request, identity: str, data: UndoRequest):
        return assistant.actions.undo(request.state.user, identity, data)

    @routes.post("/conversations/{identity}/approvals")
    def approve(request: Request, identity: str, data: ApprovalRequest):
        from ..api.http import session_token

        stream, cancellation = assistant.approvals.decide(
            request.state.user, session_token(request), identity, data
        )
        return StreamingResponse(
            stream,
            media_type="application/x-ndjson",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"},
            background=BackgroundTask(assistant.release, identity, cancellation),
        )

    @routes.post("/conversations/{identity}/messages")
    def message(request: Request, identity: str, data: TurnRequest):
        from ..api.http import session_token

        stream, cancellation = assistant.prepare(request.state.user, session_token(request), identity, data)
        return StreamingResponse(
            stream,
            media_type="application/x-ndjson",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"},
            background=BackgroundTask(assistant.release, identity, cancellation),
        )

    return routes
