"""Per-account SSH keys, trusted Git hosts, URL-bound consent and isolated network Git."""

import datetime
import ipaddress
import os
import shlex
import ssl
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.x509.oid import NameOID
from fastapi.testclient import TestClient

from duckpad.app import create_app
from duckpad.git_credentials import parse_known_hosts, validate_prefix
from duckpad.services import Services
from duckpad.util import Problem

PASSWORD = "individual-test-password"


def host_key():
    return (
        ed25519.Ed25519PrivateKey.generate()
        .public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode()
    )


@pytest.fixture
def instance(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert (
            client.post("/api/login", json={"password": app.state.auth.initial_password}).status_code == 200
        )
        yield app, client


def account(app, name, role="member"):
    user = app.state.auth.create_user(name, PASSWORD, role)
    token = app.state.auth.login(name, PASSWORD, peer=name)
    return user, {"authorization": "Bearer " + token, "cookie": ""}


def call(client, headers, method, path, **kwargs):
    return client.request(method, "/api" + path, headers=headers, **kwargs)


@pytest.fixture
def team(instance):
    """A project administrator and an editor, with git.example.com trusted by the instance."""
    app, client = instance
    owner, owner_headers = account(app, "owner")
    editor, editor_headers = account(app, "editor")
    worktree = call(client, owner_headers, "POST", "/projects", json={"name": "Team"}).json()
    app.state.access.member(worktree["project"], editor["id"], "editor")
    response = client.put(
        "/api/git-hosts",
        json={"known_hosts": f"git.example.com {host_key()}\n", "prefixes": []},
    )
    assert response.status_code == 200
    calls = []

    def network(path, *args, key=None):
        calls.append({"args": args, "key": key})
        return ""

    app.state.services.projects.remotes.network = network
    return app, client, worktree, (owner, owner_headers), (editor, editor_headers), calls


def configure(client, headers, worktree, url):
    status = call(client, headers, "GET", f"/worktrees/{worktree['id']}/git/remote").json()
    return call(
        client,
        headers,
        "PUT",
        f"/worktrees/{worktree['id']}/git/remote",
        json={"url": url, "remote_branch": "main", "config_revision": status["config_revision"]},
    )


def fetch(client, headers, worktree):
    status = call(client, headers, "GET", f"/worktrees/{worktree['id']}/git/remote").json()
    return call(
        client,
        headers,
        "POST",
        f"/worktrees/{worktree['id']}/git/fetch",
        json={"config_revision": status["config_revision"]},
    )


def consent(client, headers, worktree, url):
    return call(client, headers, "POST", f"/worktrees/{worktree['id']}/git/consent", json={"url": url})


def test_account_key_lifecycle_never_exposes_the_private_key(instance):
    app, client = instance
    user, headers = account(app, "analyst")
    responses = [call(client, headers, "GET", "/ssh-key")]
    assert responses[0].json() is None
    responses.append(call(client, headers, "POST", "/ssh-key"))
    first = responses[-1].json()
    assert first["public_key"].startswith("ssh-ed25519 ") and first["public_key"].endswith(" analyst@duckpad")
    assert first["fingerprint"].startswith("SHA256:") and set(first) == {
        "public_key",
        "fingerprint",
        "created",
    }
    credentials = app.state.services.projects.remotes.credentials
    first_private = credentials.private_key(user["id"])
    assert "OPENSSH PRIVATE KEY" in first_private
    # The stored key matches the displayed public key.
    loaded = serialization.load_ssh_private_key(first_private.encode(), None)
    public = loaded.public_key().public_bytes(
        serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH
    )
    assert first["public_key"].startswith(public.decode())

    responses.append(call(client, headers, "POST", "/ssh-key"))
    second = responses[-1].json()
    assert second["fingerprint"] != first["fingerprint"]
    assert credentials.private_key(user["id"]) not in (None, first_private)
    responses += [
        call(client, headers, "GET", "/ssh-key"),
        call(client, headers, "GET", "/session"),
        client.get("/api/workspace"),
        client.get("/api/users"),
    ]
    for response in responses:
        assert response.status_code == 200
        assert "PRIVATE KEY" not in response.text
        assert first_private not in response.text

    assert call(client, headers, "DELETE", "/ssh-key").json() == {"ok": True}
    assert call(client, headers, "GET", "/ssh-key").json() is None
    assert credentials.private_key(user["id"]) is None


def test_deactivation_deletes_the_key_and_reactivation_does_not_restore_it(instance):
    app, client = instance
    user, headers = account(app, "leaver")
    assert call(client, headers, "POST", "/ssh-key").status_code == 200
    credentials = app.state.services.projects.remotes.credentials
    assert credentials.private_key(user["id"])
    assert client.patch(f"/api/users/{user['id']}", json={"active": False}).status_code == 200
    assert credentials.private_key(user["id"]) is None
    assert call(client, headers, "GET", "/ssh-key").status_code == 401
    assert client.patch(f"/api/users/{user['id']}", json={"active": True}).status_code == 200
    headers = account_headers(app, "leaver")
    assert call(client, headers, "GET", "/ssh-key").json() is None
    # Keys written before deactivation existed are refused while the account is inactive.
    app.state.services.store.put(
        "user", user["id"], {**app.state.services.store.get("user", user["id"]), "active": False}
    )
    app.state.services.store.put("ssh_key", user["id"], {"private_key": "legacy"})
    assert credentials.private_key(user["id"]) is None


def account_headers(app, name):
    return {"authorization": "Bearer " + app.state.auth.login(name, PASSWORD, peer=name), "cookie": ""}


def test_trusted_hosts_are_validated_and_normalized(instance):
    _, client = instance
    key = host_key()
    response = client.put(
        "/api/git-hosts",
        json={
            "known_hosts": f"# Provider keys\nBitbucket.org,[git.example.com]:22 {key} comment\n"
            f"[git.example.com]:2222 {key}\n",
            "prefixes": ["git@bitbucket.org:team/", "https://github.com/public-team/"],
        },
    )
    assert response.status_code == 200, response.text
    settings = response.json()
    assert settings["known_hosts"] == f"bitbucket.org,git.example.com {key}\n[git.example.com]:2222 {key}\n"
    assert [entry["hosts"] for entry in settings["host_keys"]] == [
        ["bitbucket.org", "git.example.com"],
        ["[git.example.com]:2222"],
    ]
    assert settings["host_keys"][0]["fingerprint"].startswith("SHA256:")
    assert client.get("/api/git-hosts").json() == settings
    for text, message in [
        (f"|1|abc|def {key}", "hashed"),
        (f"@cert-authority *.example.com {key}", "markers"),
        (f"*.example.com {key}", "wildcards"),
        (f"!bad.example.com {key}", "wildcards"),
        ("git.example.com ssh-ed25519 AAAAinvalid", "invalid"),
        ("git.example.com ssh-dss AAAAB3NzaC1kc3M=", "unsupported"),
        ("git.example.com", "format"),
    ]:
        with pytest.raises(Problem, match=message):
            parse_known_hosts(text)
    for prefix in [
        "https://github.com",
        "https://github.com/team",
        "git@bitbucket.org",
        "https://",
        "file:///",
    ]:
        with pytest.raises(Problem, match="URL prefixes"):
            validate_prefix(prefix)
    for prefix in ["https://github.com/", "git@bitbucket.org:", "ssh://git@git.example.com:2222/team/"]:
        assert validate_prefix(prefix) == prefix
    assert (
        client.put("/api/git-hosts", json={"known_hosts": "", "prefixes": ["https://x"]}).status_code == 400
    )


def test_origins_outside_trusted_hosts_and_prefixes_are_refused(team):
    app, client, worktree, (_, owner), _, _ = team
    credentials = app.state.services.projects.remotes.credentials
    assert configure(client, owner, worktree, "git@git.example.com:any/repo.git").status_code == 200
    assert configure(client, owner, worktree, "ssh://git@git.example.com/any/repo.git").status_code == 200
    for url in [
        "git@other.example.com:any/repo.git",
        "ssh://git@git.example.com:2222/any/repo.git",
        # Without credentials, HTTPS still requires an explicitly allowed prefix.
        "https://git.example.com/any/repo.git",
        "https://internal.example.com/repo.git",
    ]:
        response = configure(client, owner, worktree, url)
        assert response.status_code == 422 and "not allowed" in response.json()["error"], url
    credentials.save_hosts(
        credentials.known_hosts(), ["git@git.example.com:team/", "https://public.example.com/team/"]
    )
    assert configure(client, owner, worktree, "git@git.example.com:team/repo.git").status_code == 200
    assert configure(client, owner, worktree, "https://public.example.com/team/repo.git").status_code == 200
    for url in [
        "git@git.example.com:other/repo.git",
        "git@git.example.com:team/../other/repo.git",
        "https://public.example.com/team/../../other/repo.git",
        "https://public.example.com/team/./repo.git",
        "https://public.example.com.evil.example/team/repo.git",
        # A prefix never trusts an SSH host that has no trusted host key.
        "ssh://git@public.example.com/team/repo.git",
    ]:
        assert configure(client, owner, worktree, url).status_code == 422, url
    # An origin that is no longer allowed cannot synchronize.
    credentials.save_hosts(credentials.known_hosts(), ["git@git.example.com:team/"])
    response = fetch(client, owner, worktree)
    assert response.status_code == 409 and "not allowed" in response.json()["error"]


def test_fetch_and_push_require_the_requesting_account_key_and_consent(team):
    app, client, worktree, (_, owner_headers), (editor, editor_headers), calls = team
    url = "git@git.example.com:team/repo.git"
    assert configure(client, owner_headers, worktree, url).status_code == 200
    response = fetch(client, editor_headers, worktree)
    assert response.status_code == 409 and response.json()["detail"] == {"ssh_key_required": True}
    assert "User settings" in response.json()["error"]
    assert call(client, editor_headers, "POST", "/ssh-key").status_code == 200
    response = fetch(client, editor_headers, worktree)
    assert response.status_code == 409
    assert response.json()["detail"] == {"consent_required": {"url": url}}
    assert not calls
    # Consent is bound to the exact displayed URL.
    response = consent(client, editor_headers, worktree, "git@git.example.com:team/other.git")
    assert response.status_code == 409
    assert consent(client, editor_headers, worktree, url).json() == {"url": url}
    assert fetch(client, editor_headers, worktree).status_code == 200
    credentials = app.state.services.projects.remotes.credentials
    assert calls[-1]["key"] == credentials.private_key(editor["id"])
    assert calls[-1]["args"][0] == "fetch"

    # The administrator's own key cannot use the editor's consent.
    assert call(client, owner_headers, "POST", "/ssh-key").status_code == 200
    response = fetch(client, owner_headers, worktree)
    assert response.json()["detail"] == {"consent_required": {"url": url}}

    # Every origin change requires new consent, including a return to an earlier URL.
    other = "git@git.example.com:team/other.git"
    assert configure(client, owner_headers, worktree, other).status_code == 200
    assert fetch(client, editor_headers, worktree).json()["detail"] == {"consent_required": {"url": other}}
    assert configure(client, owner_headers, worktree, url).status_code == 200
    assert fetch(client, editor_headers, worktree).json()["detail"] == {"consent_required": {"url": url}}
    assert consent(client, editor_headers, worktree, url).status_code == 200

    status = fetch(client, editor_headers, worktree).json()
    assert status["transport"] == "ssh" and status["state"] == "new_remote_branch"
    calls.clear()
    response = call(
        client,
        editor_headers,
        "POST",
        f"/worktrees/{worktree['id']}/git/push",
        json={
            "config_revision": status["config_revision"],
            "local_head": status["local_head"],
            "remote_head": None,
        },
    )
    assert response.status_code == 200, response.text
    assert [c["args"][0] for c in calls] == ["ls-remote", "push"]
    assert all(c["key"] == credentials.private_key(editor["id"]) for c in calls)

    # Regenerating replaces the key used by the next operation; deleting it stops synchronization.
    previous = credentials.private_key(editor["id"])
    call(client, editor_headers, "POST", "/ssh-key")
    fetch(client, editor_headers, worktree)
    assert calls[-1]["key"] not in (None, previous)
    call(client, editor_headers, "DELETE", "/ssh-key")
    assert fetch(client, editor_headers, worktree).json()["detail"] == {"ssh_key_required": True}


def test_https_origins_run_without_credentials_or_consent(team):
    app, client, worktree, (_, owner_headers), (_, editor_headers), calls = team
    credentials = app.state.services.projects.remotes.credentials
    credentials.save_hosts(credentials.known_hosts(), ["https://public.example.com/"])
    assert (
        configure(client, owner_headers, worktree, "https://public.example.com/repo.git").status_code == 200
    )
    response = fetch(client, editor_headers, worktree)
    assert response.status_code == 200 and response.json()["transport"] == "https"
    assert calls[-1]["key"] is None


def test_project_deletion_forgets_consents(team):
    app, client, worktree, (_, owner_headers), (_, editor_headers), _ = team
    url = "git@git.example.com:team/repo.git"
    configure(client, owner_headers, worktree, url)
    consent(client, editor_headers, worktree, url)
    store = app.state.services.store
    assert store.all("git_consent")
    assert call(client, owner_headers, "DELETE", f"/projects/{worktree['project']}").status_code == 200
    assert not store.all("git_consent")


def test_network_git_isolates_server_credentials(team, monkeypatch, tmp_path):
    app, _, worktree, _, _, _ = team
    remotes = app.state.services.projects.remotes
    del remotes.network
    monkeypatch.setenv("SSH_AUTH_SOCK", str(tmp_path / "agent.sock"))
    monkeypatch.setenv("GIT_SSH_COMMAND", "ssh -i /server/key")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "server.gitconfig"))
    monkeypatch.setenv("GIT_ASKPASS", "/server/askpass")
    monkeypatch.setenv("GIT_SSL_CAINFO", "/etc/company-ca.pem")
    seen = {}

    def run(command, env, **kwargs):
        ssh = shlex.split(env["GIT_SSH_COMMAND"])
        identity = Path(ssh[ssh.index("-i") + 1])
        known_hosts = next(o.split("=", 1)[1] for o in ssh if o.startswith("UserKnownHostsFile="))
        seen.update(
            command=command,
            env=env,
            ssh=ssh,
            identity=identity,
            mode=identity.stat().st_mode & 0o777 if identity.exists() else None,
            key=identity.read_text() if identity.exists() else None,
            known_hosts=Path(known_hosts).read_text(),
        )
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(subprocess, "run", run)
    path = Path(app.state.services.store.get("worktree", worktree["id"])["path"])
    remotes.network(path, "ls-remote", "--", "git@git.example.com:team/repo.git", key="account key")
    env, ssh, command = seen["env"], seen["ssh"], seen["command"]
    assert seen["mode"] == 0o600 and seen["key"] == "account key"
    assert seen["known_hosts"] == remotes.credentials.known_hosts()
    assert not seen["identity"].exists() and not seen["identity"].parent.exists()
    assert seen["identity"].parent.parent == app.state.services.store.home / "git-network"
    assert ssh[:3] == ["ssh", "-F", os.devnull]
    for option in [
        "IdentitiesOnly=yes",
        "IdentityAgent=none",
        "GSSAPIAuthentication=no",
        f"GlobalKnownHostsFile={os.devnull}",
        "StrictHostKeyChecking=yes",
        "BatchMode=yes",
    ]:
        assert option in ssh
    assert "SSH_AUTH_SOCK" not in env and "GIT_ASKPASS" in env and not env["GIT_ASKPASS"]
    assert env["GIT_CONFIG_GLOBAL"] == os.devnull and env["GIT_CONFIG_NOSYSTEM"] == "1"
    assert env["HOME"] == str(seen["identity"].parent) and env["GIT_SSL_CAINFO"] == "/etc/company-ca.pem"
    settings = [command[i + 1] for i, value in enumerate(command) if value == "-c"]
    assert {"credential.helper=", "protocol.allow=never", "protocol.ssh.allow=always"} <= set(settings)
    assert env["KRB5CCNAME"].startswith("FILE:" + env["HOME"]) and env["KRB5_CLIENT_KTNAME"] == os.devnull

    remotes.network(path, "ls-remote", "--", "https://public.example.com/repo.git")
    settings = [seen["command"][i + 1] for i, value in enumerate(seen["command"]) if value == "-c"]
    assert "protocol.https.allow=always" in settings and "protocol.ssh.allow=always" not in settings
    assert seen["key"] is None


