"""Embedded execution engine: one facade over the execution services, which it wires and
keeps consistent when worktrees, projects, connections or extensions change."""

from __future__ import annotations

import threading
from collections.abc import Generator
from contextlib import AbstractContextManager, contextmanager, nullcontext
from typing import BinaryIO

import duckdb

from . import project_extensions
from .access import Access
from .catalog import Catalog
from .datasets import Context
from .execution.contexts import ContextPool
from .execution.exports import Exports
from .execution.fingerprints import Fingerprints
from .execution.results import Results
from .execution.runs import Runner
from .extensions import MAX_UPLOAD_BYTES, database_config, install, runtime
from .projects import Projects
from .store import Store
from .types import Record, RunToken
from .util import Problem


class Engine:
    def __init__(
        self,
        store: Store,
        projects: Projects,
        catalog: Catalog,
        access: Access | None = None,
        *,
        trusted_local: bool = False,
    ) -> None:
        self.store, self.projects, self.catalog, self.access = store, projects, catalog, access
        # API authorization is independent of the explicitly selected SQL execution mode.
        self.isolated = access is not None and not trusted_local
        self.lock = threading.RLock()
        # The token of each worktree's active run, admitted by the runner under the lock.
        self.active: dict[str, RunToken] = {}
        self.fingerprints = Fingerprints(projects, catalog)
        self.pool = ContextPool(store, projects, catalog, access, self.isolated, self.lock)
        self.exports = Exports(store, projects, catalog, access, self.fingerprints, self.lock, self.active)
        self.results = Results(store, projects, catalog, self.pool, self.lock, self.active)
        self.runs = Runner(
            store,
            projects,
            catalog,
            self.pool,
            self.exports,
            self.fingerprints,
            self.lock,
            self.active,
            isolated=self.isolated,
        )
        self.runs.recover()

    def context(self, worktree: str, environment: str, create: bool = False) -> Context:
        return self.pool.get(worktree, environment, create)

    def launch(
        self, worktree: str, environment: str, target: str | None = None, entry_point: str = "api"
    ) -> Record:
        return self.runs.launch(worktree, environment, target, entry_point)

    def scope_variables(self, worktree: str, environment: str, target: str | None = None) -> Record:
        return self.runs.scope_variables(worktree, environment, target)

    def cancel(self, run_id: str) -> Record:
        return self.runs.cancel(run_id)

    def statuses(self, worktree: str, environment: str) -> Record:
        return self.results.statuses(worktree, environment)

    def preview(
        self,
        worktree: str,
        environment: str,
        node: str,
        port: str = "result",
        limit: int = 100,
        offset: int = 0,
        sort: str | None = None,
        descending: bool = False,
        filters: Record | None = None,
    ) -> Record:
        return self.results.preview(
            worktree, environment, node, port, limit, offset, sort, descending, filters
        )

    def generation_valid(self, worktree: str, environment: str, dataset_id: str) -> bool:
        return self.results.generation_valid(worktree, environment, dataset_id)

    def compile(self, worktree: str, environment: str, node: str) -> list[Record]:
        return self.results.compile(worktree, environment, node)

    def export_result(self, worktree: str, environment: str, node: str) -> Record:
        return self.exports.result(worktree, environment, node)

    def open_export(
        self, worktree: str, environment: str, node: str, run: str
    ) -> AbstractContextManager[tuple[BinaryIO, Record]]:
        return self.exports.open(worktree, environment, node, run)

    @contextmanager
    def exclusive(self, project: str | None = None) -> Generator[None, None, None]:
        """Hold a project's repository lock when given, then the engine lock.

        Changes that reset execution state take this pair, always in this order.
        """
        with self.projects.repository(project) if project else nullcontext(), self.lock:
            yield

    def require_idle(self, worktree: str) -> None:
        """Refuse a change that would remove a worktree during its execution."""
        with self.lock:
            if worktree in self.active:
                raise Problem("Stop the worktree's execution before removing it", 409)

    def discard_worktree(self, worktree: str) -> None:
        """Release every environment context, even after its worktree was removed."""
        with self.lock:
            self.require_idle(worktree)
            self.pool.discard(worktree)

    def reset_project(self, project: str) -> None:
        with self.lock:
            worktrees = {w["id"] for w in self.store.worktrees(project)}
            if worktrees & self.active.keys():
                raise Problem(
                    "Stop active executions before changing project connections or deleting the project", 409
                )
            for worktree in worktrees:
                self.pool.discard(worktree)

    def reset_catalog(self) -> None:
        with self.lock:
            if self.active:
                raise Problem("Stop active executions before changing connections", 409)
            for project in self.store.all("project"):
                self.reset_project(project["id"])

    def invalidate(self, worktree: str | None = None) -> None:
        """Mark results of changed definitions stale.

        It takes no repository lock, since catalog changes call it under the engine lock. Project
        changes call it under their repository lock, which publication also holds.
        """
        for context in self.pool.all(worktree):
            if not self.store.get("worktree", context.worktree):
                self.discard_worktree(context.worktree)
                continue
            self.pool.mark_stale(context, self.fingerprints.current(context.worktree, context.environment))

    def extension_settings(self) -> dict[str, bool]:
        return self.pool.extension_settings()

    def extension_runtime(self) -> Record:
        version, platform = runtime()
        return {
            "version": version,
            "platform": platform,
            "max_upload_bytes": MAX_UPLOAD_BYTES,
            "imports": list(self.store.get("settings", "offline_extensions", {}).values()),
        }

    def project_extensions(self, worktree: str) -> Record:
        bundle = self.projects.snapshot(worktree, committed=True)["bundle"]
        if bundle is None:
            raise Problem("Correct the project files in Code before managing extensions", 422)
        declared = project_extensions.declarations(bundle.get("extensions"))
        config = {**database_config(self.store.paths.extensions), **self.extension_settings(), "threads": 1}
        imports = self.store.get("settings", "offline_extensions", {})
        with duckdb.connect(config=config) as db:
            available = project_extensions.installed(db)
        entries = []
        for name, item in sorted(declared.items()):
            result = project_extensions.resolve(
                {"name": name, **item},
                imports,
                available,
                config["allow_unsigned_extensions"],
                self.store.paths.extensions,
            )
            entries.append({"name": name, **item, **{k: v for k, v in result.items() if k != "sql"}})
        version, platform = runtime()
        return {"version": version, "platform": platform, "requirements": entries}

    def check_project_extension(self, worktree: str, name: str, source: str) -> Record:
        self.projects.get(worktree)
        project_extensions.declarations({name: {"source": source, "enabled": True}})
        config = {**database_config(self.store.paths.extensions), **self.extension_settings()}
        project_extensions.check(
            config, [{"name": name, "source": source}], self.store.get("settings", "offline_extensions", {})
        )
        return {"status": "ready"}

    def import_extension(self, filename: str | None, source: str, stream: BinaryIO) -> Record:
        with self.exclusive():
            if self.active:
                raise Problem("Stop active executions before importing extensions", 409)
            entry = install(
                self.store.paths.extensions,
                filename,
                source,
                stream,
                self.extension_settings()["allow_unsigned_extensions"],
                self.reset_catalog,
            )
            installed = self.store.get("settings", "offline_extensions", {})
            installed[entry["name"]] = entry
            self.store.put("settings", "offline_extensions", installed)
            return self.extension_runtime()

    def configure_extensions(self, allow_unsigned: bool) -> dict[str, bool]:
        with self.exclusive():
            if self.extension_settings()["allow_unsigned_extensions"] == allow_unsigned:
                return self.extension_settings()
            if self.active:
                raise Problem("Stop active executions before changing extension settings", 409)
            # Loaded native code cannot be unloaded from a live DuckDB instance.
            self.reset_catalog()
            self.store.put("settings", "allow_unsigned_extensions", allow_unsigned)
            return self.extension_settings()

    def close(self) -> None:
        """Cancel active runs, wait for their workers, then close every context."""
        self.runs.close()
        self.pool.close()
