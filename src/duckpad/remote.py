"""Explicit, bounded network Git with installation-owned configuration and leases."""

import os
import re
import subprocess
from urllib.parse import urlsplit

from .bundle import files_to_bundle, validate
from .util import Problem, digest, now, uid

NETWORK_TIMEOUT = 30


def validate_url(value):
    message = (
        "Use a credential-free HTTPS or SSH repository URL. Configure authentication on the Duckpad server."
    )
    if not isinstance(value, str) or len(value) > 2048 or any(c.isspace() for c in value):
        raise Problem(message)
    if re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./~-]+", value):
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


class Remotes:
    def __init__(self, workspace):
        self.workspace = workspace
        self.projects = workspace.projects
        self.store = workspace.store
        self.git = workspace.git

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
                self.git(worktree["path"], "check-ref-format", "refs/heads/" + remote_branch)
            changed = (url or None) != config["url"]
            if changed:
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

    def network(self, path, *args):
        env = {
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GCM_INTERACTIVE": "Never",
            "GIT_SSH_COMMAND": "ssh -oBatchMode=yes -oConnectTimeout=10 -oStrictHostKeyChecking=yes",
        }
        command = [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.file.allow=never",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "http.followRedirects=false",
            "-c",
            "http.lowSpeedLimit=1000",
            "-c",
            "http.lowSpeedTime=15",
            "-c",
            "fetch.fsckObjects=true",
            "-C",
            str(path),
            *args,
        ]
        try:
            result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=NETWORK_TIMEOUT)
        except subprocess.TimeoutExpired as error:
            raise Problem(
                "Git network operation timed out. Check server connectivity, then fetch again.", 504
            ) from error
        if result.returncode:
            text = result.stderr.lower()
            if any(
                word in text
                for word in (
                    "authentication",
                    "permission denied",
                    "could not read username",
                    "host key verification",
                    "repository not found",
                )
            ):
                raise Problem(
                    "Git authentication failed. Ask the server operator to configure repository access and trusted SSH hosts, then fetch again.",
                    502,
                )
            if any(word in text for word in ("stale info", "rejected", "non-fast-forward")):
                raise Problem(
                    "The remote changed or rejected the push. Fetch and review incoming changes before retrying.",
                    409,
                )
            # Remote stderr can contain credentials, private paths or attacker-controlled text.
            raise Problem(
                "Git network operation failed. Check the repository URL and server connectivity, then fetch again.",
                502,
            )
        return result.stdout.strip()

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
            }

    def fetch(self, worktree_id, expected):
        with self.projects.lock:
            worktree = self.projects.get(worktree_id)
            config = self.checked_config(worktree, expected)
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

    def push(self, worktree_id, expected, local_head, remote_head, recreate=False):
        with self.projects.lock:
            worktree = self.projects.get(worktree_id)
            config = self.checked_config(worktree, expected)
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
            actual = self.network(worktree["path"], "ls-remote", "--refs", "--", config["url"], ref)
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
            )
            self.git(worktree["path"], "update-ref", status["remote_ref"], local_head)
            config.update(
                checked=now(),
                version=uid(),
                seen=sorted(set(config.get("seen", [])) | {status["remote_branch"]}),
            )
            self.store.put("git_remote", worktree["project"], config)
            return self.status(worktree_id)
