"""Worker transport failures must release callers without leaking thread exceptions."""

import queue
import subprocess
import sys
import threading
from unittest.mock import MagicMock, Mock

import pytest

from duckpad.sandbox import Database, Pipe
from duckpad.util import Problem


@pytest.fixture
def transport():
    database = Database.__new__(Database)
    database.lock = threading.Lock()
    database.pending = {}
    database.serial = 0
    database.closed = False
    database.socket = Mock()
    database.stream = MagicMock()
    return database


@pytest.mark.parametrize(
    ("operation", "configured", "deadline"),
    [("python", None, None), ("python", " ", None), ("python", "600", 600.0), ("execute", "0.25", None)],
)
def test_python_deadline_is_opt_in_and_never_applies_to_sql(
    transport, monkeypatch, operation, configured, deadline
):
    monkeypatch.delenv("DUCKPAD_PYTHON_TIMEOUT_SECONDS", raising=False)
    if configured is not None:
        monkeypatch.setenv("DUCKPAD_PYTHON_TIMEOUT_SECONDS", configured)
    response = Mock()
    response.get.return_value = {"value": "completed"}
    monkeypatch.setattr("duckpad.sandbox.queue.Queue", lambda: response)

    assert transport.call(operation) == "completed"
    response.get.assert_called_once_with(timeout=deadline)
    assert transport.pending == {}


@pytest.mark.parametrize("configured", ["10m", "0", "-1", "nan", "inf"])
def test_invalid_python_deadline_fails_before_the_worker_starts_the_call(transport, monkeypatch, configured):
    monkeypatch.setenv("DUCKPAD_PYTHON_TIMEOUT_SECONDS", configured)

    with pytest.raises(Problem, match="DUCKPAD_PYTHON_TIMEOUT_SECONDS must be a positive number"):
        transport.call("python")
    transport.socket.sendall.assert_not_called()
    assert transport.pending == {}


def test_reader_disconnect_releases_all_waiting_calls(transport):
    waiting = [queue.Queue(), queue.Queue()]
    transport.pending = dict(enumerate(waiting, start=1))
    transport.stream.__iter__.side_effect = ConnectionResetError("Worker disconnected")

    transport._read()

    assert transport.closed
    for response in waiting:
        assert response.get_nowait()["error"] == "The execution worker stopped"
    with pytest.raises(Problem, match="worker is unavailable") as error:
        transport.call("cursor")
    assert error.value.status == 503


def test_send_disconnect_releases_pending_calls_and_reports_unavailable(transport):
    waiting = queue.Queue()
    transport.pending[0] = waiting
    transport.socket.sendall.side_effect = BrokenPipeError("Worker disconnected")

    with pytest.raises(Problem, match="worker is unavailable") as error:
        transport.call("interrupt", cursor="cursor")

    assert error.value.status == 503
    assert transport.closed
    assert set(transport.pending) == {0}
    assert waiting.get_nowait()["error"] == "The execution worker stopped"
    with pytest.raises(Problem, match="worker is unavailable"):
        transport.call("cursor")
    transport.socket.sendall.assert_called_once()


def test_closing_after_a_send_raced_termination_releases_the_pipe():
    """An interrupt sent while the worker stops must not make closing the context fail."""
    process = subprocess.Popen([sys.executable, "-c", "pass"], stdin=subprocess.PIPE)
    process.wait()
    pipe = Pipe(process.stdin)
    with pytest.raises(BrokenPipeError):
        pipe.sendall(b"interrupt\n")

    pipe.close()

    assert pipe.fileno() == -1
