"""Print a systemd unit for this Python installation; never install or start it."""

import sys
from pathlib import Path

from .util import Problem


def quote_unit_argument(value):
    value = str(value)
    if any(ord(character) < 32 for character in value):
        raise Problem("Service paths and options cannot contain control characters.")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'


def render_unit(args):
    if sys.platform != "linux":
        raise Problem(
            "service-unit generates a systemd user service on Linux. Use your platform's service manager."
        )
    # Preserve a virtual environment's symlink: resolving it can select the system Python.
    command = [
        Path(sys.executable).absolute(),
        "-m",
        "duckpad",
        "start",
        "--home",
        args.home,
        "--host",
        args.host,
        "--port",
        args.port,
        "--log-level",
        args.log_level,
        "--no-browser",
    ]
    if args.trusted_local:
        command.append("--trusted-local")
    invocation = " ".join(quote_unit_argument(value) for value in command)
    return (
        "[Unit]\nDescription=Duckpad workspace\n\n[Service]\nType=exec\n"
        f"ExecStart={invocation}\nRestart=on-failure\nRestartSec=5\n"
        "TimeoutStopSec=120\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n\n"
        "[Install]\nWantedBy=default.target\n"
    )
