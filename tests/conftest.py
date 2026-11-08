import duckdb
import pytest
from pydantic_ai import models

from duckpad.services import Services

# Unit tests must never contact paid model APIs.
models.ALLOW_MODEL_REQUESTS = False


@pytest.fixture
def services(tmp_path):
    instance = Services.open(tmp_path / "instance")
    yield instance.store, instance.projects, instance.catalog, instance.engine
    instance.close()


@pytest.fixture(scope="session")
def excel_cache(tmp_path_factory):
    """An extension cache holding excel, as an instance administrator would install it."""
    cache = tmp_path_factory.mktemp("excel-extensions")
    with duckdb.connect(config={"extension_directory": str(cache)}) as db:
        db.execute("INSTALL excel")
        db.execute("LOAD excel")
    return cache
