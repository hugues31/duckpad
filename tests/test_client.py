"""`duckpad run` against a real HTTP server: exit codes, signals, timeouts and safe retries."""

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time

import pytest
import test_automation
import test_jobs
import uvicorn
from helpers import join_run

from duckpad import client

instance = test_jobs.instance


@pytest.fixture
def server(instance):
    app, _, _, _, users = instance
    test_jobs.create(instance)
    listener = socket.create_server(("127.0.0.1", 0))
    # The test instance already runs its lifespan; this server only adds a real socket.
    http = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="warning"))
    thread = threading.Thread(target=http.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not http.started:
        assert time.monotonic() < deadline, "Test server did not start"
        time.sleep(0.01)
    tokens = {role: headers["authorization"].removeprefix("Bearer ") for role, (_, headers) in users.items()}
    yield app, f"http://127.0.0.1:{listener.getsockname()[1]}", tokens
    http.should_exit = True
    thread.join(10)


def environment(url, token):
    env = {key: value for key, value in os.environ.items() if not key.startswith("DUCKPAD_")}
    env.update(DUCKPAD_SERVER=url, NO_PROXY="*")
    if token is not None:
        env["DUCKPAD_TOKEN"] = token
    return env


def duckpad_run(url, *args, token=None, timeout=60):
    return subprocess.run(
        [sys.executable, "-m", "duckpad", "run", *args],
        env=environment(url, token),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def start(url, *args, token):
    return subprocess.Popen(
        [sys.executable, "-m", "duckpad", "run", *args],
        env=environment(url, token),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def tagged_job(instance, slug, files):
    app, tree, _, _, _ = instance
    projects = app.state.services.projects
    snapshot = projects.snapshot(tree["id"])
    snapshot = projects.write(tree["id"], snapshot["revision"], {**snapshot["files"], **files})
    projects.versioning.create_tag(tree["id"], slug, snapshot["commit"], "Accepted")
    test_jobs.create(instance, slug=slug, ref=slug)


def flow(project, *nodes):
    return json.dumps(
        {
            "id": project,
            "name": "Jobs",
            "nodes": [{"id": node, "template": node, "params": {}} for node in nodes],
            "edges": [],
        }
    )


def source(sql):
    return f"-- @kind source\n-- @output result\n{sql}"


def only_run(app):
    runs = app.state.services.store.all("run")
    assert len(runs) == 1, runs
    return runs[0]


def wait_for(predicate, message, timeout=20):
    deadline = time.monotonic() + timeout
    while not (value := predicate()):
        assert time.monotonic() < deadline, message
        time.sleep(0.05)
    return value


def test_success_waits_prints_progress_and_records_the_trigger(server, tmp_path):
    app, url, tokens = server
    token_file = tmp_path / "token"
    token_file.write_text(tokens["operator"] + "\n")
    result = duckpad_run(url, "--job", "daily", "--token-file", str(token_file))
    assert result.returncode == client.SUCCESS, result.stderr
    run = only_run(app)
    assert run["status"] == "success"
    assert run["external_trigger"] == {"source": "cli", "reference": None}
    assert run["requester"]["username"] == "operator" and run["requester"]["token_name"] == "Tests"
    lines = result.stdout.splitlines()
    assert lines[0].startswith(f"Run {run['id']} accepted: Job daily, tag v1 (")
    assert lines[0].endswith(", environment dev")
    assert any(line.endswith("] success: 1/1 nodes succeeded") for line in lines)
    assert "Node source (source): success" in lines and "Outcome: success" in lines


def test_failed_and_partial_failure_exit_codes(server, instance):
    _, url, tokens = server
    project = instance[1]["project"]
    failing = source("SELECT error('Broken source') AS value;")
    tagged_job(instance, "broken", {"templates/source.sql": failing})
    result = duckpad_run(url, "--job", "broken", token=tokens["operator"])
    assert result.returncode == client.FAILED, result.stdout + result.stderr
    assert "Outcome: failed" in result.stdout and "Broken source" in result.stdout
    tagged_job(
        instance,
        "partial",
        {
            "flow.json": flow(project, "source", "broken"),
            "templates/source.sql": source("SELECT 1 AS value;"),
            "templates/broken.sql": failing,
        },
    )
    result = duckpad_run(url, "--job", "partial", token=tokens["operator"])
    assert result.returncode == client.PARTIAL_FAILURE, result.stdout + result.stderr
    assert "1/2 nodes succeeded, 1 failed" in result.stdout and "Outcome: partial_failure" in result.stdout


def test_detach_prints_the_run_id_and_a_key_reattaches_to_its_run(server):
    app, url, tokens = server
    options = ("--job", "daily", "--source", "airflow", "--reference", "daily/scheduled-1")
    detached = duckpad_run(
        url, *options, "--detach", "--idempotency-key", "daily:1", token=tokens["operator"]
    )
    assert detached.returncode == client.SUCCESS, detached.stderr
    run = only_run(app)
    assert detached.stdout == run["id"] + "\n"
    assert run["external_trigger"] == {"source": "airflow", "reference": "daily/scheduled-1"}
    join_run(app.state.services.store, run["id"])
    again = duckpad_run(url, *options, "--idempotency-key", "daily:1", token=tokens["operator"])
    assert again.returncode == client.SUCCESS, again.stderr
    assert again.stdout.startswith(f"Run {run['id']} accepted")
    assert only_run(app)["id"] == run["id"]


def test_canceled_elsewhere_exits_3(server, monkeypatch):
    app, url, tokens = server
    _, release = test_automation.hold_execution(app, monkeypatch)
    try:
        process = start(url, "--job", "daily", token=tokens["operator"])
        run = wait_for(lambda: app.state.services.store.all("run"), "Run was not launched")[0]
        app.state.services.engine.cancel(run["id"])
        release.set()
        stdout, stderr = process.communicate(timeout=30)
    finally:
        release.set()
    assert process.returncode == client.CANCELED, stdout + stderr
    assert "Outcome: canceled" in stdout


def test_busy_job_exits_4_and_names_the_active_run(server, monkeypatch):
    app, url, tokens = server
    _, release = test_automation.hold_execution(app, monkeypatch)
    try:
        active = duckpad_run(url, "--job", "daily", "--detach", token=tokens["operator"])
        result = duckpad_run(url, "--job", "daily", token=tokens["operator"])
    finally:
        release.set()
    assert result.returncode == client.BUSY, result.stderr
    assert f"already running (run {active.stdout.strip()})" in result.stderr
    assert len(app.state.services.store.all("run")) == 1


@pytest.mark.parametrize(
    ("args", "token", "message"),
    [
        ((), None, "set DUCKPAD_TOKEN or pass --token-file"),
        ((), "dpk_unknown", "HTTP 401, unauthenticated"),
        ((), "reader", "HTTP 403, forbidden"),
        (("--job", "missing"), "operator", "HTTP 404, job_not_found"),
        (("--source", "x" * 129), "operator", "HTTP 422, invalid_request"),
        (("--timeout", "soon"), "operator", "invalid duration 'soon'"),
        (("--token-file", "/nonexistent/token"), None, "cannot read the token file"),
        (("--server", "ftp://example.com"), "operator", "is not an http:// or https:// address"),
        (("--bogus",), "operator", "unrecognized arguments: --bogus"),
    ],
)
def test_refused_requests_exit_5(server, args, token, message):
    app, url, tokens = server
    options = ("--job", "daily", *args) if "--job" not in args else args
    result = duckpad_run(url, *options, token=tokens.get(token, token))
    assert result.returncode == client.REFUSED, result.stdout + result.stderr
    assert message in result.stderr
    assert "Traceback" not in result.stderr
    assert app.state.services.store.all("run") == []


def test_timeout_cancels_waits_for_the_stop_and_exits_6(server, monkeypatch):
    app, url, tokens = server
    _, release = test_automation.hold_execution(app, monkeypatch)
    try:
        process = start(url, "--job", "daily", "--timeout", "1s", token=tokens["operator"])
        wait_for(lambda: only_run_status(app) == "canceling", "Timeout did not request cancellation")
        assert process.poll() is None, "The command must wait for the run to stop"
        release.set()
        stdout, stderr = process.communicate(timeout=30)
    finally:
        release.set()
    assert process.returncode == client.TIMEOUT, stdout + stderr
    assert "Timeout of 0:00:01 reached: canceling run" in stderr
    assert "Outcome: canceled" in stdout
    assert only_run(app)["status"] == "canceled"


def only_run_status(app):
    runs = app.state.services.store.all("run")
    return runs[0]["status"] if runs else None


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_signals_cancel_wait_for_the_stop_and_exit_3(server, monkeypatch, signum):
    app, url, tokens = server
    _, release = test_automation.hold_execution(app, monkeypatch)
    try:
        process = start(url, "--job", "daily", token=tokens["operator"])
        assert process.stdout is not None
        assert " accepted: " in process.stdout.readline()
        process.send_signal(signum)
        wait_for(lambda: only_run_status(app) == "canceling", "Signal did not request cancellation")
        assert process.poll() is None, "The command must wait for the run to stop"
        release.set()
        stdout, stderr = process.communicate(timeout=30)
    finally:
        release.set()
    assert process.returncode == client.CANCELED, stdout + stderr
    assert f"Received {signal.Signals(signum).name}: canceling run" in stderr
    assert "Outcome: canceled" in stdout and "Traceback" not in stderr
    assert only_run(app)["status"] == "canceled"


class Proxy:
    """Forwards HTTP requests to the test server, losing the first launch response or everything after it."""

    def __init__(self, url, *, lose_launch=False, cut_after_launch=False):
        host, port = url.removeprefix("http://").split(":")
        self.upstream = (host, int(port))
        self.lose_launch, self.cut_after_launch = lose_launch, cut_after_launch
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.url = f"http://127.0.0.1:{self.listener.getsockname()[1]}"
        self.launches = []
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                connection, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self.forward, args=(connection,), daemon=True).start()

    def forward(self, connection):
        with connection:
            if self.cut_after_launch and self.launches:
                return
            request = self.read_request(connection)
            with socket.create_connection(self.upstream) as upstream:
                upstream.sendall(request)
                response = b"".join(iter(lambda: upstream.recv(65536), b""))
            head = request.partition(b"\r\n\r\n")[0].decode()
            if head.startswith("POST /api/v1/jobs/"):
                key = next(line for line in head.splitlines() if line.lower().startswith("idempotency-key:"))
                self.launches.append(key.partition(":")[2].strip())
                if self.lose_launch and len(self.launches) == 1:
                    return
            connection.sendall(response)

    @staticmethod
    def read_request(connection):
        data = b""
        while b"\r\n\r\n" not in data:
            data += connection.recv(65536)
        head, _, body = data.partition(b"\r\n\r\n")
        length = next(
            (
                int(line.split(b":")[1])
                for line in head.split(b"\r\n")
                if line.lower().startswith(b"content-length:")
            ),
            0,
        )
        while len(body) < length:
            body += connection.recv(65536)
        return head + b"\r\n\r\n" + body

    def close(self):
        self.listener.close()


def test_lost_launch_response_is_retried_with_the_same_key(server):
    app, url, tokens = server
    proxy = Proxy(url, lose_launch=True)
    try:
        result = duckpad_run(proxy.url, "--job", "daily", token=tokens["operator"])
    finally:
        proxy.close()
    assert result.returncode == client.SUCCESS, result.stdout + result.stderr
    assert len(proxy.launches) == 2 and proxy.launches[0] == proxy.launches[1]
    assert proxy.launches[0].startswith("duckpad-run-")
    assert "Duckpad is unreachable" in result.stderr and "retrying in 1 s" in result.stderr
    assert only_run(app)["status"] == "success"


def test_unreachable_server_exits_7(monkeypatch, capsys):
    monkeypatch.setattr(client, "RETRY_SECONDS", 1.5)
    monkeypatch.setenv("DUCKPAD_TOKEN", "dpk_test")
    with socket.create_server(("127.0.0.1", 0)) as closed:
        port = closed.getsockname()[1]
    assert client.main(["--job", "daily", "--server", f"http://127.0.0.1:{port}"]) == client.UNREACHABLE
    stderr = capsys.readouterr().err
    assert "retrying in 1 s" in stderr and f"Cannot reach Duckpad at http://127.0.0.1:{port}" in stderr


def test_lost_contact_while_waiting_exits_7(server, monkeypatch, capsys):
    app, url, tokens = server
    monkeypatch.setattr(client, "RETRY_SECONDS", 1.5)
    monkeypatch.setenv("DUCKPAD_TOKEN", tokens["operator"])
    _, release = test_automation.hold_execution(app, monkeypatch)
    proxy = Proxy(url, cut_after_launch=True)
    try:
        assert client.main(["--job", "daily", "--server", proxy.url]) == client.UNREACHABLE
    finally:
        proxy.close()
        release.set()
    run = only_run(app)
    assert f"run {run['id']} may still be running" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("text", "seconds"),
    [("90", 90), ("45s", 45), ("90m", 5400), ("2h", 7200), ("1h30m", 5400), ("1d", 86400)],
)
def test_durations(text, seconds):
    assert client.duration(text) == seconds


@pytest.mark.parametrize("text", ["", "0", "0m", "2x", "h", "1.5h", "-1m"])
def test_invalid_durations(text):
    with pytest.raises(Exception, match="invalid duration"):
        client.duration(text)


def test_run_loads_neither_duckdb_nor_the_server():
    code = (
        "import sys\n"
        "from duckpad import cli\n"
        "sys.argv = ['duckpad', 'run', '--help']\n"
        "try:\n"
        "    cli.main()\n"
        "except SystemExit:\n"
        "    pass\n"
        "heavy = {'duckdb', 'fastapi', 'uvicorn', 'sqlalchemy', 'pydantic', 'filelock', 'duckpad.app'}\n"
        "print(sorted(heavy & set(sys.modules)))\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[-1] == "[]"
    assert "Exit codes: 0 success" in result.stdout
