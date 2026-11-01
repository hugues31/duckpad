"""`duckpad run`: launch a Job through the automation API v1 and exit with a code schedulers act on.

The module uses only the standard library and imports neither DuckDB nor the server, so the command
starts quickly and can later move to a separate lightweight package.
"""

import argparse
import http.client
import json
import os
import re
import signal
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import timedelta
from pathlib import Path

from . import __version__

LOCAL_SERVER = "http://127.0.0.1:8765"
SUCCESS, FAILED, PARTIAL_FAILURE, CANCELED, BUSY, REFUSED, TIMEOUT, UNREACHABLE = range(8)
OUTCOMES = {
    "success": SUCCESS,
    "failed": FAILED,
    "partial_failure": PARTIAL_FAILURE,
    "canceled": CANCELED,
    "interrupted": CANCELED,
}
ACTIVE_STATUSES = ("preparing", "running", "canceling")
POLL_SECONDS = 10  # Server-side wait per request: progress appears at least this often.
REQUEST_SECONDS = 30  # Socket timeout on top of the server-side wait.
RETRY_SECONDS = 120  # How long an unreachable or unavailable server is retried.
STOP_SECONDS = 120  # How long a canceled run is given to stop.
DURATION = re.compile(r"(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?")


class Exit(Exception):
    """End the command with an exit code and a message on standard error."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Stop(Exception):
    """Raised by SIGINT and SIGTERM handlers, including during a blocking request."""

    def __init__(self, signum):
        super().__init__(signal.Signals(signum).name)


class Unreachable(Exception):
    pass


class Refused(Exception):
    def __init__(self, status, message, detail):
        super().__init__(message)
        self.status, self.detail = status, detail


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # Exit code 2 means a partial failure to schedulers: usage errors are refused requests.
        self.print_usage(sys.stderr)
        self.exit(REFUSED, f"{self.prog}: error: {message}\n")


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Following a redirect would resend the bearer token, possibly to another host.
        return None


def duration(text):
    match = DURATION.fullmatch(text)
    if text.isdigit():
        seconds = int(text)
    elif text and match:
        days, hours, minutes, rest = (int(group or 0) for group in match.groups())
        seconds = ((days * 24 + hours) * 60 + minutes) * 60 + rest
    else:
        seconds = 0
    if seconds <= 0:
        raise argparse.ArgumentTypeError(f"invalid duration {text!r}; use for example 90m, 2h or 1h30m")
    return seconds


def parser():
    parser = Parser(
        prog="duckpad run",
        description="Launch a Duckpad Job, wait for its outcome and exit with a code schedulers act on.",
        epilog="Exit codes: 0 success, 1 failed, 2 partial failure, 3 canceled or interrupted, "
        "4 Job already running, 5 request refused, 6 timeout, 7 server unreachable.",
    )
    parser.add_argument("--job", required=True, metavar="SLUG", help="Job to launch")
    parser.add_argument(
        "--server",
        help=f"Duckpad URL (default: DUCKPAD_SERVER, otherwise the local instance at {LOCAL_SERVER})",
    )
    parser.add_argument(
        "--token-file",
        type=Path,
        help="File containing the API token (default: the DUCKPAD_TOKEN environment variable)",
    )
    parser.add_argument(
        "--detach", action="store_true", help="Print the run ID once accepted, without waiting"
    )
    parser.add_argument(
        "--timeout", type=duration, help="Cancel the run after this duration, such as 90m or 2h"
    )
    parser.add_argument("--source", default="cli", help="Trigger source recorded on the run (default: cli)")
    parser.add_argument(
        "--reference", help="Trigger reference recorded on the run, such as a scheduler run ID"
    )
    parser.add_argument(
        "--idempotency-key",
        help="Launch key: retrying with the same key returns the same run (default: one per invocation)",
    )
    return parser


class Api:
    def __init__(self, server, token, deadline):
        self.server, self.deadline = server, deadline
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": f"duckpad-run/{__version__}",
        }
        self.opener = urllib.request.build_opener(NoRedirects)

    def call(self, method, path, body=None, headers=None, wait=0.0, text=False):
        """Retry network errors and 5xx responses: every request this client sends is idempotent."""
        data = None if body is None else json.dumps(body).encode()
        headers = {**self.headers, **(headers or {})}
        if data is not None:
            headers["Content-Type"] = "application/json"
        give_up, delay = None, 1
        while True:
            request = urllib.request.Request(self.server + "/api/v1" + path, data, headers, method=method)
            try:
                with self.opener.open(request, timeout=wait + REQUEST_SECONDS) as response:
                    payload = response.read().decode()
                    if text:
                        return payload
                    if response.headers.get_content_type() != "application/json":
                        raise ValueError(f"{response.headers.get_content_type()} instead of JSON")
                    return json.loads(payload)
            except urllib.error.HTTPError as error:
                if error.code < 500:
                    raise self.refused(error) from None
                problem = f"HTTP {error.code}"
            except urllib.error.URLError as error:
                if isinstance(error.reason, ssl.SSLCertVerificationError):
                    raise Unreachable(str(error.reason)) from None
                problem = str(error.reason)
            except (OSError, http.client.HTTPException) as error:
                problem = str(error) or type(error).__name__
            except ValueError as error:
                raise Unreachable(f"unexpected response from {self.server}: {error}") from None
            now = time.monotonic()
            give_up = give_up or now + RETRY_SECONDS
            if now + delay > min(give_up, self.deadline):
                raise Unreachable(problem)
            print(f"Duckpad is unreachable ({problem}); retrying in {delay} s", file=sys.stderr, flush=True)
            time.sleep(delay)
            delay = min(delay * 2, 15)

    @staticmethod
    def refused(error):
        try:
            payload = json.loads(error.read())
            message, detail = payload["error"], payload.get("detail") or {}
        except (ValueError, KeyError, TypeError):
            message, detail = error.reason, {}
        if 300 <= error.code < 400:
            message = f"redirects to {error.headers.get('Location')}; use the final address as the server"
            detail = {"code": "redirect"}
        return Refused(error.code, str(message), detail if isinstance(detail, dict) else {})


def progress(run):
    nodes = run["nodes"]
    counts = [f"{nodes['success']}/{nodes['total']} nodes succeeded"]
    counts += [
        f"{nodes[status]} {status}"
        for status in ("running", "failed", "blocked", "canceled", "interrupted")
        if nodes.get(status)
    ]
    return f"{run['status']}: " + ", ".join(counts)


def finish(api, run):
    """Print the run's text log, whose failure must not hide the outcome."""
    try:
        print(api.call("GET", f"/runs/{run['id']}/log", text=True), end="", flush=True)
    except (Unreachable, Refused, Stop) as error:
        print(f"Cannot read the log of run {run['id']}: {error}", file=sys.stderr, flush=True)


