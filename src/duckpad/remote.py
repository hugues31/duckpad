"""Explicit, bounded network Git with per-account credentials and leases."""

import os
import re
import shlex
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from . import git_command
from .bundle import files_to_bundle, validate
from .git_command import GitError, GitTimeout
from .git_credentials import SCP_URL, GitCredentials, transport
from .util import Problem, digest, now, uid

NETWORK_TIMEOUT = 30
# Every Git command drops the server's Git, SSH and credential-manager variables except these.
INHERITED_GIT_VARIABLES = {"GIT_SSL_CAINFO", "GIT_SSL_CAPATH"}


def validate_url(value):
    message = "Use a credential-free HTTPS or SSH repository URL."
    if not isinstance(value, str) or len(value) > 2048 or any(c.isspace() for c in value):
        raise Problem(message)
    if value.startswith("-") or "@-" in value or "//-" in value:
        raise Problem(message)
    if SCP_URL.fullmatch(value):
        return value
    try:
        url = urlsplit(value)
        valid = (
            url.scheme in ("https", "ssh") and url.hostname and re.fullmatch(r"[A-Za-z0-9.:-]+", url.hostname)
        )
        valid = (
            valid
            and not (url.password or url.query or url.fragment)
            and url.path not in ("", "/")
            and re.fullmatch(r"/[A-Za-z0-9_./~-]+", url.path)
        )
        valid = valid and (
            not url.username
            if url.scheme == "https"
            else not url.username or re.fullmatch(r"[A-Za-z0-9_.-]+", url.username)
        )
        if not valid or (url.port is not None and not 1 <= url.port <= 65535):
            raise ValueError
    except ValueError as error:
        raise Problem(message) from error
    return value


def network_environment(home, ssh_command):
    """Variables isolating one network Git process from the server account's credentials.

    They extend git_command.environment, which already ignores system and global Git configuration.
    """
    return {
        **{key: os.environ[key] for key in INHERITED_GIT_VARIABLES if key in os.environ},
        # A private HOME hides ~/.gitconfig, ~/.git-credentials and ~/.netrc from Git and curl.
        "HOME": home,
        "XDG_CONFIG_HOME": home,
        "GIT_ASKPASS": "",
        "SSH_ASKPASS_REQUIRE": "never",
        "GCM_INTERACTIVE": "Never",
        "GIT_SSH_COMMAND": ssh_command,
        "GIT_SSH_VARIANT": "ssh",
        # Kerberos must never authenticate with the server account's tickets or keytab.
        "KRB5CCNAME": f"FILE:{home}/no-kerberos-ticket",
        "KRB5_CLIENT_KTNAME": os.devnull,
    }


def ssh_command(identity, known_hosts):
    # -F /dev/null skips the user and system SSH configuration, including Host aliases and proxies.
    options = [
        "IdentitiesOnly=yes",
        "IdentityAgent=none",
        f"UserKnownHostsFile={known_hosts}",
        f"GlobalKnownHostsFile={os.devnull}",
        "StrictHostKeyChecking=yes",
        "UpdateHostKeys=no",
        "BatchMode=yes",
        "PreferredAuthentications=publickey",
        "GSSAPIAuthentication=no",
        "HostbasedAuthentication=no",
        "ControlPath=none",
        "ConnectTimeout=10",
    ]
    command = ["ssh", "-F", os.devnull, "-i", str(identity)]
    for option in options:
        command += ["-o", option]
    return shlex.join(command)


