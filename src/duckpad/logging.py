"""Keep successful UI polling out of the default Uvicorn access log."""

import logging
import re
from copy import deepcopy

from uvicorn.config import LOGGING_CONFIG

POLLING_PATH = re.compile(r"/api/(?:resources|workspace|worktrees/[^/]+(?:/status|/generations/[^/]+)?)")


class PollingAccessFilter(logging.Filter):
    def filter(self, record):
        # Uvicorn supplies client, method, path with query, HTTP version, and status.
        args = record.args
        if (
            isinstance(args, tuple)
            and len(args) == 5
            and isinstance(args[2], str)
            and args[2].partition("?")[0] == "/api/oidc/callback"
        ):
            record.args = (*args[:2], "/api/oidc/callback", *args[3:])
            args = record.args
        if record.levelno == logging.INFO and isinstance(args, tuple) and len(args) == 5:
            _, method, target, _, status = args
            if (
                method == "GET"
                and isinstance(target, str)
                and isinstance(status, int)
                and 200 <= status < 300
                and POLLING_PATH.fullmatch(target.partition("?")[0])
            ):
                record.levelno = logging.DEBUG
                record.levelname = "DEBUG"
                # The logger checked the original INFO level before running filters.
                return logging.getLogger(record.name).isEnabledFor(logging.DEBUG)
        return True


def server_log_config(level="info"):
    """Uvicorn logging, plus node results as JSON lines filtered by the server log level."""
    config = deepcopy(LOGGING_CONFIG)
    config["filters"] = {"polling": {"()": PollingAccessFilter}}
    config["loggers"]["uvicorn.access"]["filters"] = ["polling"]
    config["formatters"]["execution"] = {"format": "%(message)s"}
    config["handlers"]["execution"] = {
        "class": "logging.StreamHandler",
        "formatter": "execution",
        "stream": "ext://sys.stderr",
    }
    config["loggers"]["duckpad.execution"] = {
        "handlers": ["execution"],
        "level": level.upper(),
        "propagate": False,
    }
    return config
