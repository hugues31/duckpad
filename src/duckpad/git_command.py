"""The single way Duckpad runs Git: bounded, hook-free, isolated from the server's Git setup."""

import logging
import os
import subprocess
import tempfile
import threading
from contextlib import contextmanager

from .util import Problem

logger = logging.getLogger(__name__)

TIMEOUT = 30
FAILURE = "Git could not complete the operation. Reload and retry."
TIMED_OUT = (
    "Git did not respond in time. Retry; if this persists, ask an administrator to check the server logs."
)
INVALID_BRANCH_NAME = (
    "Enter a valid branch name, such as experiment/my-change. Branch names cannot end with '/'."
)
# Inherited Git variables can redirect a command to another repository or inject configuration;
# SSH and credential-manager variables can authenticate network Git as the server account.
ISOLATED_VARIABLES = ("GIT_", "SSH_", "GCM_")


class GitError(Problem):
    """A failed Git command. Its output can contain server paths, so it stays in the server logs."""

    def __init__(self, message=FAILURE, status=409, output=""):
        super().__init__(message, status)
        self.output = output


class GitTimeout(GitError):
    def __init__(self):
        super().__init__(TIMED_OUT, 504)


def environment(identity=None):
    """The server environment without Git, SSH and credential settings, plus explicit attribution."""
    env = {key: value for key, value in os.environ.items() if not key.startswith(ISOLATED_VARIABLES)}
    env.update(
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_TERMINAL_PROMPT="0",
        # Logged errors and network error classification read Git's English messages.
        LC_ALL="C",
    )
    if identity:
        # Explicit author AND committer override any identity inherited from the server.
        for role in ("AUTHOR", "COMMITTER"):
            env[f"GIT_{role}_NAME"], env[f"GIT_{role}_EMAIL"] = identity["name"], identity["email"]
    return env


def command(path, args, identity=None, settings=()):
    options = ["core.hooksPath=/dev/null", *settings]
    if identity:
        options += [f"user.name={identity['name']}", f"user.email={identity['email']}"]
    return ["git", *(flag for option in options for flag in ("-c", option)), "-C", str(path), *args]


def log_failure(path, args, status, output):
    # repr() keeps remote, attacker-controlled text on one log line.
    logger.warning("Git %s failed in %s with status %s: %r", args[0] if args else "", path, status, output)


def run(
    path,
    *args,
    identity=None,
    settings=(),
    env=None,
    input=None,
    check=True,
    binary=False,
    timeout=TIMEOUT,
    failure=FAILURE,
):
    """Run one Git command and return its output, stripped unless binary.

    A failure raises GitError with the given message for the user, unless check is False; a timeout
    always raises GitTimeout. `env` adds variables to the controlled environment.
    """
    try:
        result = subprocess.run(
            command(path, args, identity, settings),
            env={**environment(identity), **(env or {})},
            input=input,
            capture_output=True,
            timeout=timeout,
            **({} if binary else {"encoding": "utf-8", "errors": "replace"}),
        )
    except subprocess.TimeoutExpired as error:
        logger.warning("Git %s timed out after %s seconds in %s", args[0] if args else "", timeout, path)
        raise GitTimeout from error
    if result.returncode and check:
        output = result.stderr.decode("utf-8", "replace") if binary else result.stderr
        log_failure(path, args, result.returncode, output.strip())
        raise GitError(failure, output=output)
    return result.stdout if binary else result.stdout.strip()


@contextmanager
def session(path, *args, identity=None, timeout=TIMEOUT):
    """An interactive Git process, such as a ref transaction, killed if it outlives the timeout."""
    with (
        tempfile.TemporaryFile() as errors,
        subprocess.Popen(
            command(path, args, identity),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            # A file, unlike a pipe, never fills up and blocks Git while the caller reads stdout.
            stderr=errors,
            env=environment(identity),
            encoding="utf-8",
            errors="replace",
        ) as process,
    ):
        watchdog = threading.Timer(timeout, process.kill)
        watchdog.start()
        try:
            yield process
        finally:
            process.stdin.close()
            process.wait(timeout=timeout + 5)
            watchdog.cancel()
            watchdog.join()
            if process.returncode:
                errors.seek(0)
                log_failure(path, args, process.returncode, errors.read().decode("utf-8", "replace").strip())


def check_branch_name(path, name):
    """Reject a local branch name Git cannot use with an actionable message.

    Git prints the normalized form of a valid reference name and nothing for an invalid one;
    a name that normalization would change, such as one with consecutive slashes, is invalid.
    """
    ref = "refs/heads/" + name
    if run(path, "check-ref-format", "--normalize", ref, check=False) != ref:
        raise Problem(INVALID_BRANCH_NAME, 422, {"code": "invalid_branch_name"})
