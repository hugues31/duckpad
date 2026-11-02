"""Exercise an installed wheel from outside the checkout, without Node tooling."""

import argparse
import json
import re
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import httpx


def smoke(python):
    with tempfile.TemporaryDirectory(prefix="duckpad-wheel-") as temporary:
        folder = Path(temporary)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        command = [
            python,
            "-m",
            "duckpad.cli",
            "start",
            "--home",
            str(folder / "instance"),
            "--port",
            str(port),
            "--no-browser",
        ]
        base = f"http://127.0.0.1:{port}"
        processes = []

        def start(name):
            log = folder / name
            stream = log.open("w")
            process = subprocess.Popen(command, cwd=folder, stdout=stream, stderr=stream)
            processes.append((process, stream))
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    if httpx.get(base, timeout=1).status_code == 200:
                        return process, log
                except httpx.ConnectError:
                    pass
                if process.poll() is not None:
                    raise AssertionError(log.read_text())
                time.sleep(0.05)
            raise AssertionError("Installed server did not start")

        try:
            first, log = start("first.log")
            password = re.search(r"Password: (\S+)", log.read_text())[1]
            duplicate = subprocess.run(command, cwd=folder, capture_output=True, text=True, timeout=60)
            assert duplicate.returncode != 0 and "already running" in duplicate.stderr
            with httpx.Client(base_url=base) as client:
                assert client.get("/api/workspace").status_code == 401
                assert client.post("/api/login", json={"password": password}).status_code == 200
                html = client.get("/").text
                scripts = re.findall(r'src="(/assets/[^\"]+)"', html)
                assert scripts and all(client.get(script).status_code == 200 for script in scripts)
                example = client.post("/api/example").json()
                run = client.post(f"/api/worktrees/{example['id']}/runs", json={"environment": "dev"}).json()
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    result = client.get(f"/api/runs/{run['id']}").json()
                    if result["status"] not in ("preparing", "running", "canceling"):
                        break
                    time.sleep(0.05)
                assert result["status"] == "success", result
                assert result["entry_point"] == "api"
                first.terminate()
                first.wait(10)
                second, next_log = start("second.log")
                assert "Password:" not in next_log.read_text()
                assert client.post("/api/login", json={"password": password}).status_code == 200
                assert client.get(f"/api/runs/{run['id']}").json()["status"] == "success"
                assert (
                    client.get(f"/api/worktrees/{example['id']}/preview/orders?environment=dev").status_code
                    == 404
                )
                second.terminate()
                second.wait(10)
            return {
                "status": "passed",
                "installed_wheel_outside_checkout": True,
                "bundled_assets": True,
                "authentication_persists": True,
                "password_printed_only_once": True,
                "one_process_per_instance": True,
                "complete_example_run": True,
                "history_survives_restart": True,
                "results_are_not_persisted": True,
                "node_tooling_used": False,
            }
        finally:
            for process, stream in processes:
                if process.poll() is None:
                    process.terminate()
                    process.wait(10)
                stream.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--python", required=True, help="Interpreter of a virtualenv with the wheel installed"
    )
    parser.add_argument("--output", type=Path, help="Also write the JSON summary to this file")
    args = parser.parse_args()
    result = json.dumps(smoke(str(Path(args.python).absolute())), indent=2) + "\n"
    if args.output:
        args.output.write_text(result, encoding="utf-8")
    print(result, end="")