def network_problem(output, key):
    """A user message for a failed network Git command, which never echoes its output."""
    text = output.lower()
    if "host key verification" in text or "host key for" in text:
        return Problem(
            "The Git host's SSH key does not match this instance's trusted hosts. Ask an instance "
            "administrator to check the Git hosts settings.",
            502,
        )
    if any(
        word in text
        for word in (
            "authentication",
            "permission denied",
            "could not read username",
            "repository not found",
        )
    ):
        return Problem(
            "Git authentication failed. Add your Duckpad SSH public key to your account on the Git "
            "host, check that it can access this repository, then try again."
            if key
            else "This HTTPS repository requires authentication. Duckpad reads only public "
            "repositories over HTTPS; use an SSH origin with your personal key.",
            502,
        )
    if any(word in text for word in ("stale info", "rejected", "non-fast-forward")):
        return Problem(
            "The remote changed or rejected the push. Fetch and review incoming changes before retrying.",
            409,
        )
    # Remote stderr can contain credentials, private paths or attacker-controlled text.
    return Problem(
        "Git network operation failed. Check the repository URL and server connectivity, then fetch again.",
        502,
    )


class Remotes:
    def __init__(self, workspace):
        self.workspace = workspace
        self.projects = workspace.projects
        self.store = workspace.store
        self.git = workspace.git
        self.credentials = GitCredentials(self.store)
        self.temporary = self.store.home / "git-network"
        self.temporary.mkdir(mode=0o700, exist_ok=True)
        # Key copies of an operation interrupted by a crash must not outlive a restart.
        for leftover in self.temporary.iterdir():
            if leftover.stat().st_mtime < time.time() - 4 * NETWORK_TIMEOUT:
                shutil.rmtree(leftover, ignore_errors=True)

    def config(self, worktree):
        return self.store.get(
            "git_remote",
            worktree["project"],
            {"version": "disconnected", "url": None, "mappings": {}, "checked": None},
        )

    def checked_config(self, worktree, expected):
        config = self.config(worktree)
        if digest(config) != expected:
            raise Problem("Remote configuration or fetched state changed. Reload synchronization.", 409)
        if not config["url"]:
            raise Problem("Configure origin before synchronizing", 409)
        actual = self.git(worktree["path"], "config", "--get", "remote.origin.url", check=False)
        if actual != config["url"]:
            raise Problem("Origin was changed outside Duckpad. Review and save its configuration again.", 409)
        validate_url(config["url"])
        return config

    def configure(self, worktree_id, url, remote_branch, expected):
        with self.projects.lock:
            worktree = self.projects.get(worktree_id)
            config = self.config(worktree)
            if digest(config) != expected:
                raise Problem("Remote configuration changed. Reload before saving.", 409)
            if url:
                validate_url(url)
                self.credentials.check_origin(url)
                git_command.check_branch_name(worktree["path"], remote_branch)
            changed = (url or None) != config["url"]
            if changed:
                self.credentials.forget_project(worktree["project"])
                for branch in config["mappings"]:
                    for key in ("remote", "merge"):
                        self.git(
                            worktree["path"], "config", "--unset-all", f"branch.{branch}.{key}", check=False
                        )
            if url:
                self.git(worktree["path"], "config", "remote.origin.url", url)
                self.git(
                    worktree["path"], "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"
                )
                self.git(worktree["path"], "config", f"branch.{worktree['branch']}.remote", "origin")
                self.git(
                    worktree["path"],
                    "config",
                    f"branch.{worktree['branch']}.merge",
                    "refs/heads/" + remote_branch,
                )
            else:
                self.git(worktree["path"], "config", "--remove-section", "remote.origin", check=False)
            if changed:
                refs = self.git(
                    worktree["path"], "for-each-ref", "--format=%(refname)", "refs/remotes/origin/"
                ).splitlines()
                for ref in refs:
                    self.git(worktree["path"], "update-ref", "-d", ref)
            mappings = {} if changed else dict(config["mappings"])
            if url:
                mappings[worktree["branch"]] = remote_branch
            self.store.put(
                "git_remote",
                worktree["project"],
                {
                    "url": url or None,
                    "version": uid(),
                    "mappings": mappings,
                    "checked": None if changed else config.get("checked"),
                    "seen": [] if changed else config.get("seen", []),
                },
            )
            return self.status(worktree_id)

    def network(self, path, *args, key=None):
        """Run network Git with the given account key for SSH, or without credentials for HTTPS."""
        allowed = "ssh" if key else "https"
        settings = [
            "core.askPass=",
            "credential.helper=",
            # Without this, HTTPS retries a 401 with an empty user name, enabling Kerberos login.
            "http.emptyAuth=false",
            # Exactly one transport: SSH with the account key, or anonymous HTTPS.
            "protocol.allow=never",
            f"protocol.{allowed}.allow=always",
            "http.followRedirects=false",
            "http.lowSpeedLimit=1000",
            "http.lowSpeedTime=15",
            "fetch.fsckObjects=true",
        ]
        # The private key exists only in a private temporary directory for this one process.
        with tempfile.TemporaryDirectory(dir=self.temporary) as directory:
            identity, known_hosts = Path(directory, "identity"), Path(directory, "known_hosts")
            known_hosts.write_text(self.credentials.known_hosts(), encoding="utf-8")
            if key:
                with os.fdopen(os.open(identity, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
                    stream.write(key)
            try:
                return git_command.run(
                    path,
                    *args,
                    settings=settings,
                    env=network_environment(directory, ssh_command(identity, known_hosts)),
                    timeout=NETWORK_TIMEOUT,
                )
            except GitTimeout as error:
                raise Problem(
                    "Git network operation timed out. Check server connectivity, then fetch again.", 504
                ) from error
            except GitError as error:
                raise network_problem(error.output, key) from error

    def status(self, worktree_id):
        with self.projects.lock:
            worktree = self.projects.get(worktree_id)
            config = self.config(worktree)
            path = worktree["path"]
            local = self.workspace.resolve(path, "HEAD")
            branch = config["mappings"].get(worktree["branch"])
            remote_ref = "refs/remotes/origin/" + branch if branch else None
            remote = (
                self.git(path, "rev-parse", "--verify", "--end-of-options", remote_ref, check=False)
                if remote_ref
                else None
            )
            remote = remote or None
            actual = self.git(path, "config", "--get", "remote.origin.url", check=False)
            state, ahead, behind = "disconnected", None, None
            if config["url"]:
                state = "unverified"
                if actual == config["url"] and config.get("checked") and branch:
                    if not remote:
                        state = "remote_deleted" if branch in config.get("seen", []) else "new_remote_branch"
                    elif not self.git(path, "merge-base", local, remote, check=False):
                        state = "unrelated"
                    else:
                        ahead, behind = map(
                            int,
                            self.git(
                                path, "rev-list", "--left-right", "--count", f"{local}...{remote}"
                            ).split(),
                        )
                        state = (
                            "diverged"
                            if ahead and behind
                            else "ahead"
                            if ahead
                            else "behind"
                            if behind
                            else "up_to_date"
                        )
            try:
                self.workspace.clean(worktree)
                pending = None
            except Problem as error:
                pending = str(error)
            return {
                "name": "origin",
                "url": config["url"],
                "config_revision": digest(config),
                "local_branch": worktree["branch"],
                "remote_branch": branch,
                "local_head": local,
                "remote_head": remote,
                "remote_ref": remote_ref,
                "state": state,
                "ahead": ahead,
                "behind": behind,
                "checked": config.get("checked"),
                "pending": pending,
                "transport": transport(config["url"]),
            }

    def consent(self, worktree_id, user, url):
        """Record that this account allows its key to be used for the origin URL that it saw."""
        with self.projects.lock:
            worktree = self.projects.get(worktree_id)
            config = self.config(worktree)
            if not config["url"] or url != config["url"]:
                raise Problem("Origin changed. Review the new URL before confirming.", 409)
            self.credentials.consent(user["id"], worktree["project"], url)
            return {"url": url}

    def fetch(self, worktree_id, expected, user=None):
        with self.projects.lock:
            worktree = self.projects.get(worktree_id)
            config = self.checked_config(worktree, expected)
            key = self.credentials.credentials(user, worktree["project"], config["url"])
            self.network(
                worktree["path"],
                "fetch",
                "--atomic",
                "--prune",
                "--no-tags",
                "--no-recurse-submodules",
                "--",
                config["url"],
                "+refs/heads/*:refs/remotes/origin/*",
                key=key,
            )
            refs = self.git(
                worktree["path"], "for-each-ref", "--format=%(refname)", "refs/remotes/origin/"
            ).splitlines()
            config.update(
                checked=now(),
                version=uid(),
                seen=sorted(
                    set(config.get("seen", [])) | {r.removeprefix("refs/remotes/origin/") for r in refs}
                ),
            )
            self.store.put("git_remote", worktree["project"], config)
            return self.status(worktree_id)

    def pull(self, worktree_id, expected, local_head, remote_head):
        with self.projects.lock:
            worktree = self.projects.get(worktree_id)
            config = self.checked_config(worktree, expected)
            status = self.status(worktree_id)
            if (
                not config.get("checked")
                or status["local_head"] != local_head
                or status["remote_head"] != remote_head
            ):
                raise Problem("Displayed heads changed. Reload synchronization and review again.", 409)
            if not remote_head or not status["remote_ref"]:
                raise Problem("No fetched upstream branch. Fetch or choose a branch mapping.", 409)
            return self.workspace.prepare(worktree_id, status["remote_ref"], digest(config))

    def push(self, worktree_id, expected, local_head, remote_head, recreate=False, user=None):
        with self.projects.lock:
            worktree = self.projects.get(worktree_id)
            config = self.checked_config(worktree, expected)
            key = self.credentials.credentials(user, worktree["project"], config["url"])
            status = self.status(worktree_id)
            head, files = self.workspace.clean(worktree)
            if not config.get("checked") or not status["remote_branch"]:
                raise Problem("Fetch and choose an explicit remote branch before publishing.", 409)
            if head != local_head or status["remote_head"] != remote_head:
                raise Problem("Displayed heads changed. Reload before publishing.", 409)
            if status["state"] == "remote_deleted" and not recreate:
                raise Problem(
                    "The remote branch was deleted. Explicitly choose to recreate it before publishing.", 409
                )
            if remote_head and not self.workspace.ancestor(worktree["path"], remote_head, local_head):
                raise Problem(
                    "Push requires integration of the fetched remote head. Review a pull first.", 409
                )
            self.workspace.validate_history(worktree["path"], local_head)
            try:
                errors = validate(files_to_bundle(files))
            except (Problem, KeyError, TypeError, AttributeError) as error:
                raise Problem("Fix project definitions before publishing", 422) from error
            if errors:
                raise Problem("Fix project definitions before publishing", 422, errors)
            ref = "refs/heads/" + status["remote_branch"]
            actual = self.network(worktree["path"], "ls-remote", "--refs", "--", config["url"], ref, key=key)
            actual_head = actual.split()[0] if actual else None
            if actual_head != remote_head:
                raise Problem("Remote head changed. Fetch and review before publishing.", 409)
            if self.workspace.clean(worktree)[0] != local_head:
                raise Problem("Local head changed. Reload before publishing.", 409)
            # This lease is a compare-and-swap, never permission for a non-fast-forward update:
            # the ancestry check above is mandatory, and the server checks the exact expected head.
            self.network(
                worktree["path"],
                "push",
                "--porcelain",
                f"--force-with-lease={ref}:{remote_head or ''}",
                "--",
                config["url"],
                f"{local_head}:{ref}",
                key=key,
            )
            self.git(worktree["path"], "update-ref", status["remote_ref"], local_head)
            config.update(
                checked=now(),
                version=uid(),
                seen=sorted(set(config.get("seen", [])) | {status["remote_branch"]}),
            )
            self.store.put("git_remote", worktree["project"], config)
            return self.status(worktree_id)
