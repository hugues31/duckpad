"""The single-process entry point owns live DuckDB execution contexts."""

import argparse
import os
import shutil
import threading
import webbrowser
from pathlib import Path

import uvicorn
from filelock import FileLock, Timeout

from .app import create_app
from .logging import server_log_config


def main():
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
        "--log-level",
        choices=("critical", "error", "warning", "info", "debug"),
        default="info",
        help="Server log level (default: info); debug includes successful UI polling requests",
    )
    args = parser.parse_args()
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
    app = create_app(args.home)
    print(f"Duckpad · http://{args.host}:{args.port}", flush=True)
    if app.state.auth.initial_password:
        print(
            f"Initial administrator login: admin\nPassword: {app.state.auth.initial_password}\nSave this password. It will not be displayed again.",
            flush=True,
        )
    if not args.no_browser:
        timer = threading.Timer(1.0, lambda: webbrowser.open(f"http://{args.host}:{args.port}"))
        timer.daemon = True
        timer.start()
    try:
        uvicorn.run(
            app, host=args.host, port=args.port, log_level=args.log_level, log_config=server_log_config()
        )
    finally:
        lease.release()


if __name__ == "__main__":
    main()
