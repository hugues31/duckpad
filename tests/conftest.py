import pytest

from duckpad.services import Services


@pytest.fixture
def services(tmp_path):
    instance = Services.open(tmp_path / "instance")
    yield instance.store, instance.projects, instance.catalog, instance.engine
    instance.close()
