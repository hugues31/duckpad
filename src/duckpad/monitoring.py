"""Bounded, process-local diagnostics for instance administrators."""

import logging
import re
import time
from collections import deque
from contextlib import contextmanager, suppress
from datetime import UTC, datetime

import psutil

from . import __version__
from .resources import resource_usage

LOG_CAPACITY = 1000
MESSAGE_LIMIT = 4000
LOGGERS = ("duckpad", "duckpad.execution", "duckpad.assistant", "uvicorn", "uvicorn.access")
SECRET_FIELD = re.compile(
    r"""(?ix)(\b(?:password|passwd|client_secret|api[_-]?key|access_token|refresh_token|token|secret)\b
    ["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)"""
)
AUTH_HEADER = re.compile(
    r"""(?im)\b(authorization|proxy-authorization|cookie|set-cookie)["']?\s*:\s*[^\r\n]+"""
)
BEARER = re.compile(r"(?i)\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+")
URL_CREDENTIALS = re.compile(r"(\w+://)[^\s/@]+:[^\s/@]+@")
URL_QUERY = re.compile(r"""(https?://[^\s?\#"'<>]+)[?\#][^\s"'<>]*""")


def redact_log(text):
    """Mask common credential forms; user-authored messages still require admin access."""
    text = AUTH_HEADER.sub(r"\1: [redacted]", text)
    text = BEARER.sub(r"\1 [redacted]", text)
    text = URL_CREDENTIALS.sub(r"\1[redacted]@", text)
    text = URL_QUERY.sub(r"\1?[redacted]", text)
    return SECRET_FIELD.sub(r"\1[redacted]", text)


class RecentLogs(logging.Handler):
    def __init__(self):
        super().__init__()
        self.entries = deque(maxlen=LOG_CAPACITY)
        self.sequence = 0

    def emit(self, record):
        try:
            if record.name == "uvicorn.access" and isinstance(record.args, tuple) and len(record.args) == 5:
                _, method, target, _, status = record.args
                path = str(target).partition("?")[0]
                # Viewing diagnostics must never fill the buffer with its own polling requests.
                if path in ("/api/monitoring", "/api/monitoring/logs") and 200 <= int(status) < 300:
                    return
                message = f"{method} {path} {status}"
            else:
                message = self.format(record)
            message = redact_log(message)
            self.sequence += 1
            self.entries.append(
                {
                    "id": self.sequence,
                    "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
                    "level": record.levelname.lower(),
                    "level_number": record.levelno,
                    "logger": record.name[:200],
                    "message": message[:MESSAGE_LIMIT],
                    "truncated": len(message) > MESSAGE_LIMIT,
                }
            )
        except Exception:
            # Diagnostics must not turn a logging/formatting failure into an application failure.
            return

    def snapshot(self, level="debug", query="", limit=200):
        self.acquire()
        try:
            entries = list(reversed(self.entries))
        finally:
            self.release()
        minimum = getattr(logging, level.upper())
        query = query.casefold()
        matches = [
            entry
            for entry in entries
            if entry["level_number"] >= minimum
            and query in f"{entry['message']} {entry['logger']}".casefold()
        ]
        return {
            "entries": matches[:limit],
            "matched": len(matches),
            "retained": len(entries),
            "capacity": LOG_CAPACITY,
        }

    @contextmanager
    def capture(self):
        loggers = [logging.getLogger(name) for name in LOGGERS]
        # With an embedded server, these loggers may still propagate to their parent.
        # Attach only where records would otherwise stop, avoiding duplicate entries.
        attached = [
            logger for logger in loggers if logger.name in ("duckpad", "uvicorn") or not logger.propagate
        ]
        for logger in attached:
            logger.addHandler(self)
        try:
            yield
        finally:
            for logger in attached:
                logger.removeHandler(self)
            self.close()


class Monitoring:
    def __init__(self, home):
        self.home = home
        self.started = time.monotonic()
        self.logs = RecentLogs()

    def snapshot(self):
        disk = None
        try:
            usage = psutil.disk_usage(str(self.home))
            if usage.total > 0:
                disk = {"total_bytes": usage.total, "free_bytes": usage.free, "used_bytes": usage.used}
        except (OSError, psutil.Error, NotImplementedError):
            pass
        process_memory = None
        with suppress(OSError, psutil.Error, NotImplementedError):
            process_memory = psutil.Process().memory_info().rss
        return {
            "sampled_at": datetime.now(UTC).isoformat(),
            "version": __version__,
            "uptime_seconds": max(0, time.monotonic() - self.started),
            "disk": disk,
            "process_memory_bytes": process_memory,
            "resources": resource_usage(),
        }
