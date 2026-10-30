"""Embedded execution engine: one facade over the execution services, which it wires and
keeps consistent when worktrees, projects, connections or extensions change."""

import threading
from contextlib import contextmanager, nullcontext

from .execution.contexts import ContextPool
from .execution.exports import Exports
from .execution.fingerprints import Fingerprints
from .execution.results import Results
from .execution.runs import Runner
from .extensions import MAX_UPLOAD_BYTES, install, runtime
from .util import Problem


class Engine:
    def __init__(self, store, projects, catalog, access=None, *, trusted_local=False):
        self.store, self.projects, self.catalog, self.access = store, projects, catalog, access
        # API authorization is independent of the explicitly selected SQL execution mode.
        self.isolated = access is not None and not trusted_local
        self.lock = threading.RLock()
        # The token of each worktree's active run, admitted by the runner under the lock.
        self.active = {}
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

    def context(self, worktree, environment, create=False):
        return self.pool.get(worktree, environment, create)

    def launch(self, worktree, environment, target=None, entry_point="api"):
        return self.runs.launch(worktree, environment, target, entry_point)

    def cancel(self, run_id):
        return self.runs.cancel(run_id)

    def statuses(self, worktree, environment):
        return self.results.statuses(worktree, environment)

    def preview(self, worktree, environment, node, *args, **options):
        return self.results.preview(worktree, environment, node, *args, **options)

    def generation_valid(self, worktree, environment, dataset_id):
        return self.results.generation_valid(worktree, environment, dataset_id)

    def compile(self, worktree, environment, node):
        return self.results.compile(worktree, environment, node)

    def export_result(self, worktree, environment, node):
        return self.exports.result(worktree, environment, node)

    def open_export(self, worktree, environment, node, run):
        return self.exports.open(worktree, environment, node, run)

    @contextmanager
    def exclusive(self, project=None):
        """Hold a project's repository lock when given, then the engine lock.

        Changes that reset execution state take this pair, always in this order.
        """
        with self.projects.repository(project) if project else nullcontext(), self.lock:
            yield

    def require_idle(self, worktree):
        """Refuse a change that would remove a worktree during its execution."""
        with self.lock:
            if worktree in self.active:
                raise Problem("Stop the worktree's execution before removing it", 409)

    def discard_worktree(self, worktree):
        """Release every environment context, even after its worktree was removed."""
        with self.lock:
            self.require_idle(worktree)
            self.pool.discard(worktree)

    def reset_project(self, project):
        with self.lock:
            worktrees = {w["id"] for w in self.store.worktrees(project)}
            if worktrees & self.active.keys():
                raise Problem(
                    "Stop active executions before changing project connections or deleting the project", 409
                )
            for worktree in worktrees:
                self.pool.discard(worktree)

    def reset_catalog(self):
        with self.lock:
            if self.active:
                raise Problem("Stop active executions before changing connections", 409)
            for project in self.store.all("project"):
                self.reset_project(project["id"])

    def invalidate(self, worktree=None):
        """Mark results of changed definitions stale.

        It takes no repository lock, since catalog changes call it under the engine lock. Project
        changes call it under their repository lock, which publication also holds.
        """
        for context in self.pool.all(worktree):
            if not self.store.get("worktree", context.worktree):
                self.discard_worktree(context.worktree)
                continue
            self.pool.mark_stale(context, self.fingerprints.current(context.worktree, context.environment))

    def extension_settings(self):
        return self.pool.extension_settings()

    def extension_runtime(self):
        version, platform = runtime()
        return {
            "version": version,
            "platform": platform,
            "max_upload_bytes": MAX_UPLOAD_BYTES,
            "imports": list(self.store.get("settings", "offline_extensions", {}).values()),
        }

    def import_extension(self, filename, source, stream):
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

    def configure_extensions(self, allow_unsigned):
        with self.exclusive():
            if self.extension_settings()["allow_unsigned_extensions"] == allow_unsigned:
                return self.extension_settings()
            if self.active:
                raise Problem("Stop active executions before changing extension settings", 409)
            # Loaded native code cannot be unloaded from a live DuckDB instance.
            self.reset_catalog()
            self.store.put("settings", "allow_unsigned_extensions", allow_unsigned)
            return self.extension_settings()

    def close(self):
        """Cancel active runs, wait for their workers, then close every context."""
        self.runs.close()
        self.pool.close()