def stop(api, run, code, reason):
    """Request cancellation and wait for the run to stop; a second signal stops waiting."""
    print(f"{reason}: canceling run {run['id']}", file=sys.stderr, flush=True)
    api.deadline = time.monotonic() + STOP_SECONDS
    try:
        run = api.call("POST", f"/runs/{run['id']}/cancel")
        while run["status"] in ACTIVE_STATUSES and (remaining := api.deadline - time.monotonic()) > 0:
            wait = round(min(POLL_SECONDS, remaining), 1)
            run = api.call("GET", f"/runs/{run['id']}?wait={wait}", wait=wait)
    except (Unreachable, Refused) as error:
        raise Exit(code, f"Cannot confirm the cancellation of run {run['id']}: {error}") from None
    except Stop:
        raise Exit(code, f"Stopped waiting; run {run['id']} is still {run['status']}") from None
    if run["status"] in ACTIVE_STATUSES:
        raise Exit(code, f"Run {run['id']} is still {run['status']} after {STOP_SECONDS} s")
    finish(api, run)
    # A run that finished before the cancellation reached it keeps its own outcome.
    return code if run["status"] in ("canceled", "interrupted") else OUTCOMES[run["status"]]


def launch(args, server, token):
    started = time.monotonic()
    deadline = started + args.timeout if args.timeout else float("inf")
    api = Api(server, token, deadline)
    key = args.idempotency_key or f"duckpad-run-{uuid.uuid4()}"
    trigger = {"source": args.source}
    if args.reference is not None:
        trigger["reference"] = args.reference
    try:
        run = api.call(
            "POST",
            f"/jobs/{urllib.parse.quote(args.job, safe='')}/runs",
            {"trigger": trigger},
            {"Idempotency-Key": key},
        )
    except Stop as signal_name:
        raise Exit(
            CANCELED,
            f"Received {signal_name} before Duckpad confirmed the launch. If it was accepted, the run "
            f"continues; its idempotency key is {key}",
        ) from None
    if args.detach:
        print(run["id"], flush=True)
        return SUCCESS
    version = f"tag {run['tag']} ({run['commit'][:7]})" if run.get("tag") else f"commit {run['commit'][:7]}"
    shown = None
    try:
        print(
            f"Run {run['id']} accepted: Job {run['job']}, {version}, environment {run['environment']}",
            flush=True,
        )
        while True:
            if (line := progress(run)) != shown:
                print(f"[{timedelta(seconds=round(time.monotonic() - started))}] {line}", flush=True)
                shown = line
            if run["status"] not in ACTIVE_STATUSES:
                break
            if (remaining := deadline - time.monotonic()) <= 0:
                return stop(api, run, TIMEOUT, f"Timeout of {timedelta(seconds=args.timeout)} reached")
            wait = round(min(POLL_SECONDS, remaining), 1)
            try:
                run = api.call("GET", f"/runs/{run['id']}?wait={wait}", wait=wait)
            except Unreachable as error:
                if time.monotonic() < deadline:
                    raise Exit(
                        UNREACHABLE,
                        f"Lost contact with Duckpad ({error}); run {run['id']} may still be running",
                    ) from None
    except Stop as signal_name:
        return stop(api, run, CANCELED, f"Received {signal_name}")
    finish(api, run)
    return OUTCOMES[run["status"]]


