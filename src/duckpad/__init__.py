"""Duckpad: local SQL pipelines with execution-bound lineage."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("duckpad")
except PackageNotFoundError:  # pragma: no cover - only when imported from an uninstalled source tree
    __version__ = "0.0.0"
