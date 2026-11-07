"""Upload admission before multipart parsing can spool files to disk."""

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request

from .util import Problem


def limited_body(max_bytes: int) -> Callable[[Request], Coroutine[Any, Any, None]]:
    """Require a bounded request body before any endpoint reads its multipart form.

    Endpoints must accept Request rather than File/Form parameters: FastAPI parses those
    parameters before running dependencies. HTTP framing enforces the declared length.
    """

    async def check(request: Request) -> None:
        lengths = request.headers.getlist("content-length")
        if (
            len(lengths) != 1
            or not lengths[0].isascii()
            or not lengths[0].isdigit()
            or "transfer-encoding" in request.headers
        ):
            raise Problem("Send the upload with a Content-Length header", 411)
        if int(lengths[0]) > max_bytes:
            raise Problem(f"Uploads are limited to {max_bytes // (1024 * 1024)} MiB", 413)

    return check
