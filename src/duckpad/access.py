"""Instance roles, private project membership and connection grants."""

import threading
from pathlib import Path

from .auth import Auth
from .git_credentials import KEY_KIND
from .util import Problem

LEVELS = {"reader": 1, "editor": 2, "admin": 3}


class Access:
    def __init__(self, store):
        self.store = store
        self.membership_lock = threading.RLock()

    def role(self, user, project):
        if not self.store.get("project", project):
            return None
        if user["role"] == "admin":
            return "admin"
        return self.record(project)["members"].get(user["id"])

    def record(self, project):
        return self.store.get("access", project, {"members": {}, "connections": []})

    def require(self, user, project, role="reader"):
        actual = self.role(user, project)
        if actual is None:
            raise Problem("Project not found", 404)
        if LEVELS[actual] < LEVELS[role]:
            raise Problem("Your project role does not allow this action", 403)
        return actual

    def worktree(self, user, worktree, role="reader"):
        record = self.store.get("worktree", worktree)
        if not record:
            raise Problem("Worktree not found", 404)
        self.require(user, record["project"], role)
        return record["project"]

    @staticmethod
    def instance_admin(user):
        if user["role"] != "admin":
            raise Problem("Instance administrator access required", 403)

    def create(self, user, factory, sample=False):
        """Create a project that its creator administers; factory(grant) creates it.

        The project calls grant(worktree) in the transaction that records it, so a project never
        exists without its members and connection grants.
        """

        def grant(worktree):
            current = self.store.get("user", user["id"])
            if not current or not current["active"]:
                raise Problem("Authentication required", 401)
            defaults = ["local", "sample_" + worktree["project"]] if sample else ["local"]
            # Administrators may delete the default connection: new projects then start without it.
            self.own(worktree, user, [c for c in defaults if self.store.get("connection", c)])

        return factory(grant)

    def own(self, worktree, user, connections):
        self.store.put(
            "access", worktree["project"], {"members": {user["id"]: "admin"}, "connections": connections}
        )

    def validate_admins(self, members, users=None):
        users = users if users is not None else self.store.all("user")
        if not any(u["active"] and members.get(u["id"]) == "admin" for u in users):
            raise Problem("Keep at least one active project administrator", 409)

    def update_user(self, identity, data):
        allowed = {"role", "active", "password"}
        if not data or set(data) - allowed:
            raise Problem("Only role, active and password can be updated")
        if "role" in data and data["role"] not in ("admin", "member"):
            raise Problem("Unknown instance role")
        if "active" in data and not isinstance(data["active"], bool):
            raise Problem("Active must be a boolean")
        credentials = Auth.credentials(data["password"]) if "password" in data else {}
        with self.membership_lock, self.store.transaction():
            user = self.store.get("user", identity)
            if not user:
                raise Problem("User not found", 404)
            if user.get("oidc") and "password" in data:
                raise Problem("SSO accounts authenticate with their identity provider")
            if data.get("active") is False:
                user["session_version"] = user.get("session_version", 0) + 1
            user.update({k: v for k, v in data.items() if k != "password"})
            user.update(credentials)
            users = [user if u["id"] == identity else u for u in self.store.all("user")]
            if not any(u["active"] and u["role"] == "admin" for u in users):
                raise Problem("Keep at least one active instance administrator", 409)
            if not any(u["active"] and u["role"] == "admin" and not u.get("oidc") for u in users):
                raise Problem("Keep at least one active local administrator for SSO recovery", 409)
            for project in self.store.all("project"):
                self.validate_admins(self.record(project["id"])["members"], users)
            self.store.put("user", identity, user)
            if not user["active"]:
                # The account's SSH key must never authenticate again, even after reactivation.
                self.store.delete(KEY_KIND, identity)
        return Auth.public(user)

    def member(self, project, identity, role):
        if role is not None and role not in LEVELS:
            raise Problem("Unknown project role")
        with self.membership_lock, self.store.transaction():
            user = self.store.get("user", identity)
            if role is not None and (not user or not user["active"]):
                raise Problem("Choose an active user")
            record = self.record(project)
            if role is None:
                record["members"].pop(identity, None)
            else:
                record["members"][identity] = role
            self.validate_admins(record["members"])
            self.store.put("access", project, record)

    def connections(self, project, references):
        allowed = self.record(project)["connections"]
        if any(ref not in allowed for ref in references):
            raise Problem("Connection is not authorized for this project", 403)

    def grant_connections(self, project, references, *, before_change=None):
        if not isinstance(references, list) or any(
            not isinstance(r, str) or not self.store.get("connection", r) for r in references
        ):
            raise Problem("Choose existing connections")
        if before_change is not None:
            before_change()
        with self.store.transaction():
            record = self.record(project)
            record["connections"] = list(dict.fromkeys(references))
            self.store.put("access", project, record)

    def local_roots(self, project, captured):
        resource = self.store.paths.resources(project)
        resource.mkdir(parents=True, exist_ok=True)
        roots, writable = [resource], [resource]
        for connection in captured.values():
            root = connection["values"].get("root")
            if not root:
                continue
            path = Path(root).expanduser().resolve()
            # Instance credentials, Git metadata and other projects must never
            # become reachable through a mistakenly broad connection root.
            if self.store.home.is_relative_to(path) or (
                path.is_relative_to(self.store.home) and not path.is_relative_to(resource)
            ):
                raise Problem("Local connection roots must exclude instance metadata and other projects")
            if not path.is_dir():
                raise Problem("Local connection root must be an existing directory")
            roots.append(path)
            if "write" in connection["definition"].get("capabilities", []):
                writable.append(path)
        return roots, writable
