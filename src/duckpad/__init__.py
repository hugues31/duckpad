"""Duckpad: local SQL pipelines with execution-bound lineage."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("duckpad")
except PackageNotFoundError:  # pragma: no cover - only when imported from an uninstalled source tree
    __version__ = "0.0.0"

__all__ = [
    "Column",
    "Connection",
    "Date",
    "Destination",
    "File",
    "Node",
    "Outputs",
    "Relation",
    "SchemaName",
    "TableName",
    "param",
]


def __getattr__(name):
    if name in __all__:
        from . import python_sdk

        return getattr(python_sdk, name)
    raise AttributeError(name)
