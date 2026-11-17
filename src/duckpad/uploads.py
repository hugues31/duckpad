"""Upload admission before multipart parsing can spool files to disk."""

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request

from .util import Problem


def limited_body(max_bytes: int, kind: str = "upload") -> Callable[[Request], Coroutine[Any, Any, None]]:
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
            raise Problem(f"Send the {kind} with a Content-Length header", 411)
        length = lengths[0].lstrip("0")
        # A longer digit string is larger, and int() refuses strings of thousands of digits.
        if len(length) > len(str(max_bytes)) or int(length or 0) > max_bytes:
            unit = next(
                (u for u in ((1024**3, "GiB"), (1024**2, "MiB")) if max_bytes % u[0] == 0), (1024, "KiB")
            )
            raise Problem(f"{kind.capitalize()}s are limited to {max_bytes // unit[0]} {unit[1]}", 413)

    return check
