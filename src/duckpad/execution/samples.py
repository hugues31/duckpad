"""Samples of retained results: validated filters, sorts and seeded random rows, read on a
bounded cursor that never changes what runs compute."""

from __future__ import annotations

import threading
from collections.abc import Generator, Iterable
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from typing import Any

import duckdb
import sqlglot
from sqlglot import exp

from .. import variables
from ..datasets import Context, Dataset
from ..native import Cursor as NativeCursor
from ..templates import VARIABLE_REFERENCE, base_type, bind_variables, check_variables, variable_placeholders
from ..types import Record, SQLCursor
from ..util import Problem, qi, uid
from ..views import DIRECTIONS, MAX_FILTER_LENGTH, MAX_SAMPLE_ROWS, METHODS
from .contexts import interrupt

# Samples, statistics and failing rows stop after this many seconds.
READ_TIMEOUT = 30.0
# Scalar functions that read settings, the environment or other relations instead of the dataset.
DENIED_FUNCTIONS = {
    "current_setting",
    "getenv",
    "getvariable",
    "which_secret",
    "query",
    "query_table",
    "read_text",
    "read_blob",
}
SEARCH = "duckpad_search"


@dataclass
class Sample:
    """What a sample shows: which rows, how many, in which order. It never changes a result."""

    method: str = "first"
    rows: int | None = None
    seed: int = 0
    filter: str = ""
    search: str = ""
    # `[column, "asc" | "desc"]` pairs, checked against the dataset by `sample_order`.
    order: list[Any] = field(default_factory=list)
    # Former one-column "contains" filters of the preview API.
    contains: dict[str, str] = field(default_factory=dict)


def sample_order(value: object, columns: Iterable[str]) -> list[tuple[str, str]]:
    """A list of `[column, "asc" | "desc"]` pairs on existing columns."""
    names = set(columns)
    if not isinstance(value, list):
        raise Problem("The sample order must be a list of columns and directions")
    order: list[tuple[str, str]] = []
    for item in value:
        if (
            not isinstance(item, list | tuple)
            or len(item) != 2
            or not all(isinstance(part, str) for part in item)
            or item[1] not in DIRECTIONS
        ):
            raise Problem("Sort each column asc or desc")
        if item[0] not in names:
            raise Problem(f"Unknown sort column: {item[0]}")
        order.append((str(item[0]), str(item[1])))
    if len({column for column, _ in order}) != len(order):
        raise Problem("Sort each column once")
    return order


def check_sample(method: str, rows: int | None, seed: int) -> None:
    if method not in METHODS:
        raise Problem("Sample rows are the first rows or a random sample")
    if rows is not None and not 1 <= rows <= MAX_SAMPLE_ROWS:
        raise Problem(f"A sample has between 1 and {MAX_SAMPLE_ROWS:,} rows")
    if not 0 <= seed < 2**31:
        raise Problem("The random seed must be a positive integer")


def sample_condition(
    text: str, columns: Iterable[str], bundle: Record | None, environment: str, computed: Record | None = None
) -> tuple[str, Record]:
    """A sample filter validated like a Filter condition, with its variables bound, never pasted.

    It is one SQL expression on the dataset's columns: no query, statement, table or parameter.
    `{{ var.name }}` references become named parameters holding the environment's typed value.
    """
    text = text.strip()
    if not text:
        return "", {}
    if len(text) > MAX_FILTER_LENGTH:
        raise Problem("The sample filter is too long")
    check_variables("The sample filter", text)
    names = {column.casefold() for column in columns}
    try:
        parsed = sqlglot.parse(VARIABLE_REFERENCE.sub("NULL", text), read="duckdb")
    except sqlglot.errors.SqlglotError as error:
        raise Problem(f"Invalid sample filter: {text}") from error
    if len(parsed) != 1 or parsed[0] is None:
        raise Problem("The sample filter must be one SQL condition, written without WHERE")
    tree = parsed[0]
    forbidden = (exp.Query, exp.DDL, exp.DML, exp.Command, exp.Table, exp.Placeholder, exp.Parameter)
    if isinstance(tree, forbidden) or any(tree.find_all(*forbidden)):
        raise Problem("The sample filter must be one SQL condition on this output's columns, without a query")
    bound = {
        part.name.casefold()
        for function in tree.find_all(exp.Lambda)
        for part in function.expressions
        if isinstance(part, exp.Identifier | exp.Column)
    }
    for column in tree.find_all(exp.Column):
        first = column.parts[0].name if column.parts else column.name
        if first.casefold() not in names | bound:
            raise Problem(f"Unknown column in the sample filter: {column.sql(dialect='duckdb')}")
    for function in tree.find_all(exp.Anonymous, exp.Func):
        name = function.name if isinstance(function, exp.Anonymous) else function.sql_name()
        if name.casefold() in DENIED_FUNCTIONS:
            raise Problem(f"The sample filter cannot call {name}")
    values = variable_values(VARIABLE_REFERENCE.findall(text), bundle, environment, computed)
    placeholders = variable_placeholders(values, {SEARCH: None})
    substituted = bind_variables("The sample filter", text, values, placeholders)
    try:
        sql = sqlglot.parse_one(substituted, read="duckdb").sql(dialect="duckdb")
    except sqlglot.errors.SqlglotError as error:
        raise Problem(f"Invalid sample filter: {text}") from error
    return sql, {placeholders[name]: value["value"] for name, value in values.items()}