def tls_certificate(directory):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), False
        )
        .sign(key, hashes.SHA256())
    )
    cert, private = directory / "cert.pem", directory / "key.pem"
    cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    private.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
    )
    return cert, private


def test_https_never_retries_with_server_authentication(team, monkeypatch, tmp_path):
    """A 401 offering Negotiate must not trigger a retry that could use the server's Kerberos ticket."""
    app, _, worktree, _, _, _ = team
    cert, private = tls_certificate(tmp_path)
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.headers.get("Authorization"))
            self.send_response(401)
            self.send_header("WWW-Authenticate", "Negotiate")
            self.send_header("WWW-Authenticate", 'Basic realm="git"')
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, private)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv("GIT_SSL_CAINFO", str(cert))
        remotes = app.state.services.projects.remotes
        del remotes.network
        path = app.state.services.store.get("worktree", worktree["id"])["path"]
        url = f"https://127.0.0.1:{server.server_address[1]}/team/repo.git"
        with pytest.raises(Problem, match="requires authentication"):
            remotes.network(path, "ls-remote", "--", url)
        assert requests == [None]
    finally:
        server.shutdown()
        server.server_close()


def test_key_copies_left_by_a_crash_are_removed_at_startup(tmp_path):
    home = tmp_path / "instance"
    services = Services.open(home)
    folder = services.projects.remotes.temporary
    services.close()
    stale, recent = folder / "tmpstale", folder / "tmprecent"
    for directory in (stale, recent):
        directory.mkdir()
        (directory / "identity").write_text("private")
    old = time.time() - 3600
    os.utime(stale, (old, old))
    services = Services.open(home)
    services.close()
    assert not stale.exists() and recent.exists()
