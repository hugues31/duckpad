"""Stdio MCP adapter and validation CLI; only the running server owns DuckDB and project files."""

import argparse
import asyncio
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .client import LOCAL_SERVER


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
                    return self.error(value.get("error", "Request refused"), response.status_code)
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
        return await self.request("POST", "/tools/" + name, arguments)


def server(remote):
    from mcp.server.lowlevel import Server
    from mcp.types import CallToolResult, TextContent, Tool

    app = Server("duckpad")

    @app.list_tools()
    async def listing():
        result = await remote.request("GET", "/tools")
        if not isinstance(result, list):
            raise ValueError("Cannot discover Duckpad tools. Check the server and API token.")
        return [Tool.model_validate(tool) for tool in result]

    # The application validates arguments and supplies structured, redacted errors. SDK validation
    # would quote the original (possibly sensitive) invalid arguments into the error message.
    @app.call_tool(validate_input=False)
    async def call(name, arguments):
        result = await remote.call(name, arguments)
        return CallToolResult(
            content=[TextContent(type="text", text=json.dumps(result))],
            structuredContent=result,
            isError=not result.get("ok", False),
        )

    return app


async def serve(remote):
    from mcp.server.stdio import stdio_server

    app = server(remote)
    async with stdio_server() as (read, write):
        await app.run(read, write, app.create_initialization_options())


def main(command, argv=None):
    parser = argparse.ArgumentParser(prog=f"duckpad {command}")
    parser.add_argument("--server", default=os.environ.get("DUCKPAD_SERVER", LOCAL_SERVER))
    parser.add_argument("--token-file", type=Path)
    if command == "validate":
        parser.add_argument("worktree")
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
        asyncio.run(serve(remote))
        return 0
    result = asyncio.run(remote.call("validate_project", {"worktree": args.worktree}))
    print(json.dumps(result))
    return (0 if result["result"]["valid"] else 1) if result.get("ok") else 2
