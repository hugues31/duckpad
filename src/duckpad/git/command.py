"""The single way Duckpad runs Git: bounded, hook-free, isolated from the server's Git setup."""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Literal, TypedDict, Unpack, overload

from ..util import Problem

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

    def __init__(self, message: str = FAILURE, status: int = 409, output: str = "") -> None:
        super().__init__(message, status)
        self.output = output


class GitTimeout(GitError):
    def __init__(self) -> None:
        super().__init__(TIMED_OUT, 504)


def environment(identity: Mapping[str, str] | None = None) -> dict[str, str]:
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


def command(
    path: str | Path,
    args: Sequence[str],
    identity: Mapping[str, str] | None = None,
    settings: Sequence[str] = (),
) -> list[str]:
    options = ["core.hooksPath=/dev/null", *settings]
    if identity:
        options += [f"user.name={identity['name']}", f"user.email={identity['email']}"]
    return ["git", *(flag for option in options for flag in ("-c", option)), "-C", str(path), *args]


def log_failure(path: str | Path, args: Sequence[str], status: int, output: str) -> None:
    # repr() keeps remote, attacker-controlled text on one log line.
    logger.warning("Git %s failed in %s with status %s: %r", args[0] if args else "", path, status, output)


class GitOptions(TypedDict, total=False):
    settings: Sequence[str]
    env: Mapping[str, str] | None
    input: str | bytes | None
    check: bool
    timeout: float
    failure: str


@overload
def run(
    path: str | Path,
    *args: str,
    identity: Mapping[str, str] | None = None,
    binary: Literal[False] = False,
    **options: Unpack[GitOptions],
) -> str: ...


@overload
def run(
    path: str | Path,
    *args: str,
    identity: Mapping[str, str] | None = None,
    binary: Literal[True],
    **options: Unpack[GitOptions],
) -> bytes: ...


@overload
def run(
    path: str | Path,
    *args: str,
    identity: Mapping[str, str] | None = None,
    binary: bool,
    **options: Unpack[GitOptions],
) -> str | bytes: ...


def run(
    path: str | Path,
    *args: str,
    identity: Mapping[str, str] | None = None,
    settings: Sequence[str] = (),
    env: Mapping[str, str] | None = None,
    input: str | bytes | None = None,
    check: bool = True,
    binary: bool = False,
    timeout: float = TIMEOUT,
    failure: str = FAILURE,
) -> str | bytes:
    """Run one Git command and return its output, stripped unless binary.

    A failure raises GitError with the given message for the user, unless check is False; a timeout
    always raises GitTimeout. `env` adds variables to the controlled environment.
    """
    try:
        result: subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes] = subprocess.run(
            command(path, args, identity, settings),
            env={**environment(identity), **(env or {})},
            input=input,
            capture_output=True,
            timeout=timeout,
            encoding=None if binary else "utf-8",
            errors=None if binary else "replace",
        )
    except subprocess.TimeoutExpired as error:
        logger.warning("Git %s timed out after %s seconds in %s", args[0] if args else "", timeout, path)
        raise GitTimeout from error
    if result.returncode and check:
        output = (
            result.stderr.decode("utf-8", "replace") if isinstance(result.stderr, bytes) else result.stderr
        )
        log_failure(path, args, result.returncode, output.strip())
        raise GitError(failure, output=output)
    return result.stdout if binary else result.stdout.strip()


@contextmanager
def session(
    path: str | Path, *args: str, identity: Mapping[str, str] | None = None, timeout: float = TIMEOUT
) -> Iterator[subprocess.Popen[str]]:
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
            assert process.stdin is not None
            process.stdin.close()
            process.wait(timeout=timeout + 5)
            watchdog.cancel()
            watchdog.join()
            if process.returncode:
                errors.seek(0)
                log_failure(path, args, process.returncode, errors.read().decode("utf-8", "replace").strip())


def check_branch_name(path: str | Path, name: str) -> None:
    """Reject a local branch name Git cannot use with an actionable message.

    Git prints the normalized form of a valid reference name and nothing for an invalid one;
    a name that normalization would change, such as one with consecutive slashes, is invalid.
    """
    ref = "refs/heads/" + name
    if run(path, "check-ref-format", "--normalize", ref, check=False) != ref:
        raise Problem(INVALID_BRANCH_NAME, 422, {"code": "invalid_branch_name"})
