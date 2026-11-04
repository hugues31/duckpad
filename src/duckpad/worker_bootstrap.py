"""Start with -I -S: no project imports, .pth files or sitecustomize before confinement."""

import importlib.util
import io
import json
import os
import runpy
import sys
from pathlib import Path


def main():
    # Preserve a dedicated protocol pipe before redirecting all ordinary output to stderr.
    channel = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
    stream = sys.stdin.buffer
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdin = io.StringIO()
    message = json.loads(stream.readline())
    policy = message["policy"]
    for name in ("TMPDIR", "TMP", "TEMP"):
        os.environ[name] = policy["temporary"]
    if sys.platform == "linux":
        try:
            Path("/proc/self/oom_score_adj").write_text("1000")
        except OSError as error:
            raise RuntimeError(
                "Cannot prioritize the execution worker for out-of-memory termination"
            ) from error
    runtime = Path(__file__).parent
    site = Path(sys.argv[1])
    if policy.get("isolated", True):
        restrict = runpy.run_path(str(runtime / "worker_policy.py"))["restrict_files"]
        restrict(
            [
                *policy["read_paths"],
                policy["extensions"],
                str(runtime),
                str(site),
                sys.base_prefix,
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
            ],
            policy["write_paths"],
        )
    sys.path[:0] = [str(runtime.parent), str(site)]
    spec = importlib.util.spec_from_file_location("duckpad", runtime / "__init__.py")
    assert spec is not None and spec.loader is not None
    package = importlib.util.module_from_spec(spec)
    sys.modules["duckpad"] = package
    spec.loader.exec_module(package)
    from duckpad.sql_worker import serve

    serve(stream, channel, message)


if __name__ == "__main__":
    main()
