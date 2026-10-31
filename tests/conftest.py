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