def variable_values(
    names: Iterable[str], bundle: Record | None, environment: str, computed: Record | None = None
) -> Record:
    """Name -> type and value of the project variables a sample filter references."""
    names = list(dict.fromkeys(names))
    if not names:
        return {}
    declared, file_error = variables.declarations(bundle or {})
    values = {}
    for name in names:
        if name not in declared:
            raise Problem(
                file_error or f"The sample filter references variable {name}, which is not declared"
            )
        variable = declared[name]
        if base_type(variable["type"]) not in variables.EXPRESSION_TYPES:
            raise Problem(f"Variable {name} has a {variable['type']} value, which a condition cannot use")
        value = variables.resolve(variable, environment, (computed or {}).get(name))
        if "error" in value:
            raise Problem(f"Variable {name}: {value['error']}")
        values[name] = {"type": variable["type"], "value": value["value"]}
    return values


def row_alias(columns: Iterable[str]) -> str:
    """A name for the row identity that no public column uses."""
    taken = {column.casefold() for column in columns}
    alias = "__duckpad_row"
    while alias in taken:
        alias += "_"
    return alias


def sample_query(dataset: Dataset, sample: Sample, condition: str) -> tuple[str, str, str]:
    """The relations of a sample: (common table expressions, matching rows, sample rows).

    Rows keep their identity in the retained relation, so lineage can explain any of them.
    """
    columns = [c["name"] for c in dataset.columns]
    row = row_alias(columns)
    projection = ", ".join(f"{qi(dataset.stored(c))} AS {qi(c)}" for c in columns)
    where = []
    if condition:
        where.append(f"({condition})")
    if sample.search:
        where.append(
            "("
            + " OR ".join(f"contains(lower(CAST({qi(c)} AS VARCHAR)), lower(${SEARCH}))" for c in columns)
            + ")"
        )
    where.extend(
        f"CAST({qi(column)} AS VARCHAR) ILIKE ${contains_parameter(column, columns)}"
        for column in sample.contains
    )
    order = ", ".join(f"{qi(column)} {direction.upper()}" for column, direction in sample.order)
    ordering = f"{order}, {qi(row)}" if order else qi(row)
    if sample.rows is None:
        chosen = "SELECT * FROM matched"
    elif sample.method == "random":
        chosen = f"SELECT * FROM matched USING SAMPLE reservoir({int(sample.rows)} ROWS) REPEATABLE ({int(sample.seed)})"
    else:
        chosen = f"SELECT * FROM matched ORDER BY {ordering} LIMIT {int(sample.rows)}"
    common = (
        f"WITH base AS (SELECT rowid AS {qi(row)}, {projection} FROM {qi(dataset.relation)}), "
        f"matched AS (SELECT * FROM base{' WHERE ' + ' AND '.join(where) if where else ''}), "
        f"chosen AS ({chosen}) "
    )
    return common, row, ordering


def contains_parameter(column: str, columns: list[str]) -> str:
    return f"duckpad_contains_{columns.index(column)}"


def sample_bindings(sample: Sample, columns: list[str], condition_bindings: Record) -> Record:
    bindings = dict(condition_bindings)
    if sample.search:
        bindings[SEARCH] = sample.search
    for column, value in sample.contains.items():
        bindings[contains_parameter(column, columns)] = f"%{value}%"
    return bindings


@contextmanager
def reading(
    context: Context, datasets: Iterable[Dataset], timeout: float | None = None
) -> Generator[SQLCursor, None, None]:
    """A cursor that reads retained results outside the context lock.

    It is registered like a lineage reader, so a run waits for it before dropping the results,
    interrupts it first, and it stops after `timeout` seconds.
    """
    datasets = list(datasets)
    assert context.db is not None
    cursor = context.db.cursor()
    if isinstance(cursor, duckdb.DuckDBPyConnection):
        cursor = NativeCursor(cursor)
    request = uid("read_")
    canceled, expired = threading.Event(), threading.Event()

    def expire() -> None:
        expired.set()
        interrupt(cursor)

    timeout = READ_TIMEOUT if timeout is None else timeout
    timer = threading.Timer(timeout, expire)
    timer.daemon = True
    with context.lock:
        if any(context.datasets.get(dataset.id) is not dataset for dataset in datasets):
            cursor.close()
            raise Problem("This result was replaced. Reload it.", 409)
        context.lineage[request] = {
            "cursor": cursor,
            "canceled": canceled,
            "nodes": {dataset.node for dataset in datasets},
            "display": True,
        }
    timer.start()
    try:
        yield cursor
    except Exception as error:
        if expired.is_set():
            raise Problem(
                f"Reading this result took more than {timeout:g} seconds and was stopped.", 422
            ) from error
        if canceled.is_set():
            raise Problem("This result was replaced while it was read. Reload it.", 409) from error
        raise
    finally:
        timer.cancel()
        with context.lock:
            context.lineage.pop(request, None)
        with suppress(duckdb.Error, Problem):
            cursor.close()
