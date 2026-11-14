"""Connection permissions and setup for explicitly isolated or embedded execution."""

from __future__ import annotations

from .. import connection_probe
from ..access import Access
from ..catalog import Catalog, redact
from ..datasets import Context
from ..extensions import database_config
from ..projects import Projects
from ..store import Store
from ..types import Connections, Record, SQLCursor
from ..util import Problem


class ConnectionConfig:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        catalog: Catalog,
        access: Access,
        *,
        isolated: bool,
        enforce_access: bool,
    ) -> None:
        self.store, self.projects, self.catalog, self.access = store, projects, catalog, access
        self.isolated, self.enforce_access = isolated, enforce_access

    def capture(
        self, worktree: str, references: list[str], environment: str
    ) -> tuple[Connections, list[str]]:
        if self.enforce_access:
            self.access.connections(self.projects.get(worktree)["project"], references)
        return self.catalog.capture(references, environment)

    def configured(self, project: str, environment: str) -> tuple[Connections, list[str]]:
        """Freeze configured connections before an isolated worker locks its settings."""
        if not self.isolated:
            return {}, []
        captured: Connections = {}
        secrets: list[str] = []
        for reference in self.access.record(project)["connections"]:
            try:
                values, hidden = self.catalog.capture([reference], environment)
            except Problem:
                continue
            captured.update(values)
            secrets.extend(hidden)
        return captured, secrets

    def for_context(
        self, context: Context, references: list[str], secrets: list[str], *, require_attached: bool = False
    ) -> Connections:
        if self.isolated and all(r in context.connections for r in references):
            return {r: context.connections[r] for r in references}
        captured, hidden = self.capture(context.worktree, references, context.environment)
        secrets.extend(hidden)
        if self.isolated and require_attached:
            raise Problem("Run this node once to attach its connection, then preview it again", 409)
        return captured

    def extension_settings(self) -> dict[str, bool]:
        return {"allow_unsigned_extensions": self.store.get("settings", "allow_unsigned_extensions", False)}

    def probe_config(self) -> Record:
        self.store.paths.extensions.mkdir(exist_ok=True)
        return {**database_config(self.store.paths.extensions), **self.extension_settings()}

    def check_extensions(self, captured: Connections, secrets: list[str]) -> None:
        """Probe in a child process so a bad extension cannot stop the backend."""
        imports = self.store.get("settings", "offline_extensions", {})
        for connection in captured.values():
            try:
                connection_probe.check_extensions(self.probe_config(), connection, imports, secrets)
            except Problem as error:
                raise Problem(
                    f"Cannot load the extensions of connection {connection['name']}: {redact(str(error), secrets)}",
                    422,
                ) from None

    def prepare(
        self,
        cursor: SQLCursor,
        captured: Connections,
        secrets: list[str],
        *,
        reuse: bool = False,
        setup: bool = True,
    ) -> None:
        if self.isolated:
            return
        for reference, connection in captured.items():
            if reuse and connection_probe.attached(cursor, connection["alias"]):
                continue
            if not setup:
                raise Problem("Run this node once to attach its connection, then preview it again", 409)
            self.check_extensions({reference: connection}, secrets)
            self.catalog.prepare(cursor, {reference: connection})

    def validate_roots(self, captured: Connections, project: str | None = None) -> None:
        if self.isolated:
            self.access.database_roots(captured, project)
