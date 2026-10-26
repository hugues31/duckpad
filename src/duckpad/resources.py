"""Portable process counters, with visible Linux container limits."""

import contextlib
import os
import re
import time
from pathlib import Path, PurePosixPath

import psutil


def _read(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


def _cgroup_directories(controller):
    """Resolve this process's cgroup and its visible ancestors (v1 or v2)."""
    memberships = [line.split(":", 2) for line in _read("/proc/self/cgroup").splitlines()]
    for line in _read("/proc/self/mountinfo").splitlines():
        before, separator, after = line.partition(" - ")
        fields, filesystem = before.split(), after.split()
        if not separator or len(fields) < 5 or len(filesystem) < 3:
            continue
        unified = filesystem[0] == "cgroup2"
        if not unified and (filesystem[0] != "cgroup" or controller not in filesystem[2].split(",")):
            continue
        # mountinfo escapes spaces, tabs, newlines and backslashes as octal.
        root, mount = [re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), v) for v in fields[3:5]]
        for membership in memberships:
            if len(membership) != 3:
                continue
            _, controllers, name = membership
            if (unified and controllers) or (not unified and controller not in controllers.split(",")):
                continue
            group = PurePosixPath(name)
            if ".." in group.parts:
                continue
            try:
                relative = group.relative_to(root)
            except ValueError:
                # A cgroup namespace can expose its own root as "/".
                if name != "/":
                    continue
                relative = PurePosixPath(".")
            boundary = Path(mount)
            directory = boundary / relative
            while True:
                yield directory, unified
                if directory == boundary:
                    break
                directory = directory.parent


def _capacity(process):
    cpu = float(psutil.cpu_count() or 1)
    # CPU affinity is unavailable on macOS.
    with contextlib.suppress(AttributeError, NotImplementedError, psutil.Error):
        cpu = min(cpu, len(process.cpu_affinity()) or cpu)
    try:
        memory = psutil.virtual_memory().total or None
    except (OSError, psutil.Error):
        memory = None
    if psutil.LINUX:
        for directory, unified in _cgroup_directories("memory"):
            try:
                limit = int(_read(directory / ("memory.max" if unified else "memory.limit_in_bytes")))
                if limit > 0:
                    memory = min(memory, limit) if memory else limit
            except ValueError:
                pass
        for directory, unified in _cgroup_directories("cpu"):
            try:
                if unified:
                    quota, period = _read(directory / "cpu.max").split()
                else:
                    quota = _read(directory / "cpu.cfs_quota_us")
                    period = _read(directory / "cpu.cfs_period_us")
                quota, period = int(quota), int(period)
                if quota > 0 and period > 0:
                    cpu = min(cpu, quota / period)
            except ValueError:
                pass
    return cpu, memory


def resource_usage(worker_pids=()):
    process = psutil.Process()
    cpu_capacity, memory_total_bytes = _capacity(process)
    try:
        memory_bytes = process.memory_info().rss
    except (OSError, psutil.Error):
        memory_bytes = None
    cpu_seconds = time.process_time()
    for pid in worker_pids:
        try:
            worker = psutil.Process(pid)
            times = worker.cpu_times()
            cpu_seconds += times.user + times.system
            if memory_bytes is not None:
                memory_bytes += worker.memory_info().rss
        except (OSError, psutil.Error):
            # A worker may exit between the API snapshot and this sample.
            continue
    return {
        "process_id": os.getpid(),
        "cpu_seconds": cpu_seconds,
        "sampled_at": time.monotonic(),
        "cpu_capacity": cpu_capacity,
        "memory_bytes": memory_bytes,
        "memory_total_bytes": memory_total_bytes,
    }
