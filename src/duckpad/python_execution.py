"""Execute Python in the same DuckDB connection as its SQL inputs and outputs."""

import contextlib
import importlib
import io
import sys
import traceback
import types
from collections import deque
from pathlib import Path

try:
    import resource
except ImportError:  # pragma: no cover - Windows has no POSIX resource limits
    resource = None

from .python_contract import parse_python
from .python_sdk import Node, Outputs, Relation
from .util import qi


class BoundedLog(io.TextIOBase):
    def __init__(self):
        self.parts = deque()
        self.length = 0

    def write(self, text):
        size = len(text)
        if text:
            self.parts.append(text[-65536:])
            self.length += min(size, 65536)
        while self.length > 65536:
            first = self.parts.popleft()
            overflow = self.length - 65536
            if len(first) > overflow:
                self.parts.appendleft(first[overflow:])
                self.length = 65536
            else:
                self.length -= len(first)
        return size

    @property
    def text(self):
        return "".join(self.parts)


def relation(connection, value):
    if isinstance(value, Relation):
        return value
    module = type(value).__module__.split(".")[0]
    # Check the actual class from its defining library; never duck-type arbitrary values.
    if module == "pyarrow":
        pa = importlib.import_module("pyarrow")

        if isinstance(value, (pa.Table, pa.RecordBatchReader)):
            return connection.from_arrow(value)
    if module == "pandas":
        pd = importlib.import_module("pandas")

        if isinstance(value, pd.DataFrame):
            return connection.from_df(value)
    if module == "polars":
        pl = importlib.import_module("polars")

        if isinstance(value, pl.DataFrame):
            return connection.from_arrow(value.to_arrow())
    raise TypeError("Outputs must be DuckDB relations, Arrow tables/readers, or pandas/Polars DataFrames")


LIMITS = ("RLIMIT_AS", "RLIMIT_DATA", "RLIMIT_NOFILE", "RLIMIT_NPROC", "RLIMIT_STACK")


def process_limits():
    """The worker's own resource limits, which user code may lower."""
    if resource is None:
        return {}
    return {name: resource.getrlimit(getattr(resource, name)) for name in LIMITS if hasattr(resource, name)}


def restore_limits(limits):
    """Whether every limit is back; a lowered hard limit cannot be raised again."""
    module = resource
    if module is None:
        return True
    restored = True
    for name, value in limits.items():
        limit = getattr(module, name)
        if module.getrlimit(limit) != value:
            try:
                module.setrlimit(limit, value)
            except (OSError, ValueError):
                restored = False
    return restored


