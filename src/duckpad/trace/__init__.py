"""Provenance queries for one explained cell, rewritten over materialized dependencies.

Each SQL step is normalized (CTEs, derived tables and grouped windows become their own
materialized relations), then the visitor of its SQL construct traces it back to
contributing input cells. Provenance queries are built as SQLGlot expressions.
"""

from .coverage import Coverage
from .query import TraceQuery

__all__ = ["Coverage", "TraceQuery"]
