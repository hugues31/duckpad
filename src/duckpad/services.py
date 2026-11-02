"""Wiring of the instance services shared by the HTTP API, tests and scripts."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .access import Access
from .catalog import Catalog
from .engine import Engine
from .lineage import Lineage
from .projects import Projects
from .store import Store


@dataclass
class Services:
    store: Store
    projects: Projects
    catalog: Catalog
    engine: Engine
    lineage: Lineage

    @classmethod
    def open(cls, home: Path, *, enforce_access: bool = False, trusted_local: bool = False) -> Services:
        store = Store(home)
        projects, catalog = Projects(store), Catalog(store)
        engine = Engine(
            store,
            projects,
            catalog,
            access=Access(store) if enforce_access else None,
            trusted_local=trusted_local,
        )
        # Definition and connection edits mark dependent results stale.
        projects.on_change = engine.invalidate
        catalog.on_change = engine.invalidate
        return cls(store, projects, catalog, engine, Lineage(engine))

    def close(self) -> None:
        self.projects.stop()
        self.engine.close()
        self.store.close()
