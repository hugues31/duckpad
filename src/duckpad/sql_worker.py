"""Restricted SQL worker. The API process retains metadata and credentials storage."""

import ctypes
import json
import os
import platform
import socket
import sys
import threading
from pathlib import Path

import duckdb

from .catalog import Catalog
from .native import Cursor
from .util import clean, literal


def restrict_files(read_paths, write_paths):
    # Linux generic syscall numbers on the supported x86-64 and arm64 targets.
    # Fail closed elsewhere. ABI 2 adds cross-directory rename/link protection.
    if sys.platform != "linux" or platform.machine() not in ("x86_64", "aarch64"):
        raise RuntimeError("Shared SQL execution requires Linux with Landlock ABI 2 or later")
    libc = ctypes.CDLL(None, use_errno=True)
    abi = libc.syscall(444, 0, 0, 1)
    if abi < 2:
        raise RuntimeError("Shared SQL execution requires enabled Landlock ABI 2 or later")

    class Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]

    class Rule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

    handled = (1 << (15 if abi >= 3 else 14)) - 1
    ruleset = Ruleset(handled)
    fd = libc.syscall(444, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0)
    if fd < 0:
        raise RuntimeError("Cannot create the SQL filesystem sandbox")
    try:
        for path, writable in [(p, False) for p in read_paths] + [(p, True) for p in write_paths]:
            path = Path(path)
            if not path.exists():
                continue
            permissions = (1 << 2) | (1 << 3)
            if writable:
                permissions |= (1 << 1) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8) | (1 << 13)
                if abi >= 3:
                    permissions |= 1 << 14
            if not path.is_dir():
                permissions &= (1 << 1) | (1 << 2) | (1 << 14)
            path_fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = Rule(permissions, path_fd)
                if libc.syscall(445, fd, 1, ctypes.byref(rule), 0):
                    raise RuntimeError("Cannot authorize a SQL filesystem resource")
            finally:
                os.close(path_fd)
        if libc.prctl(38, 1, 0, 0, 0) or libc.syscall(446, fd, 0):
            raise RuntimeError("Cannot enforce the SQL filesystem sandbox")
    finally:
        os.close(fd)


def serve(descriptor):
    channel = socket.socket(fileno=descriptor)
    stream = channel.makefile("rb")
    send_lock = threading.Lock()
    cursors = {}
    db = None

    def reply(message, value=None, error=None):
        response = {"id": message["id"], "value": clean(value)}
        if error is not None:
            response = {"id": message["id"], "error": str(error), "type": type(error).__name__}
        with send_lock:
            channel.sendall((json.dumps(response) + "\n").encode())

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

    message = json.loads(stream.readline())
    try:
        policy = message["policy"]
        # Apply before creating DuckDB or any worker threads, so all children
        # inherit the OS restrictions. No instance metadata descriptors exist.
        restrict_files(
            [
                *policy["read_paths"],
                policy["extensions"],
                "/usr",
                "/lib",
                "/lib64",
                "/etc/ssl",
                "/etc/resolv.conf",
                "/etc/hosts",
                "/etc/nsswitch.conf",
                "/dev/urandom",
                "/dev/null",
                "/proc/meminfo",
                "/proc/cpuinfo",
                "/proc/stat",
                "/proc/self/cgroup",
                "/sys/devices/system/cpu/online",
                "/sys/fs/cgroup",
                sys.base_prefix,
                str(Path(__file__).parent),
                str(Path(duckdb.__file__).parent),
            ],
            policy["write_paths"],
        )
        db = duckdb.connect(
            ":memory:",
            config={
                "extension_directory": policy["extensions"],
                "extension_repository_directory": str(Path(policy["extensions"]) / "repository-definitions"),
                "allow_unsigned_extensions": policy.get("allow_unsigned_extensions", False),
                "allow_persistent_secrets": False,
                "allow_unredacted_secrets": False,
                "autoload_known_extensions": False,
                "autoinstall_known_extensions": False,
                "threads": 2,
                "memory_limit": "512MB",
                "temp_directory": policy["temporary"],
            },
        )
        # Only administrator-authored connection setup runs before the lock.
        Catalog.prepare(None, db, policy["captured"], policy.get("offline_extensions", {}))
        allowed = [str(Path(p).resolve()) + "/" for p in policy["read_paths"] + policy["write_paths"]]
        allowed += policy["remote_paths"]
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


if __name__ == "__main__":
    serve(int(sys.argv[1]))
