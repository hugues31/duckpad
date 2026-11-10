"""The single-process server owns live DuckDB execution contexts; `duckpad run` is an API client."""

import argparse
import os
import shutil
import sys
import threading
import webbrowser
from pathlib import Path

from . import __version__, client
from .paths import InstancePaths

LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")
WILDCARD_HOSTS = ("0.0.0.0", "::", "")


def default_home():
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "duckpad"


def browser_url(host, port):
    """The address to open on the server's own computer, even when it listens on every interface."""
    host = "127.0.0.1" if host in WILDCARD_HOSTS else host
    return f"http://[{host}]:{port}" if ":" in host else f"http://{host}:{port}"


def main():
    if sys.argv[1:2] == ["run"]:
        # Schedulers keep the Job client's existing exit-code contract.
        sys.exit(client.main(sys.argv[2:]))
    parser = argparse.ArgumentParser(prog="duckpad", description="Local SQL pipelines with cell lineage")
    parser.add_argument("--version", action="version", version=f"Duckpad {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start", help="Start the local workspace")
    server_options(start)
    start.add_argument("--no-browser", action="store_true")
    commands.add_parser(
        "run", help="Launch a Job, wait for its outcome and exit with its code", add_help=False
    )
    info = commands.add_parser("info", help="Show versions, platform and instance configuration")
    home_option(info)
    info.add_argument("--json", action="store_true", help="Print diagnostics as JSON")
    backup = commands.add_parser("backup", help="Back up a stopped instance")
    home_option(backup)
    backup.add_argument(
        "destination",
        nargs="?",
        help="Archive filename or directory (default: timestamped archive in the current directory)",
    )
    backup.add_argument(
        "--include-python-cache", action="store_true", help="Include rebuildable Python caches"
    )
    restore = commands.add_parser(
        "restore", help="Restore a backup to its original, empty instance directory"
    )
    restore.add_argument("archive", type=Path)
    restore.add_argument("--home", type=Path, help="Must match the original instance path in the backup")
    reset = commands.add_parser("reset-password", help="Generate a new password for a local account")
    home_option(reset)
    reset.add_argument("username", nargs="?", default="admin", help="Account to reset (default: admin)")
    service = commands.add_parser("service-unit", help="Print a Linux systemd user unit; does not install it")
    server_options(service)
    args = parser.parse_args()
    from .util import Problem

    try:
        if getattr(args, "home", None) is not None:
            args.home = args.home.expanduser().resolve()
        if args.command == "info":
            from .instance import print_info

            print_info(args.home, as_json=args.json)
        elif args.command == "backup":
            from .backup import create_backup

            destination = create_backup(
                args.home, args.destination, include_python_cache=args.include_python_cache
            )
            print(f"Backup saved to {destination} ({destination.stat().st_size:,} bytes)")
            print("Private, unencrypted archive. Keep external keys, secrets and source data separately.")
        elif args.command == "restore":
            from .backup import restore_backup

            home = restore_backup(args.archive, args.home)
            print(f"Instance restored to {home}")
            print("Provide any external keys and secrets before starting Duckpad.")
        elif args.command == "reset-password":
            reset_password(args)
        elif args.command == "service-unit":
            validate_server_options(parser, args)
            from .service_unit import render_unit

            print(render_unit(args), end="")
        else:
            start_server(parser, args)
    except (Problem, OSError) as error:
        message = str(error)
        if isinstance(error, OSError) and error.strerror:
            message = error.strerror + (f": {error.filename}" if error.filename else "")
        parser.exit(1, f"duckpad: {message}\n")


def home_option(parser):
    parser.add_argument(
        "--home", type=Path, default=default_home(), help="Instance directory used by duckpad start"
    )


def server_options(parser):
    home_option(parser)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--trusted-local",
        action="store_true",
        help="Run trusted SQL without OS isolation (single-user, loopback only)",
    )
    parser.add_argument(
        "--log-level",
        choices=("critical", "error", "warning", "info", "debug"),
        default="info",
        help="Server log level (default: info)",
    )


def validate_server_options(parser, args):
    if args.trusted_local and args.host not in LOOPBACK_HOSTS:
        parser.error("--trusted-local requires --host 127.0.0.1, ::1, or localhost")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")


def reset_command(home):
    """The reset command for this instance, with --home only when it is not the default."""
    if home == default_home():
        return "duckpad reset-password"
    # Double quotes keep a path with spaces in one argument in POSIX shells, PowerShell and cmd.
    quoted = f'"{home}"' if any(c.isspace() for c in str(home)) else home
    return f"duckpad reset-password --home {quoted}"


def reset_password(args):
    from .auth import reset_password as reset
    from .store import Store
    from .util import Problem

    # Never create an instance here: a mistyped --home would only print a useless password.
    if not InstancePaths(args.home).database.is_file():
        raise Problem(
            f"No Duckpad instance in {args.home}. Pass the --home directory used with duckpad start."
        )
    store = Store(args.home)
    try:
        username, password = reset(store, args.username)
    finally:
        store.close()
    print(
        f"New password for {username}:\n\n    {password}\n\n"
        "Sign in with it, then choose your own in User settings → Change password. "
        f"Every session of {username} is now signed out.",
        flush=True,
    )


def start_server(parser, args):
    import uvicorn

    from .app import create_app
    from .instance import instance_lease
    from .logging import server_log_config
    from .util import Problem

    validate_server_options(parser, args)
    if not shutil.which("git"):
        raise Problem("Git is required. Install Git for your operating system and run duckpad start again.")
    with instance_lease(args.home, create=True):
        app = create_app(args.home, trusted_local=args.trusted_local)
        address = browser_url(args.host, args.port)
        print(f"Duckpad · {address}", flush=True)
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
        if args.host not in LOOPBACK_HOSTS and not app.state.services.store.keys.external:
            print(
                "The master key that encrypts stored secrets is in the instance directory, next to the "
                "database it protects: a copy of the directory exposes them. Provide the key with "
                "DUCKPAD_MASTER_KEY_FILE, for example as a Docker or Kubernetes secret.",
                flush=True,
            )
        target = address
        if app.state.auth.initial_password:
            # A fragment never reaches the server or its access log; the page removes it.
            target = f"{address}/#setup={app.state.auth.setup_token}"
            opening = "" if args.no_browser else " (it opens by itself)"
            print(
                f"\nFirst launch: choose the administrator's password in your browser{opening}:"
                f"\n\n    {target}\n\n"
                "You can also sign in right away:\n"
                f"Username: admin\nPassword: {app.state.auth.initial_password}\n\n"
                f"This password is shown only once. If you lose it, run: {reset_command(args.home)}\n",
                flush=True,
            )
        if not args.no_browser:
            timer = threading.Timer(1.0, lambda: webbrowser.open(target))
            timer.daemon = True
            timer.start()
        uvicorn.run(
            app,
            host=args.host,
            port=args.port,
            log_level=args.log_level,
            log_config=server_log_config(args.log_level),
        )


if __name__ == "__main__":
    main()
