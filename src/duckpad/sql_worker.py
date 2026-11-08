"""Restricted SQL worker. The API process retains metadata and credentials storage."""

import json
import threading
from pathlib import Path

import duckdb

from . import project_extensions
from .native import Cursor
from .python_execution import execute as execute_python
from .util import clean, literal
from .worker_connections import setup_connections


def serve(stream, channel, message):
    send_lock = threading.Lock()
    python_lock = threading.Lock()
    cursors = {}
    db = None

    def reply(message, value=None, error=None):
        response = {"id": message["id"], "value": clean(value)}
        if error is not None:
            response = {"id": message["id"], "error": str(error), "type": type(error).__name__}
        with send_lock:
            channel.write((json.dumps(response) + "\n").encode())
            channel.flush()

    def dispatch(message):
        try:
            operation = message["operation"]
            if operation == "cursor":
                identity = str(message["id"])
                cursors[identity] = Cursor(db.cursor())
                reply(message, identity)
                return
            cursor = cursors[message["cursor"]]
            if operation == "execute":
                cursor.execute(message["query"], message["parameters"])
                result = (
                    [(d[0], str(d[1]), *d[2:]) for d in cursor.description] if cursor.description else None
                )
            elif operation == "python":
                with python_lock:
                    finished = threading.Event()
                    with cursor.lock:
                        if cursor.canceled:
                            raise duckdb.InterruptException("Execution canceled")
                        cursor.finished = finished
                    try:
                        result = execute_python(cursor, message["payload"])
                    finally:
                        finished.set()
            elif operation == "setup":
                setup_connections(cursor, message["captured"], message["offline"])
                result = None
            elif operation in ("fetchone", "fetchall"):
                result = getattr(cursor, operation)()
            elif operation == "interrupt":
                cursor.interrupt()
                result = None
            elif operation == "close":
                cursors.pop(message["cursor"]).close()
                result = None
            else:
                raise ValueError("Unknown SQL worker operation")
            reply(message, result)
        except Exception as error:
            reply(message, error=error)

    try:
        policy = message["policy"]
        db = duckdb.connect(
            ":memory:",
            config={
                "extension_directory": policy["extensions"],
                "extension_repository_directory": str(Path(policy["extensions"]) / "repository-definitions"),
                "allow_unsigned_extensions": policy.get("allow_unsigned_extensions", False),
                "allow_persistent_secrets": False,
                "allow_unredacted_secrets": False,
                **project_extensions.EXPLICIT_LOADING,
                "temp_directory": policy["temporary"],
                # Explicit instance resources; DuckDB sizes the others from the server's CPUs and memory.
                **policy["resources"],
            },
        )
        project_extensions.load(
            db,
            policy.get("project_extensions", []),
            policy.get("offline_extensions", {}),
            policy.get("allow_unsigned_extensions", False),
        )
        # Administrator-authored connection setup runs before the lock.
        setup_connections(db, policy.pop("captured", {}), policy.get("offline_extensions", {}))
        allowed = [str(Path(p).resolve()) + "/" for p in policy["read_paths"] + policy["write_paths"]]
        allowed += policy["remote_paths"]
        if policy.get("isolated", True):
            db.execute("SET allowed_directories = [" + ",".join(literal(p) for p in allowed) + "]")
            db.execute("SET enable_external_access = false")
            db.execute("SET lock_configuration = true")
        reply(message, True)
    except Exception as error:
        reply(message, error=error)
        return
    for line in stream:
        message = json.loads(line)
        threading.Thread(target=dispatch, args=(message,), daemon=True).start()