def interrupt(signum, frame):
    raise Stop(signum)


def main(argv=None):
    args = parser().parse_args(argv)
    server = (args.server or os.environ.get("DUCKPAD_SERVER") or LOCAL_SERVER).rstrip("/")
    location = urllib.parse.urlsplit(server)
    if location.scheme not in ("http", "https") or not location.hostname:
        print(f"duckpad run: error: {server} is not an http:// or https:// address", file=sys.stderr)
        return REFUSED
    if args.token_file:
        try:
            token = args.token_file.read_text(encoding="utf-8").strip()
        except (OSError, ValueError) as error:
            print(f"duckpad run: error: cannot read the token file: {error}", file=sys.stderr)
            return REFUSED
    else:
        token = os.environ.get("DUCKPAD_TOKEN", "").strip()
    if not token:
        print("duckpad run: error: set DUCKPAD_TOKEN or pass --token-file", file=sys.stderr)
        return REFUSED
    if not re.fullmatch(r"[!-~]+", token):
        # http.client would reject the header with an error that quotes the token into scheduler logs.
        print("duckpad run: error: the token must be a single line without spaces", file=sys.stderr)
        return REFUSED
    if location.scheme == "http" and location.hostname not in ("127.0.0.1", "::1", "localhost"):
        print(f"Warning: the API token is sent unencrypted to {location.hostname}", file=sys.stderr)
    handlers = {name: signal.signal(name, interrupt) for name in (signal.SIGINT, signal.SIGTERM)}
    try:
        return launch(args, server, token)
    except Exit as error:
        print(error, file=sys.stderr, flush=True)
        return error.code
    except Stop as signal_name:
        print(f"Received {signal_name}", file=sys.stderr, flush=True)
        return CANCELED
    except Unreachable as error:
        print(f"Cannot reach Duckpad at {server}: {error}", file=sys.stderr, flush=True)
        return UNREACHABLE
    except Refused as error:
        if error.detail.get("code") == "job_busy":
            print(
                f"Job {args.job} is already running (run {error.detail.get('run')}); retry later",
                file=sys.stderr,
            )
            return BUSY
        code = error.detail.get("code", "error")
        print(f"Duckpad refused the request (HTTP {error.status}, {code}): {error}", file=sys.stderr)
        return REFUSED
    finally:
        for name, handler in handlers.items():
            signal.signal(name, handler)
