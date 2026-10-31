"""End-to-end network Git against a disposable OpenSSH server, with server credentials present."""

import getpass
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from duckpad.app import create_app

SSHD = shutil.which("sshd") or next((p for p in ("/usr/sbin/sshd",) if os.access(p, os.X_OK)), None)
pytestmark = pytest.mark.skipif(
    not (SSHD and all(shutil.which(tool) for tool in ("ssh", "ssh-keygen", "ssh-agent", "ssh-add"))),
    reason="The OpenSSH client and server are required",
)


def keygen(path):
    subprocess.run(
        ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", path.name, "-f", str(path)],
        check=True,
        capture_output=True,
    )
    public = Path(f"{path}.pub").read_text().strip()
    return public, fingerprint(public)


def fingerprint(public_key):
    result = subprocess.run(
        ["ssh-keygen", "-lf", "-"], input=public_key, text=True, capture_output=True, check=True
    )
    return result.stdout.split()[1]


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture
def ssh_server(tmp_path):
    root = tmp_path / "sshd"
    root.mkdir()
    host_public, _ = keygen(root / "host_key")
    authorized = root / "authorized_keys"
    authorized.write_text("")
    port = free_port()
    settings = [
        f"Port {port}",
        "ListenAddress 127.0.0.1",
        f"HostKey {root / 'host_key'}",
        f"PidFile {root / 'sshd.pid'}",
        f"AuthorizedKeysFile {authorized}",
        "StrictModes no",
        "UsePAM no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "AllowAgentForwarding no",
        "AllowTcpForwarding no",
        "X11Forwarding no",
        "LogLevel VERBOSE",
        # OpenSSH 9.8+ refuses a source for a while after a failed authentication.
        "PerSourcePenalties no",
    ]
    config = root / "sshd_config"
    config.write_text("\n".join(settings) + "\n")
    if subprocess.run([SSHD, "-t", "-f", str(config)], capture_output=True).returncode:
        config.write_text("\n".join(settings[:-1]) + "\n")
    log = root / "sshd.log"
    with log.open("w") as stream:
        server = subprocess.Popen([SSHD, "-D", "-e", "-f", str(config)], stderr=stream)
    deadline = time.monotonic() + 10
    while True:
        if server.poll() is not None:
            pytest.skip("The OpenSSH server cannot run here: " + log.read_text()[-500:])
        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
            break
        except OSError:
            if time.monotonic() > deadline:
                server.kill()
                raise
            time.sleep(0.05)
    yield {
        "port": port,
        "known_hosts": f"[127.0.0.1]:{port} {' '.join(host_public.split()[:2])}\n",
        "authorized": authorized,
        "log": log,
    }
    server.terminate()
    server.wait(10)


@pytest.fixture
def server_credentials(tmp_path, ssh_server, monkeypatch):
    """Working SSH credentials of the server account: a key, an agent, Git settings and a helper."""
    home = tmp_path / "server-home"
    (home / ".ssh").mkdir(parents=True)
    public, server_fingerprint = keygen(home / ".ssh" / "id_ed25519")
    ssh_server["authorized"].write_text(public + "\n")
    agent = subprocess.run(
        ["ssh-agent", "-s", "-a", str(tmp_path / "agent.sock")], capture_output=True, text=True, check=True
    )
    variables = dict(line.split(";", 1)[0].split("=", 1) for line in agent.stdout.splitlines() if "=" in line)
    marker = tmp_path / "credential-helper-called"
    ssh = (
        f"ssh -i {home / '.ssh' / 'id_ed25519'} -o UserKnownHostsFile=/dev/null "
        "-o StrictHostKeyChecking=no -o BatchMode=yes"
    )
    gitconfig = home / ".gitconfig"
    gitconfig.write_text(f"[core]\n\tsshCommand = {ssh}\n[credential]\n\thelper = !touch {marker}\n")
    for name, value in {
        "HOME": str(home),
        "SSH_AUTH_SOCK": variables["SSH_AUTH_SOCK"],
        "GIT_SSH_COMMAND": ssh,
        "GIT_CONFIG_GLOBAL": str(gitconfig),
    }.items():
        monkeypatch.setenv(name, value)
    subprocess.run(["ssh-add", "-q", str(home / ".ssh" / "id_ed25519")], check=True, capture_output=True)
    yield {"fingerprint": server_fingerprint, "marker": marker}
    subprocess.run(["ssh-agent", "-k"], env={**os.environ, "SSH_AGENT_PID": variables["SSH_AGENT_PID"]})


def test_network_git_uses_only_the_account_key(tmp_path, ssh_server, server_credentials):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
    url = f"ssh://{getpass.getuser()}@127.0.0.1:{ssh_server['port']}{remote}"
    # The server account itself can reach the repository with its key, agent and Git settings.
    subprocess.run(["git", "ls-remote", url], check=True, capture_output=True, timeout=30)
    ssh_server["log"].write_text("")

    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert (
            client.post("/api/login", json={"password": app.state.auth.initial_password}).status_code == 200
        )
        assert (
            client.put(
                "/api/git-hosts", json={"known_hosts": ssh_server["known_hosts"], "prefixes": []}
            ).status_code
            == 200
        )
        worktree = client.post("/api/projects", json={"name": "Remote"}).json()
        base = f"/api/worktrees/{worktree['id']}/git"

        def revision():
            return client.get(base + "/remote").json()["config_revision"]

        response = client.put(
            base + "/remote", json={"url": url, "remote_branch": "main", "config_revision": revision()}
        )
        assert response.status_code == 200, response.text
        key = client.post("/api/ssh-key").json()
        assert client.post(base + "/consent", json={"url": url}).status_code == 200

        # The account key is not authorized yet; no server credential may stand in for it.
        response = client.post(base + "/fetch", json={"config_revision": revision()})
        assert response.status_code == 502 and "authentication failed" in response.json()["error"]
        log = ssh_server["log"].read_text()
        assert key["fingerprint"] in log
        assert server_credentials["fingerprint"] not in log
        assert not server_credentials["marker"].exists()

        with ssh_server["authorized"].open("a") as stream:
            stream.write(key["public_key"] + "\n")
        status = client.post(base + "/fetch", json={"config_revision": revision()}).json()
        assert status["state"] == "new_remote_branch", status
        response = client.post(
            base + "/push",
            json={
                "config_revision": status["config_revision"],
                "local_head": status["local_head"],
                "remote_head": None,
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["state"] == "up_to_date"
        pushed = subprocess.run(
            ["git", "-C", str(remote), "rev-parse", "refs/heads/main"], capture_output=True, text=True
        )
        assert pushed.stdout.strip() == status["local_head"]
        log = ssh_server["log"].read_text()
        assert f"Accepted publickey for {getpass.getuser()}" in log
        assert server_credentials["fingerprint"] not in log
        assert not server_credentials["marker"].exists()

        # A host key that differs from the trusted one stops the connection before authentication.
        other_host = tmp_path / "other_host_key"
        other_public, _ = keygen(other_host)
        known_hosts = f"[127.0.0.1]:{ssh_server['port']} {' '.join(other_public.split()[:2])}\n"
        client.put("/api/git-hosts", json={"known_hosts": known_hosts, "prefixes": []})
        response = client.post(base + "/fetch", json={"config_revision": revision()})
        assert response.status_code == 502 and "trusted hosts" in response.json()["error"]

        # The temporary key copies never outlive their operation.
        assert not any((app.state.services.store.home / "git-network").iterdir())
