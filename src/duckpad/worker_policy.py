"""Filesystem confinement shared by SQL and Python execution."""

import ctypes
import os
import platform
import sys
from pathlib import Path


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
