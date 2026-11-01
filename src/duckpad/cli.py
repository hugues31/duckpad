"""The single-process server owns live DuckDB execution contexts; `duckpad run` is an API client."""

import argparse
import os
import shutil
import sys
import threading
import webbrowser
from pathlib import Path

from . import client

LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")


def main():
    if sys.argv[1:2] == ["run"]:
        # Dispatch before the server's imports: schedulers start this command for every task.
        sys.exit(client.main(sys.argv[2:]))
    parser = argparse.ArgumentParser(prog="duckpad", description="Local SQL pipelines with cell lineage")
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start", help="Start the local workspace")
    start.add_argument(
        "--home",
        type=Path,
        default=Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "duckpad",
    )
    start.add_argument("--host", default="127.0.0.1")
    start.add_argument("--port", type=int, default=8765)
    start.add_argument("--no-browser", action="store_true")
    start.add_argument(
        "--trusted-local",
        action="store_true",
        help="Run trusted SQL without OS isolation (single-user, loopback only)",
    )
    start.add_argument(
        "--log-level",
        choices=("critical", "error", "warning", "info", "debug"),
        default="info",
        help="Server log level (default: info); debug includes successful UI polling requests",
    )
    # Listed for `duckpad --help`; the client parses its own options.
    commands.add_parser(
        "run", help="Launch a Job, wait for its outcome and exit with its code", add_help=False
    )
    args = parser.parse_args()
    start_server(parser, args)


def start_server(parser, args):
    import uvicorn
    from filelock import FileLock, Timeout

    from .app import create_app
    from .logging import server_log_config
    from .util import Problem

    if args.trusted_local and args.host not in LOOPBACK_HOSTS:
        parser.error("--trusted-local requires --host 127.0.0.1, ::1, or localhost")
    if not shutil.which("git"):
        parser.error("Git is required. Install Git for your operating system and run duckpad start again.")
    args.home.mkdir(parents=True, exist_ok=True, mode=0o700)
    lease = FileLock(args.home / "instance.lock")
    try:
        lease.acquire(timeout=0)
    except Timeout:
        parser.error(
            "This Duckpad instance is already running. Open its browser window or choose another --home."
        )
    try:
        try:
            app = create_app(args.home, trusted_local=args.trusted_local)
        except Problem as error:
            parser.error(str(error))
        print(f"Duckpad · http://{args.host}:{args.port}", flush=True)
        if args.trusted_local:
            print(
                "Trusted local mode: SQL runs without OS isolation, with your operating-system permissions. "
                "Use only trusted projects on your own computer; do not share or proxy this instance.",
                flush=True,
            )
        if args.host not in LOOPBACK_HOSTS and not os.environ.get("FORWARDED_ALLOW_IPS"):
            print(
                "FORWARDED_ALLOW_IPS is not set. Behind a reverse proxy on another host or container, "
                "set it to the proxy address; otherwise all users share the proxy's login attempt limit.",
                flush=True,
            )
        if app.state.auth.initial_password:
            print(
                f"Initial administrator login: admin\nPassword: {app.state.auth.initial_password}\nSave this password. It will not be displayed again.",
                flush=True,
            )
        if not args.no_browser:
            timer = threading.Timer(1.0, lambda: webbrowser.open(f"http://{args.host}:{args.port}"))
            timer.daemon = True
            timer.start()
        uvicorn.run(
            app,
            host=args.host,
            port=args.port,
            log_level=args.log_level,
            log_config=server_log_config(args.log_level),
        )
    finally:
        lease.release()


if __name__ == "__main__":
    main()
