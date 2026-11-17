"""MCP over the agent API: Streamable HTTP served by Duckpad, a stdio bridge and `duckpad validate`.

Only the running server owns DuckDB and project files. Both transports expose the same tools: the
endpoint calls the agent API in process, the bridge forwards each call to it over HTTPS.
"""

import argparse
import asyncio
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from . import __version__
from .client import LOCAL_SERVER

# Sent to the client when it connects; agents read it before choosing tools.
INSTRUCTIONS = (
    "Duckpad tools inspect and edit data-flow projects on a Duckpad server, within the permissions "
    "of the API token. Start with list_projects and read_guide. Edit on a branch from create_branch: "
    "pass the revision returned by validate_project or by the previous edit, then validate again. "
    "Every run needs a human decision: request_run returns a review_path on the same Duckpad server; "
    "ask a signed-in Duckpad editor to open it, poll read_approval, then call launch_approved_run. "
    "Never ask for, store or print credentials."
)


def server(listing, call):
    """An MCP server whose tools come from `listing()` and run through `call(name, arguments)`."""
    from mcp.server.lowlevel import Server
    from mcp.types import CallToolResult, TextContent, Tool

    app = Server("duckpad", version=__version__, instructions=INSTRUCTIONS)

    @app.list_tools()
    async def tools():
        result = await listing()
        if not isinstance(result, list):
            raise ValueError("Cannot discover Duckpad tools. Check the server and API token.")
        return [Tool.model_validate(tool) for tool in result]

    # The application validates arguments and supplies structured, redacted errors. SDK validation
    # would quote the original (possibly sensitive) invalid arguments into the error message.
    @app.call_tool(validate_input=False)
    async def tool(name, arguments):
        result = await call(name, arguments or {})
        return CallToolResult(
            content=[TextContent(type="text", text=json.dumps(result))],
            structuredContent=result,
            isError=not result.get("ok", False),
        )

    return app


async def serve_http(app, scope, receive, send):
    """Answer one Streamable HTTP request statelessly: a JSON response, no session, no server push."""
    import anyio
    from mcp.server.streamable_http import StreamableHTTPServerTransport

    transport = StreamableHTTPServerTransport(mcp_session_id=None, is_json_response_enabled=True)

    async def run(*, task_status=anyio.TASK_STATUS_IGNORED):
        async with transport.connect() as (read, write):
            task_status.started()
            await app.run(read, write, app.create_initialization_options(), stateless=True)

    async with anyio.create_task_group() as tasks:
        await tasks.start(run)
        try:
            await transport.handle_request(scope, receive, send)
        finally:
            # The server task ends with its transport, also when the client went away.
            with anyio.CancelScope(shield=True):
                await transport.terminate()


class Remote:
    def __init__(self, server, token):
        self.server, self.token = server.rstrip("/"), token

    async def request(self, method, path, body=None):
        # Mutations are deliberately not retried and redirects never forward credentials.
        try:
            async with (
                httpx.AsyncClient(
                    headers={"Authorization": f"Bearer {self.token}"}, timeout=60, follow_redirects=False
                ) as client,
                client.stream(method, self.server + "/api/agent" + path, json=body) as response,
            ):
                chunks, size = [], 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > 2 * 1024 * 1024:
                        return self.error("Response exceeds the client limit", 413)
                    chunks.append(chunk)
                if response.is_redirect:
                    return self.error(
                        "Redirect refused. Configure the final Duckpad server URL.", response.status_code
                    )
                value = json.loads(b"".join(chunks))
                if response.is_error:
                    message = value.get("error") if isinstance(value, dict) else None
                    return self.error(message or "Request refused", response.status_code)
                # The API already redacts connection secrets; also mask the bearer itself.
                text = json.dumps(value).replace(json.dumps(self.token)[1:-1], "[redacted]")
                return json.loads(text)
        except (httpx.HTTPError, ValueError):
            return self.error(
                "Cannot reach Duckpad or read its JSON response. Check the server address and connection.",
                502,
            )

    @staticmethod
    def error(message, status):
        return {
            "ok": False,
            "error": {"code": "transport_error", "status": status, "message": message, "details": None},
        }

    async def call(self, name, arguments):
        if not re.fullmatch(r"[a-z_]+", name):
            return self.error("Unknown tool name", 404)
        result = await self.request("POST", "/tools/" + name, arguments)
        receipt = result.get("result")
        if isinstance(receipt, dict) and isinstance(receipt.get("review_path"), str):
            # The bridge knows the server address: give the human a link to open.
            receipt["review_url"] = self.server + receipt["review_path"]
        return result


async def serve_stdio(remote):
    from mcp.server.stdio import stdio_server

    app = server(lambda: remote.request("GET", "/tools"), remote.call)
    async with stdio_server() as (read, write):
        await app.run(read, write, app.create_initialization_options())


def main(command, argv=None):
    parser = argparse.ArgumentParser(
        prog=f"duckpad {command}",
        description="Bridge an MCP client over stdio to a running Duckpad server"
        if command == "mcp"
        else "Validate a branch's definitions on a running Duckpad server, without executing them",
    )
    parser.add_argument(
        "--server",
        default=os.environ.get("DUCKPAD_SERVER", LOCAL_SERVER),
        help=f"Duckpad URL (default: DUCKPAD_SERVER, otherwise {LOCAL_SERVER})",
    )
    parser.add_argument(
        "--token-file", type=Path, help="File holding a Duckpad API token (default: DUCKPAD_TOKEN)"
    )
    if command == "validate":
        parser.add_argument(
            "worktree", help="Branch worktree ID: the worktree_... segment of its Duckpad page URL"
        )
    args = parser.parse_args(argv)
    location = urlsplit(args.server)
    if (
        location.scheme not in ("http", "https")
        or not location.hostname
        or location.username
        or location.password
        or location.query
        or location.fragment
        or (location.scheme == "http" and location.hostname not in ("localhost", "127.0.0.1", "::1"))
    ):
        parser.error(
            "Use HTTPS for remote servers, or HTTP on localhost, without URL credentials or query parameters"
        )
    try:
        token = (
            args.token_file.read_text(encoding="utf-8").strip()
            if args.token_file
            else os.environ.get("DUCKPAD_TOKEN", "").strip()
        )
    except (OSError, ValueError):
        parser.error("Cannot read the API token file")
    if not re.fullmatch(r"dpk_[A-Za-z0-9_-]+", token):
        parser.error("Set DUCKPAD_TOKEN or --token-file to a Duckpad API token")
    remote = Remote(args.server, token)
    if command == "mcp":
        asyncio.run(serve_stdio(remote))
        return 0
    result = asyncio.run(remote.call("validate_project", {"worktree": args.worktree}))
    print(json.dumps(result))
    return (0 if result["result"]["valid"] else 1) if result.get("ok") else 2
