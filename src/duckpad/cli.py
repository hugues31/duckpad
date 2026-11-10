"""The single-process server owns live DuckDB execution contexts; `duckpad run` is an API client."""

import argparse
import os
import shutil
import sys
import threading
import webbrowser
from pathlib import Path

from . import __version__, client

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
        # Dispatch before the server's imports: schedulers start this command for every task.
        sys.exit(client.main(sys.argv[2:]))
    parser = argparse.ArgumentParser(prog="duckpad", description="Local SQL pipelines with cell lineage")
    parser.add_argument("--version", action="version", version=f"Duckpad {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version", help="Print the installed Duckpad version")
    paths = commands.add_parser("paths", help="Locate instance configuration and state without opening it")
    paths.add_argument(
        "--home", type=Path, default=default_home(), help="Instance directory used by duckpad start"
    )
    paths.add_argument("--json", action="store_true", help="Print paths as JSON")
    backup = commands.add_parser(
        "backup",
        help="Back up a stopped instance to a private .tar.gz archive",
        description="Back up a stopped instance, including its database, projects and local master key. "
        "External data and externally supplied keys must be backed up separately.",
    )
    backup.add_argument("destination", type=Path, help="New archive outside the instance directory")
    backup.add_argument(
        "--home", type=Path, default=default_home(), help="Instance directory used by duckpad start"
    )
    start = commands.add_parser("start", help="Start the local workspace")
    start.add_argument("--home", type=Path, default=default_home())
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
    reset = commands.add_parser(
        "reset-password",
        help="Give a local account a new password, for example a lost admin password",
        description="Print a new generated password for a local account and sign out its sessions. "
        "It works while Duckpad is running.",
    )
    reset.add_argument("username", nargs="?", default="admin", help="Account to reset (default: admin)")
    reset.add_argument(
        "--home", type=Path, default=default_home(), help="Instance directory used by duckpad start"
    )
    args = parser.parse_args()
    if hasattr(args, "home"):
        args.home = args.home.expanduser().resolve()
    if args.command == "version":
        print(f"Duckpad {__version__}")
    elif args.command == "paths":
        from .backup import print_paths

        print_paths(args.home, as_json=args.json)
    elif args.command == "backup":
        from .backup import BackupError, create_backup

        try:
            destination = create_backup(args.home, args.destination)
        except (BackupError, OSError) as error:
            backup.error(str(error))
        print(f"Backup saved to {destination}")
        print("Keep this archive private: it includes stored credentials and any local master key.")
        print("Back up externally supplied master keys, secrets and source data separately.")
    elif args.command == "reset-password":
        reset_password(reset, args)
    else:
        start_server(parser, args)


def reset_command(home):
    """The reset command for this instance, with --home only when it is not the default."""
    if home == default_home():
        return "duckpad reset-password"
    # Double quotes keep a path with spaces in one argument in POSIX shells, PowerShell and cmd.
    quoted = f'"{home}"' if any(c.isspace() for c in str(home)) else home
    return f"duckpad reset-password --home {quoted}"


def reset_password(parser, args):
    from .auth import reset_password as reset
    from .store import Store
    from .util import Problem

    # Never create an instance here: a mistyped --home would only print a useless password.
    if not (args.home / "instance.sqlite").is_file():
        parser.error(
            f"No Duckpad instance in {args.home}. Pass the --home directory used with duckpad start."
        )
    try:
        store = Store(args.home)
    except Problem as error:
        parser.error(str(error))
    try:
        username, password = reset(store, args.username)
    except Problem as error:
        parser.error(str(error))
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
    finally:
        lease.release()


if __name__ == "__main__":
    main()
