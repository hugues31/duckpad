from collections import namedtuple
from types import SimpleNamespace

import psutil
import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.resources import resource_usage


@pytest.mark.parametrize("idle_samples", [None, (53.63, 53.64)], ids=["live", "roundoff"])
def test_resources_require_authentication_and_return_machine_counters(tmp_path, monkeypatch, idle_samples):
    if idle_samples is not None:
        # Increasing idle time can slightly decrease the derived busy float.
        cpu_times = namedtuple("CpuTimes", "user system idle")
        samples = iter(cpu_times(74.38, 0, idle) for idle in idle_samples)
        monkeypatch.setattr(psutil, "cpu_times", lambda: next(samples))
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert client.get("/api/resources").status_code == 401
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        first = client.get("/api/resources")
        second = client.get("/api/resources").json()
        assert first.status_code == 200
        assert first.headers["cache-control"] == "no-store"
        before = first.json()
        assert second["sampled_at"] > before["sampled_at"]
        assert before["cpu_seconds"] >= 0
        assert second["cpu_seconds"] >= 0
        # Subtracting idle counters can introduce floating-point roundoff.
        assert second["cpu_seconds"] >= before["cpu_seconds"] or second["cpu_seconds"] == pytest.approx(
            before["cpu_seconds"], rel=1e-12, abs=1e-9
        )
        assert second["cpu_total_seconds"] >= before["cpu_total_seconds"] > 0
        assert second["cpu_total_seconds"] >= second["cpu_seconds"]
        assert 0 <= second["memory_bytes"] <= second["memory_total_bytes"]
        assert second["memory_total_bytes"] == psutil.virtual_memory().total
        client.post("/api/logout")
        assert client.get("/api/resources").status_code == 401


@pytest.fixture
def machine(monkeypatch):
    def no_process(*args, **kwargs):
        pytest.fail("Machine metrics must not depend on a process or its affinity")

    monkeypatch.setattr(psutil, "Process", no_process)
    # The machine counters must remain independent of available CPU counts/quotas.
    monkeypatch.setattr(psutil, "cpu_count", lambda: 1)
    times = namedtuple("CpuTimes", "user system idle")(100, 50, 650)
    monkeypatch.setattr(psutil, "cpu_times", lambda: times)
    memory = SimpleNamespace(total=8 * 1024**3, available=3 * 1024**3)
    monkeypatch.setattr(psutil, "virtual_memory", lambda: memory)
    return memory


def test_machine_activity_and_memory_include_other_applications(machine):
    sample = resource_usage()
    assert sample["cpu_seconds"] == 150
    assert sample["cpu_total_seconds"] == 800
    assert sample["memory_bytes"] == 5 * 1024**3
    assert sample["memory_total_bytes"] == 8 * 1024**3
    machine.available = 2 * 1024**3
    assert resource_usage()["memory_bytes"] == 6 * 1024**3


def test_linux_cpu_excludes_idle_and_iowait_without_double_counting_guests(monkeypatch, machine):
    monkeypatch.setattr(psutil, "LINUX", True)
    times = namedtuple("CpuTimes", "user nice system idle iowait irq softirq steal guest guest_nice")(
        100, 20, 50, 600, 40, 5, 10, 15, 30, 10
    )
    monkeypatch.setattr(psutil, "cpu_times", lambda: times)
    sample = resource_usage()
    assert sample["cpu_total_seconds"] == 840
    assert sample["cpu_seconds"] == 200


def test_portable_cpu_counters_do_not_require_linux_fields(monkeypatch, machine):
    monkeypatch.setattr(psutil, "LINUX", False)
    sample = resource_usage()
    assert sample["cpu_seconds"] == 150
    assert sample["cpu_total_seconds"] == 800


@pytest.mark.parametrize("metric", ["cpu_times", "virtual_memory"])
@pytest.mark.parametrize("error", [psutil.AccessDenied, PermissionError, NotImplementedError])
def test_unavailable_counters_do_not_break_the_other_metric(monkeypatch, machine, metric, error):
    def unavailable():
        raise error

    monkeypatch.setattr(psutil, metric, unavailable)
    sample = resource_usage()
    if metric == "cpu_times":
        assert sample["cpu_seconds"] is None
        assert sample["cpu_total_seconds"] is None
        assert sample["memory_bytes"] == 5 * 1024**3
        assert sample["memory_total_bytes"] == 8 * 1024**3
    else:
        assert sample["memory_bytes"] is None
        assert sample["memory_total_bytes"] is None
        assert sample["cpu_seconds"] == 150
        assert sample["cpu_total_seconds"] == 800


def test_unknown_memory_capacity_is_unavailable(machine):
    machine.total = 0
    sample = resource_usage()
    assert sample["memory_bytes"] is None
    assert sample["memory_total_bytes"] is None


@pytest.mark.parametrize(("available", "used"), [(0, 8), (8, 0), (9, 0), (-1, 8)])
def test_memory_is_bounded_by_physical_capacity(machine, available, used):
    machine.available = available * 1024**3
    assert resource_usage()["memory_bytes"] == used * 1024**3
