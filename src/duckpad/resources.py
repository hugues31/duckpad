"""Portable machine-wide CPU and physical memory counters."""

import time

import psutil


def resource_usage():
    cpu_seconds = cpu_total_seconds = None
    try:
        times = psutil.cpu_times()
        cpu_total_seconds = sum(times)
        if psutil.LINUX:
            # Linux already includes guest time in user and nice time.
            cpu_total_seconds -= getattr(times, "guest", 0) + getattr(times, "guest_nice", 0)
        # I/O wait is idle CPU time, reported separately on Linux.
        cpu_seconds = cpu_total_seconds - times.idle - getattr(times, "iowait", 0)
    except (OSError, psutil.Error, NotImplementedError):
        pass

    memory_bytes = memory_total_bytes = None
    try:
        memory = psutil.virtual_memory()
        if memory.total > 0:
            memory_total_bytes = memory.total
            # Available memory includes reclaimable caches across platforms.
            memory_bytes = max(0, min(memory.total, memory.total - memory.available))
    except (OSError, psutil.Error, NotImplementedError):
        pass

    return {
        "sampled_at": time.monotonic(),
        "cpu_seconds": cpu_seconds,
        "cpu_total_seconds": cpu_total_seconds,
        "memory_bytes": memory_bytes,
        "memory_total_bytes": memory_total_bytes,
    }
