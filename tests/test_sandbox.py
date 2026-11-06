"""Worker transport failures must release callers without leaking thread exceptions."""

import queue
import threading
from unittest.mock import MagicMock, Mock

import pytest

from duckpad.sandbox import Database
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
    ("operation", "configured_timeout"),
    [("python", None), ("python", "600"), ("execute", "0.25")],
)
def test_worker_reply_after_five_minutes_without_an_expired_deadline(
    transport, monkeypatch, operation, configured_timeout
):
    monkeypatch.delenv("DUCKPAD_PYTHON_TIMEOUT_SECONDS", raising=False)
    if configured_timeout is not None:
        monkeypatch.setenv("DUCKPAD_PYTHON_TIMEOUT_SECONDS", configured_timeout)

    def delayed_reply(*, timeout):
        # Simulate a reply after the old default deadline without a five-minute test.
        if timeout is not None and timeout < 301:
            raise queue.Empty
        return {"value": "completed"}

    response = Mock()
    response.get.side_effect = delayed_reply
    monkeypatch.setattr("duckpad.sandbox.queue.Queue", lambda: response)
    transport.stop_worker = Mock()

    assert transport.call(operation) == "completed"
    transport.stop_worker.assert_not_called()
    assert transport.pending == {}


@pytest.mark.parametrize("failure", [ConnectionResetError, OSError])
def test_reader_disconnect_releases_all_waiting_calls(transport, failure):
    waiting = [queue.Queue(), queue.Queue()]
    transport.pending = dict(enumerate(waiting, start=1))
    transport.stream.__iter__.side_effect = failure("Worker disconnected")

    transport._read()

    assert transport.closed
    for response in waiting:
        assert response.get_nowait()["error"] == "The execution worker stopped"
    with pytest.raises(Problem, match="worker is unavailable") as error:
        transport.call("cursor")
    assert error.value.status == 503


@pytest.mark.parametrize("failure", [BrokenPipeError, OSError])
def test_send_disconnect_releases_pending_calls_and_reports_unavailable(transport, failure):
    waiting = queue.Queue()
    transport.pending[0] = waiting
    transport.socket.sendall.side_effect = failure("Worker disconnected")

    with pytest.raises(Problem, match="worker is unavailable") as error:
        transport.call("interrupt", cursor="cursor")

    assert error.value.status == 503
    assert transport.closed
    assert set(transport.pending) == {0}
    assert waiting.get_nowait()["error"] == "The execution worker stopped"
    with pytest.raises(Problem, match="worker is unavailable"):
        transport.call("cursor")
    transport.socket.sendall.assert_called_once()
