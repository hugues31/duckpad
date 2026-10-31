"""Authenticated assistant endpoints; the application middleware validates every session."""

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from .actions import UndoRequest
from .approvals import ApprovalRequest
from .config import Settings
from .service import Assistant, Rename, TurnRequest
from .tools import PageContext


def router(assistant: Assistant):
    routes = APIRouter(prefix="/api/assistant")
    configuration = assistant.configuration

    @routes.get("/options")
    def options():
        return configuration.options()

    @routes.get("/settings")
    def settings(request: Request):
        assistant.services.engine.access.instance_admin(request.state.user)
        return configuration.public()

    @routes.put("/settings")
    def save_settings(request: Request, data: Settings):
        assistant.services.engine.access.instance_admin(request.state.user)
        return configuration.save(data)

    @routes.post("/test")
    async def test(request: Request):
        assistant.services.engine.access.instance_admin(request.state.user)
        return await configuration.test()

    @routes.get("/models/{provider}")
    async def models(request: Request, provider: str):
        assistant.services.engine.access.instance_admin(request.state.user)
        return await configuration.models(provider)

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
        from ..app import session_token

        stream, cancellation = assistant.approvals.decide(
            request.state.user, session_token(request), identity, data
        )
        return StreamingResponse(
            stream,
            media_type="application/x-ndjson",
            background=BackgroundTask(assistant.release, identity, cancellation),
        )

    @routes.post("/conversations/{identity}/messages")
    def message(request: Request, identity: str, data: TurnRequest):
        from ..app import session_token

        stream, cancellation = assistant.prepare(request.state.user, session_token(request), identity, data)
        return StreamingResponse(
            stream,
            media_type="application/x-ndjson",
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"},
            background=BackgroundTask(assistant.release, identity, cancellation),
        )

    return routes
