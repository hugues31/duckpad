"""JSON-only RPC to a project-scoped SQL process; never deserialize worker code."""

import json
import os
import queue
import socket
import subprocess
import sys
import threading

import duckdb

from .util import Problem, clean


class Database:
    def __init__(self, policy):
        parent, child = socket.socketpair()
        environment = {
            key: value
            for key, value in os.environ.items()
            if key in ("PATH", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "PYTHONPATH")
        }
        environment["PYTHONUNBUFFERED"] = "1"
        self.process = subprocess.Popen(
            [sys.executable, "-m", "duckpad.sql_worker", str(child.fileno())],
            pass_fds=(child.fileno(),),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        child.close()
        self.socket = parent
        self.stream = parent.makefile("rb")
        self.lock = threading.Lock()
        self.pending = {}
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
                "Cannot initialize isolated SQL execution: "
                + (
                    str(error)
                    if not diagnostics
                    else "Worker initialization failed; check Linux Landlock support"
                ),
                503,
            ) from None

    def _read(self):
        try:
            for line in self.stream:
                response = json.loads(line)
                with self.lock:
                    target = self.pending.get(response["id"])
                if target:
                    target.put(response)
        finally:
            with self.lock:
                self.closed = True
                for target in self.pending.values():
                    target.put({"error": "The isolated SQL worker stopped", "type": "Error"})

    def call(self, operation, **arguments):
        target = queue.Queue()
        with self.lock:
            if self.closed:
                raise Problem("The isolated SQL worker is unavailable", 503)
            self.serial += 1
            identity = self.serial
            self.pending[identity] = target
            self.socket.sendall(
                (json.dumps(clean({"id": identity, "operation": operation, **arguments})) + "\n").encode()
            )
        try:
            result = target.get()
            if "error" in result:
                error_type = getattr(duckdb, result.get("type", "Error"), duckdb.Error)
                if not isinstance(error_type, type) or not issubclass(error_type, duckdb.Error):
                    error_type = duckdb.Error
                raise error_type(result["error"])
            return result.get("value")
        finally:
            with self.lock:
                self.pending.pop(identity, None)

    def cursor(self):
        return Cursor(self, self.call("cursor"))

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.diagnostics = self.process.stderr.read().decode(errors="replace")
        self.process.stderr.close()
        self.socket.close()
        self.reader.join(timeout=5)
        self.stream.close()


class Cursor:
    def __init__(self, database, identity):
        self.database, self.identity = database, identity
        self.description = None

    def execute(self, query, parameters=None):
        self.description = self.database.call(
            "execute", cursor=self.identity, query=query, parameters=parameters
        )
        return self

    def fetchall(self):
        return [tuple(row) for row in self.database.call("fetchall", cursor=self.identity)]

    def fetchone(self):
        row = self.database.call("fetchone", cursor=self.identity)
        return tuple(row) if row is not None else None

    def interrupt(self):
        if not self.database.closed:
            try:
                self.database.call("interrupt", cursor=self.identity)
            except (duckdb.Error, Problem):
                if not self.database.closed:
                    raise

    def close(self):
        if not self.database.closed:
            self.database.call("close", cursor=self.identity)
