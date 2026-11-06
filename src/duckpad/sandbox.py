"""JSON-only RPC to a project-scoped SQL process; never deserialize worker code."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import sysconfig
import threading
from collections import deque
from contextlib import suppress
from pathlib import Path
from typing import Any

import duckdb
from filelock import FileLock

from .types import Record
from .util import Problem, clean, uid


def python_timeout() -> float | None:
    """The operator's deadline for each Python worker call; unset or blank means none."""
    configured = os.environ.get("DUCKPAD_PYTHON_TIMEOUT_SECONDS", "").strip()
    if not configured:
        return None
    with suppress(ValueError):
        if 0 < (seconds := float(configured)) <= threading.TIMEOUT_MAX:
            return seconds
    raise Problem("DUCKPAD_PYTHON_TIMEOUT_SECONDS must be a positive number of seconds", 500)


class Database:
    def __init__(self, policy: Record) -> None:
        environment = {
            key: value
            for key, value in os.environ.items()
            if key
            in (
                "PATH",
                "LANG",
                "LC_ALL",
                "LD_LIBRARY_PATH",
                "SYSTEMROOT",
                "WINDIR",
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
            )
        }
        environment["PYTHONUNBUFFERED"] = "1"
        lease = policy.pop("lease", None)
        self.lease = FileLock(lease + "." + uid(), thread_local=False) if lease else None
        if self.lease:
            self.lease.acquire()

        try:
            self.process = subprocess.Popen(
                [
                    policy.pop("interpreter", sys.executable),
                    "-I",
                    "-S",
                    policy.pop("worker", str(Path(__file__).with_name("worker_bootstrap.py"))),
                    policy.pop("site_packages", sysconfig.get_path("purelib")),
                ],
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except BaseException:
            if self.lease:
                self.lease.release()
            raise
        self.socket = Pipe(self.process.stdin)
        assert self.process.stdout is not None
        assert self.process.stderr is not None
        self.stream = self.process.stdout
        self._diagnostics = deque(maxlen=64)
        self.drain = threading.Thread(target=self._drain, daemon=True)
        self.drain.start()
        self.lock = threading.Lock()
        self.pending: dict[int, queue.Queue[Record]] = {}
        self.serial = 0
        self.closed = False
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        try:
            self.call("initialize", policy=policy)
        except Exception as error:
            self.close()
            diagnostics = self.diagnostics
            raise Problem(
                "Cannot initialize execution worker: " + (diagnostics or str(error)),
                503,
            ) from None

    def _drain(self) -> None:
        assert self.process.stderr is not None
        stream = self.process.stderr
        for chunk in iter(lambda: stream.read(1024), b""):
            self._diagnostics.append(chunk.decode(errors="replace"))

    @property
    def diagnostics(self) -> str:
        return "".join(getattr(self, "_diagnostics", []))

    def _read(self) -> None:
        try:
            for line in self.stream:
                response = json.loads(line)
                with self.lock:
                    target = self.pending.get(response["id"])
                if target:
                    target.put(response)
        except OSError:
            # Termination can reset the transport instead of producing a clean EOF.
            pass
        finally:
            with suppress(subprocess.TimeoutExpired, AttributeError):
                self.process.wait(timeout=1)
            self._stopped()

    def _stopped(self) -> None:
        drain = getattr(self, "drain", None)
        if drain is not None and self.process.poll() is not None:
            drain.join(timeout=1)
        with self.lock:
            self.closed = True
            for target in self.pending.values():
                message = "The execution worker stopped"
                process = getattr(self, "process", None)
                if process is not None:
                    code = process.poll()
                    if code == -4 or code == 0xC000001D:
                        message += ": a native dependency is incompatible with the server CPU; use a compatible wheel (for Polars, polars[rtcompat])"
                    elif code is not None:
                        message += f" (exit {code}); the worker may have crashed, exhausted memory or been canceled. Run again to recompute this context."
                diagnostics = self.diagnostics
                if diagnostics:
                    message += "\n" + diagnostics[-8000:]
                target.put({"error": message, "type": "Error"})

    def call(self, operation: str, **arguments: Any) -> Any:
        # Validate before sending: a call the worker already started cannot be abandoned safely.
        timeout = python_timeout() if operation == "python" else None
        target: queue.Queue[Record] = queue.Queue()
        identity = None
        try:
            with self.lock:
                if self.closed:
                    raise Problem("The execution worker is unavailable", 503)
                self.serial += 1
                identity = self.serial
                self.pending[identity] = target
                self.socket.sendall(
                    (json.dumps(clean({"id": identity, "operation": operation, **arguments})) + "\n").encode()
                )
            try:
                result = target.get(timeout=timeout)
            except queue.Empty:
                self.stop_worker()
                raise Problem(
                    "Python execution timed out; external writes may have completed. The next run will recompute this context.",
                    503,
                ) from None
            if "error" in result:
                error_type = getattr(duckdb, result.get("type", "Error"), duckdb.Error)
                if not isinstance(error_type, type) or not issubclass(error_type, duckdb.Error):
                    error_type = duckdb.Error
                raise error_type(result["error"])
            return result.get("value")
        except OSError:
            # A concurrent close may win before the reader marks the worker stopped.
            self._stopped()
            raise Problem("The execution worker is unavailable", 503) from None
        finally:
            if identity is not None:
                with self.lock:
                    self.pending.pop(identity, None)

    def execute(self, query, parameters=None):
        if self.closed:
            raise duckdb.ConnectionException("Connection already closed")
        if not hasattr(self, "default_cursor"):
            self.default_cursor = self.cursor()
        return self.default_cursor.execute(query, parameters)

    def retire(self) -> None:
        """Stop a worker that cannot be trusted with more queries; later calls fail at once."""
        self.stop_worker()
        self._stopped()

    def stop_worker(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()

    def cursor(self) -> Cursor:
        return Cursor(self, self.call("cursor"))

    def close(self) -> None:
        if self.socket.fileno() == -1:
            # Already released, for example after its results failed to move to a new worker.
            return
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        assert self.process.stderr is not None
        self.drain.join(timeout=5)
        self.process.stderr.close()
        self.socket.close()
        self.reader.join(timeout=5)
        self.stream.close()
        if self.lease:
            self.lease.release()
            Path(self.lease.lock_file).unlink(missing_ok=True)


class Pipe:
    def __init__(self, stream):
        self.stream = stream

    def sendall(self, data):
        self.stream.write(data)
        self.stream.flush()

    def fileno(self):
        return -1 if self.stream.closed else self.stream.fileno()

    def close(self):
        self.stream.close()


class Cursor:
    def __init__(self, database: Database, identity: str) -> None:
        self.database, self.identity = database, identity
        self.description = None
        self.python_active = threading.Event()

    def __enter__(self) -> Cursor:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def execute(self, query: str, parameters: Any = None) -> Cursor:
        self.description = self.database.call(
            "execute", cursor=self.identity, query=query, parameters=parameters
        )
        return self

    def fetchall(self) -> list[tuple[Any, ...]]:
        return [tuple(row) for row in self.database.call("fetchall", cursor=self.identity)]

    def fetchone(self) -> tuple[Any, ...] | None:
        row = self.database.call("fetchone", cursor=self.identity)
        return tuple(row) if row is not None else None

    def python(self, payload):
        self.python_active.set()
        try:
            result = self.database.call("python", cursor=self.identity, payload=payload)
        finally:
            self.python_active.clear()
        if isinstance(result, dict) and result.get("restart"):
            self.database.retire()
        return result

    def setup(self, captured, offline):
        self.database.call("setup", cursor=self.identity, captured=captured, offline=offline)

    def interrupt(self) -> None:
        if self.python_active.is_set():
            # DuckDB may stop cooperatively; arbitrary Python has a short grace period.
            def terminate() -> None:
                if self.python_active.is_set():
                    self.database.stop_worker()

            timer = threading.Timer(0.5, terminate)
            timer.daemon = True
            timer.start()
        if not self.database.closed:
            try:
                self.database.call("interrupt", cursor=self.identity)
            except (duckdb.Error, Problem):
                if not self.database.closed:
                    raise

    def close(self) -> None:
        if not self.database.closed:
            self.database.call("close", cursor=self.identity)
