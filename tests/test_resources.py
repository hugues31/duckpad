import os
from types import SimpleNamespace

import psutil
import pytest
from fastapi.testclient import TestClient

from duckpad import resources
from duckpad.app import create_app
from duckpad.resources import resource_usage


def test_resources_require_authentication_and_return_live_process_counters(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert client.get("/api/resources").status_code == 401
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        first = client.get("/api/resources")
        second = client.get("/api/resources").json()
        assert first.status_code == 200
        assert first.headers["cache-control"] == "no-store"
        assert second["process_id"] == os.getpid()
        assert second["sampled_at"] > first.json()["sampled_at"]
        assert second["cpu_seconds"] >= first.json()["cpu_seconds"] >= 0
        assert second["memory_bytes"] > 0
        assert second["memory_total_bytes"] > 0
        assert second["cpu_capacity"] > 0
        client.post("/api/logout")
        assert client.get("/api/resources").status_code == 401


@pytest.fixture
def portable_host(monkeypatch):
    process = SimpleNamespace(memory_info=lambda: SimpleNamespace(rss=256 * 1024**2))
    monkeypatch.setattr(psutil, "Process", lambda: process)
    monkeypatch.setattr(psutil, "cpu_count", lambda: 8)
    monkeypatch.setattr(psutil, "virtual_memory", lambda: SimpleNamespace(total=8 * 1024**3))
    monkeypatch.setattr(psutil, "LINUX", False)
    return process


def test_portable_measurements_work_without_procfs_or_cpu_affinity(monkeypatch, portable_host):
    def no_procfs(path):
        pytest.fail("Portable measurements must not read procfs")

    monkeypatch.setattr(resources, "_read", no_procfs)
    sample = resource_usage()
    assert sample["memory_bytes"] == 256 * 1024**2
    assert sample["memory_total_bytes"] == 8 * 1024**3
    assert sample["cpu_capacity"] == 8
    portable_host.memory_info = lambda: SimpleNamespace(rss=128 * 1024**2)
    assert resource_usage()["memory_bytes"] == 128 * 1024**2


@pytest.mark.parametrize("error", [psutil.AccessDenied, PermissionError])
def test_missing_memory_counters_do_not_break_cpu_reporting(portable_host, error):
    def unavailable():
        raise error

    portable_host.memory_info = unavailable
    sample = resource_usage()
    assert sample["memory_bytes"] is None
    assert sample["memory_total_bytes"] == 8 * 1024**3
    assert sample["cpu_seconds"] >= 0


def test_missing_total_memory_is_not_reported_as_zero(monkeypatch, portable_host):
    def unavailable():
        raise OSError

    monkeypatch.setattr(psutil, "virtual_memory", unavailable)
    sample = resource_usage()
    assert sample["memory_bytes"] > 0
    assert sample["memory_total_bytes"] is None


def linux_files(monkeypatch, files):
    monkeypatch.setattr(psutil, "LINUX", True)
    monkeypatch.setattr(resources, "_read", lambda path: files.get(str(path), ""))


def test_nested_cgroup_v2_uses_strictest_visible_limits(monkeypatch, portable_host):
    linux_files(
        monkeypatch,
        {
            "/proc/self/cgroup": "0::/team/app",
            "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
            "/sys/fs/cgroup/team/app/memory.max": str(2 * 1024**3),
            "/sys/fs/cgroup/team/memory.max": str(1024**3),
            "/sys/fs/cgroup/memory.max": "max",
            "/sys/fs/cgroup/team/app/cpu.max": "200000 100000",
            "/sys/fs/cgroup/team/cpu.max": "50000 100000",
            "/sys/fs/cgroup/cpu.max": "max 100000",
        },
    )
    sample = resource_usage()
    assert sample["memory_total_bytes"] == 1024**3
    assert sample["cpu_capacity"] == 0.5


@pytest.mark.parametrize("membership", ["/containers/app", "/"])
def test_cgroup_v1_mount_roots_and_namespaces(monkeypatch, portable_host, membership):
    linux_files(
        monkeypatch,
        {
            "/proc/self/cgroup": f"5:memory:{membership}\n6:cpu,cpuacct:{membership}",
            "/proc/self/mountinfo": (
                "1 0 0:1 /containers/app /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n"
                "2 0 0:2 /containers/app /sys/fs/cgroup/cpu,cpuacct rw - cgroup cgroup rw,cpu,cpuacct"
            ),
            "/sys/fs/cgroup/memory/memory.limit_in_bytes": str(512 * 1024**2),
            "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us": "150000",
            "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us": "100000",
        },
    )
    sample = resource_usage()
    assert sample["memory_total_bytes"] == 512 * 1024**2
    assert sample["cpu_capacity"] == 1.5


@pytest.mark.parametrize(
    ("memory", "quota"),
    [("max", "max 100000"), (str(2**63 - 4096), "-1 100000"), ("invalid", "invalid"), ("0", "0 0")],
)
def test_unlimited_or_invalid_cgroups_fall_back_to_host_and_affinity(
    monkeypatch, portable_host, memory, quota
):
    portable_host.cpu_affinity = lambda: [1, 3]
    linux_files(
        monkeypatch,
        {
            "/proc/self/cgroup": "0::/",
            "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
            "/sys/fs/cgroup/memory.max": memory,
            "/sys/fs/cgroup/cpu.max": quota,
        },
    )
    sample = resource_usage()
    assert sample["memory_total_bytes"] == 8 * 1024**3
    assert sample["cpu_capacity"] == 2


def test_unavailable_linux_cgroup_files_fall_back_to_portable_totals(monkeypatch, portable_host):
    linux_files(monkeypatch, {})
    sample = resource_usage()
    assert sample["memory_total_bytes"] == 8 * 1024**3
    assert sample["cpu_capacity"] == 8


def test_cgroup_mount_paths_with_spaces(monkeypatch, portable_host):
    linux_files(
        monkeypatch,
        {
            "/proc/self/cgroup": "0::/app",
            "/proc/self/mountinfo": r"1 0 0:1 / /sys/cgroup\040mount rw - cgroup2 cgroup rw",
            "/sys/cgroup mount/app/memory.max": str(1024**3),
        },
    )
    assert resource_usage()["memory_total_bytes"] == 1024**3


def test_live_sql_workers_are_included_in_instance_counters(monkeypatch, portable_host):
    worker = SimpleNamespace(
        cpu_times=lambda: SimpleNamespace(user=3.0, system=2.0),
        memory_info=lambda: SimpleNamespace(rss=64 * 1024**2),
    )
    monkeypatch.setattr(psutil, "Process", lambda pid=None: worker if pid else portable_host)
    monkeypatch.setattr(resources.time, "process_time", lambda: 1.0)
    sample = resource_usage([123])
    assert sample["cpu_seconds"] == 6.0
    assert sample["memory_bytes"] == 320 * 1024**2