def execute(cursor, payload):
    contract = parse_python(payload["code"])
    if contract["inputs"] != list(payload["inputs"]) or set(contract["outputs"]) != set(payload["outputs"]):
        raise ValueError("Python ports changed; reconnect and save the node before running")
    db = cursor.cursor
    db.complete()
    # User code shares the run's cursor: `USE` must not move its outputs or later nodes.
    scope = "USE " + ".".join(
        qi(part) for part in db.execute("SELECT current_database(), current_schema()").fetchone()
    )
    log = BoundedLog()
    created = []
    instance = None
    limits = process_limits()
    output = {"messages": [], "checks": [], "artifacts": {}, "log": ""}
    workspace = Path(payload["workspace"])
    modules = workspace / "modules"
    artifacts = workspace / "artifacts"
    modules.mkdir(parents=True, exist_ok=True)
    artifacts.mkdir(exist_ok=True)
    for name, source in payload.get("helpers", {}).items():
        relative = Path(name)
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or relative.suffix != ".py"
            or relative.with_suffix("").parts[0] == "duckpad"
        ):
            raise ValueError("Invalid helper module path")
        target = modules / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        # Keep the saved bytes: text mode would double CRLF line endings on Windows.
        target.write_bytes(source.encode("utf-8"))
    previous_path = list(sys.path)
    previous_modules = set(sys.modules)
    module_name = "_duckpad_node"
    module = types.ModuleType(module_name)
    module.__file__ = payload.get("filename", "nodes/python.py")
    sys.modules[module_name] = module
    sys.path.insert(0, str(modules))
    try:
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            exec(compile(payload["code"], module.__file__, "exec"), module.__dict__)
            cls = module.__dict__[contract["class"]]
            if not isinstance(cls, type) or cls.__bases__ != (Node,):
                raise ValueError("Runtime Node class differs from the declared contract")
            instance = cls(**payload["parameters"])
            instance._db = db
            instance.partition = payload.get("partition")
            instance._workspace = artifacts
            instance._connections = payload.get("connections", {})
            values = instance.run(**{name: db.table(table) for name, table in payload["inputs"].items()})
            db.execute(scope)
            if contract["outputs"] == ["result"] and not isinstance(values, Outputs):
                values = {"result": values}
            elif not contract["outputs"] and values is None:
                values = {}
            elif isinstance(values, Outputs):
                values = vars(values)
            else:
                raise ValueError("Return the declared Outputs instance, one relation, or None")
            if set(values) != set(contract["outputs"]):
                raise ValueError("Returned output names do not match the declared ports")
            # Tables are private until every output, check and managed write succeeds.
            for name, value in values.items():
                table = payload["outputs"][name]
                data = relation(db, value)
                view = table + "_python"
                db.complete()
                try:
                    db.register(view, data)
                except Exception as error:
                    raise ValueError(
                        "Returned relations must be built from the inputs or self.db, not another DuckDB database"
                    ) from error
                try:
                    db.execute(f"CREATE TABLE {qi(table)} AS SELECT * FROM {qi(view)}")
                    created.append(table)
                finally:
                    db.execute(f"DROP VIEW IF EXISTS {qi(view)}").complete()
            failure = None
            for name, rows, severity in instance._checks:
                count = rows.aggregate("count(*) AS failures").fetchall()[0][0]
                output["checks"].append({"name": name, "count": count, "severity": severity})
                if count and severity == "error":
                    failure = f"Python check {name} failed: {count} rows"
            if failure or any(m["level"] == "error" for m in instance._messages):
                raise ValueError(failure or "A Python message reported an error")
            # Validate partition boundaries before user-managed external writes.
            from .python_partitions import validate_partitions

            validate_partitions(db, payload)
            db.complete()
            instance.write()
            if any(m["level"] == "error" for m in instance._messages):
                raise ValueError(
                    "A Python message reported an error after write; external outcome may be partial"
                )
            output["messages"] = instance._messages
            output["artifacts"] = instance._artifacts
    except BaseException as error:
        with contextlib.suppress(Exception):
            db.execute(scope)
        for table in created:
            db.execute(f"DROP TABLE IF EXISTS {qi(table)}")
        frames = error.__traceback__
        if isinstance(error, MemoryError):
            output["restart"] = True
        # Start at the user's code: the worker's own calling frames are not actionable.
        while frames is not None and frames.tb_frame.f_code.co_filename == __file__:
            frames = frames.tb_next
        detail = "".join(traceback.format_exception(type(error), error, frames))
        detail = detail.replace(str(modules), "modules").replace(str(workspace), "<execution>")
        detail = detail.replace(str(Path(__file__).parent), "<duckpad>")
        output["error"] = detail
    finally:
        with contextlib.suppress(Exception):
            db.execute(scope)
        if not restore_limits(limits):
            output["restart"] = True
        if output.get("restart"):
            # Memory exhaustion or changed limits leave the worker unreliable for later queries.
            output["error"] = (output.get("error") or "Python changed the worker's resource limits") + (
                "\nThe execution worker was restarted; the next run recomputes this context."
            )
        if instance is not None:
            output["messages"] = instance._messages
        output["log"] = log.text
        sys.path[:] = previous_path
        for name in set(sys.modules) - previous_modules:
            loaded = sys.modules.get(name)
            file = getattr(loaded, "__file__", None)
            paths = ([file] if file else []) + list(getattr(loaded, "__path__", []))
            if name == module_name or any(Path(path).is_relative_to(modules) for path in paths):
                sys.modules.pop(name, None)
    return output
