"""Lightweight process counters, including in-process DuckDB work."""

import os
import time
from pathlib import Path


def resource_usage():
    # statm reports current resident pages; peak RSS would never fall after a run.
    # Platforms without procfs still expose CPU and explicitly omit memory.
    try:
        resident_pages = int(Path("/proc/self/statm").read_text().split()[1])
        memory_bytes = resident_pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError, AttributeError):
        memory_bytes = None
    return {
        "process_id": os.getpid(),
        "cpu_seconds": time.process_time(),
        "sampled_at": time.monotonic(),
        "memory_bytes": memory_bytes,
    }
