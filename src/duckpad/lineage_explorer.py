"""Bounded contribution discovery and record paging over retained executions.

A stage describes one cell and ALL of its immediate roles, never a sample page.
Non-source roles remain explicit exploration boundaries even after one of their
rows has been followed. No recursive per-row traversal runs on the server.
"""

import json
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager

import duckdb
import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError

from .lineage import Coverage as Unsupported
from .lineage import TraceQuery
from .lineage_models import Cell, ContributionRecord, Coverage, Records, Role, Stage, StageEdge
from .util import Problem, clean, digest, qi

MAX_ROLES = 128
MAX_STAGES = 64
TIMEOUT = 10


class RequestCursor:
    """Close the cancellation race between two SQL statements in one request."""

    def __init__(self, cursor, cancelled):
        self.cursor, self.cancelled = cursor, cancelled
        self.deadline = time.monotonic() + TIMEOUT

    def execute(self, *args, **kwargs):
        if self.cancelled.is_set():
            raise Problem("Investigation request cancelled", 499)
        return self.cursor.execute(*args, **kwargs)


class LineageExplorer:
    def __init__(self, engine):
        self.engine = engine
        self.lock = threading.RLock()
        self.cache = OrderedDict()
        self.cancelled = OrderedDict()

    def cancel(self, worktree, request):
        key = (worktree, request.environment, request.request_id)
        context = self.engine.context(worktree, request.environment)
        with self.lock, context.lock:
            self.cancelled[key] = time.monotonic()
            while len(self.cancelled) > 512:
                self.cancelled.popitem(last=False)
            active = context.lineage.get(request.request_id)
            if active:
                active["canceled"].set()
                active["cursor"].interrupt()
        return {"cancelled": True}

    def validate(self, context, request):
        datasets, nodes = {}, set()

        def visit(identity):
            if identity in datasets:
                return
            data = context.datasets.get(identity)
            if not data or data.status != "valid":
                raise Problem("Lineage interrupted by recalculation. Select a cell in the new result.", 409)
            datasets[identity] = data
            nodes.add(data.node)
            for dependency in data.dependencies.values():
                visit(dependency)

        visit(request.root.dataset)
        root_ids = set(datasets)
        visit(request.cell.dataset)
        data = datasets[request.cell.dataset]
        if data.id not in root_ids:
            # Deterministic SQL intermediates are attached to their captured owner.
            if not data.id.startswith("trace_") or data.node not in {datasets[i].node for i in root_ids}:
                raise Problem("This stage does not belong to the selected investigation", 404)
        for cell in (request.root, request.cell):
            owner = datasets[cell.dataset]
            if cell.execution != owner.run:
                raise Problem("This cell belongs to a different execution", 409)
            if cell.row >= owner.count or cell.column not in {c["name"] for c in owner.columns}:
                raise Problem("Cell not found", 404)
        return data, nodes

    @contextmanager
    def reader(self, worktree, request):
        context = self.engine.context(worktree, request.environment)
        key = (worktree, request.environment, request.request_id)
        cursor = context.db.cursor()
        cancelled, timed_out = threading.Event(), threading.Event()
        timer = None
        registered = False
        try:
            with self.lock, context.lock:
                data, nodes = self.validate(context, request)
                if time.monotonic() - self.cancelled.get(key, float("-inf")) < 120:
                    raise Problem("Investigation request cancelled", 499)
                if request.request_id in context.lineage:
                    raise Problem("Request identifier is already active", 409)
                context.lineage[request.request_id] = {
                    "cursor": cursor,
                    "canceled": cancelled,
                    "nodes": nodes,
                }
                registered = True

            def interrupt():
                timed_out.set()
                cancelled.set()
                cursor.interrupt()

            timer = threading.Timer(TIMEOUT, interrupt)
            timer.start()
            yield context, RequestCursor(cursor, cancelled), data
            self.validate(context, request)
            if cancelled.is_set():
                raise Problem("Investigation request cancelled", 499)
        except Exception as error:
            if timed_out.is_set():
                raise Problem(
                    "The step exceeded its 10 second budget. Retry or inspect a smaller upstream step.", 408
                ) from error
            # Invalidation must win over manual cancellation and SQL errors.
            self.validate(context, request)
            if cancelled.is_set():
                raise Problem("Investigation request cancelled", 499) from error
            raise
        finally:
            if timer:
                timer.cancel()
                timer.join()
            if registered:
                with context.lock:
                    context.lineage.pop(request.request_id, None)
            cursor.close()

    def labels(self, data):
        run = self.engine.store.get("run", data.run, {})
        graph = run.get("flow", {})
        path = []
        for segment in data.node.split("::"):
            node = next((n for n in graph.get("nodes", []) if n["id"] == segment), {})
            path.append(node.get("label") or segment)
            graph = run.get("components", {}).get(node.get("component"), {})
        return path[-1], path, run.get("project", "")

    def plan(self, context, cursor, data, request):
        key = (
            context.worktree,
            context.environment,
            request.root.model_dump_json(),
            request.cell.model_dump_json(),
        )
        with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
        names = [c["name"] for c in data.columns]
        record = cursor.execute(
            f"SELECT {', '.join(qi(data.column_map.get(n, n)) for n in names)} FROM {qi(data.storage or data.table)} WHERE rowid=?",
            [request.cell.row],
        ).fetchone()
        if record is None:
            raise Problem("Cell not found", 404)
        label, path, project = self.labels(data)
        stage_id = digest([context.worktree, context.environment, request.cell.model_dump()])[:24]
        stage = Stage(
            id=stage_id,
            cell=request.cell,
            worktree=context.worktree,
            environment=context.environment,
            project=project,
            node=data.node,
            label=label,
            path=path,
            port=data.port,
            value=clean(record[names.index(request.cell.column)]),
            kind="source" if data.source else "projection",
            expression=request.cell.column,
            sql=data.query,
            coverage=Coverage(
                step="sources_reached" if data.source else "step_explained", upstream="sources_reached"
            ),
            roles=[],
            edges=[],
            evidence={},
            budget={"roles": MAX_ROLES, "stages": MAX_STAGES, "seconds": TIMEOUT, "page_size": 100},
        )
        plan = {"stage": stage, "queries": {}, "distinct": None}
        if data.source:
            stage.evidence["record"] = {"columns": data.columns, "values": clean(record)}
        else:
            tracer = TraceQuery(context, cursor, data, request.cell.row, detailed=True)
            try:
                tree = tracer.normalize(data)
                value_query, condition_query, distinct = tracer.trace(
                    tree, record, names.index(request.cell.column)
                )
                plan["distinct"] = distinct
                stage.kind, stage.expression = tracer.kind, tracer.expression
                stage.evidence = tracer.evidence
                stage.evidence["distinct"] = distinct is not None

                def friendly(expression):
                    parsed = sqlglot.parse_one(expression, read="duckdb")
                    for column in parsed.find_all(exp.Column):
                        source = tracer.sources.get(column.table)
                        if source:
                            if column.table == source.table:
                                column.set("table", exp.to_identifier(self.labels(source)[0], quoted=True))
                            column.set(
                                "this",
                                exp.to_identifier(tracer.original_column(source, column.name), quoted=True),
                            )
                    return parsed.sql(dialect="duckdb")

                stage.expression = (
                    friendly(stage.expression)
                    if tracer.kind not in {"union", "intersect", "except"}
                    else stage.expression
                )
                for field in ("argument",):
                    if stage.evidence.get(field):
                        stage.evidence[field] = friendly(stage.evidence[field])
                for field in ("group_keys", "partition"):
                    if stage.evidence.get(field):
                        stage.evidence[field] = [friendly(e) for e in stage.evidence[field]]
                for calculation in stage.evidence.get("calculations", []):
                    calculation["expression"] = friendly(calculation["expression"])
                queries = {"value": value_query, "condition": condition_query, "existence": tracer.existence}
                if tracer.evidence.get("row_count"):
                    queries["value"] = ""
                if tracer.evidence.get("function") in {
                    "ROWNUMBER",
                    "RANK",
                    "DENSERANK",
                    "PERCENTRANK",
                    "CUMEDIST",
                    "NTILE",
                }:
                    queries["value"] = ""
                for kind, query in queries.items():
                    if not query:
                        continue
                    summaries = cursor.execute(
                        f"SELECT role, column_name, COUNT(DISTINCT row_id), COUNT(*) FROM ({query}) evidence GROUP BY role, column_name LIMIT ?",
                        [MAX_ROLES + 1],
                    ).fetchall()
                    counts = {
                        (alias, column): (unique, repeated) for alias, column, unique, repeated in summaries
                    }
                    declared = tracer.declarations.get(query, set()) | counts.keys()
                    if len(stage.roles) + len(declared) > MAX_ROLES:
                        raise Unsupported(
                            "This step exceeds the 128-role topology budget. Split the SQL into smaller steps."
                        )
                    for alias, column in sorted(declared):
                        source = tracer.sources[alias]
                        unique, repeated = counts.get((alias, column), (0, 0))
                        coverage = "sources_reached" if source.source else "upstream_not_explored"
                        if not unique:
                            coverage = (
                                "branch_not_selected"
                                if kind == "value" and (alias, column) in tracer.branch_columns
                                else "no_matching_row"
                            )
                        role_label, role_path, _ = self.labels(source)
                        aliases = list(tracer.sources)
                        side = (
                            "left"
                            if len(aliases) > 1 and aliases.index(alias) == 0
                            else "right"
                            if len(aliases) == 2
                            else "input"
                        )
                        role = Role(
                            id=digest([stage_id, kind, alias, column])[:24],
                            alias=alias,
                            display_alias=source.port if alias == source.table else alias,
                            side=side,
                            kind=kind,
                            dataset=source.id,
                            execution=source.run,
                            node=source.node,
                            label=role_label,
                            path=role_path,
                            port=source.port,
                            column=column,
                            columns=source.columns,
                            occurrences=unique,
                            participations=repeated,
                            coverage=coverage,
                        )
                        stage.roles.append(role)
                        stage.edges.append(StageEdge(source=role.id, target=stage_id, kind=kind))
                        plan["queries"][role.id] = query
                if any(r.coverage == "upstream_not_explored" for r in stage.roles):
                    stage.coverage.upstream = "upstream_not_explored"
            except duckdb.InterruptException:
                # An interrupted query is retryable, not a cached SQL boundary.
                raise
            except (Unsupported, duckdb.Error, SqlglotError) as error:
                stage.coverage = Coverage(
                    step="unsupported_operation", upstream="upstream_not_explored", warnings=[str(error)]
                )
                stage.roles, stage.edges, plan["queries"] = [], [], {}
        with self.lock:
            self.cache[key] = plan
            while len(self.cache) > MAX_STAGES:
                self.cache.popitem(last=False)
        return plan

    def stage(self, worktree, request):
        with self.reader(worktree, request) as (context, cursor, data):
            return self.plan(context, cursor, data, request)["stage"]

    def records(self, worktree, request):
        with self.reader(worktree, request) as (context, cursor, data):
            plan = self.plan(context, cursor, data, request)
            role = next((r for r in plan["stage"].roles if r.id == request.role), None)
            if role is None:
                raise Problem("Unknown role in this step", 404)
            query = plan["queries"][role.id]
            result = Records(
                role=role.id,
                offset=request.offset,
                limit=request.limit,
                total=role.occurrences,
                columns=role.columns,
            )
            if plan["distinct"] and role.kind == "value":
                base, expression = plan["distinct"]
                if request.group is None:
                    groups = f"SELECT to_json(v) AS value, COUNT(*) AS rows FROM (SELECT {expression} AS v {base}) values_ WHERE v IS NOT NULL GROUP BY v"
                    result.total = cursor.execute(f"SELECT COUNT(*) FROM ({groups}) groups_").fetchone()[0]
                    result.groups = [
                        dict(key=v, value=json.loads(v), rows=n)
                        for v, n in cursor.execute(
                            groups + " ORDER BY value LIMIT ? OFFSET ?", [request.limit, request.offset]
                        ).fetchall()
                    ]
                    return result
                try:
                    group = json.loads(request.group)
                except ValueError as error:
                    raise Problem("Invalid distinct group") from error
                tracer = TraceQuery(context, cursor, data, request.cell.row, detailed=True)
                tree = tracer.normalize(data)
                names = [c["name"] for c in data.columns]
                record = cursor.execute(
                    f"SELECT {', '.join(qi(data.column_map.get(n, n)) for n in names)} FROM {qi(data.storage or data.table)} WHERE rowid=?",
                    [request.cell.row],
                ).fetchone()
                query, _, _ = tracer.trace(
                    tree, record, names.index(request.cell.column), distinct_value=group
                )
            source = context.datasets[role.dataset]
            filtered = f"SELECT row_id, COUNT(*) AS participations FROM ({query}) evidence WHERE role=? AND column_name=? GROUP BY row_id"
            args = [role.alias, role.column]
            if request.group is not None:
                result.total = cursor.execute(f"SELECT COUNT(*) FROM ({filtered}) counted", args).fetchone()[
                    0
                ]
            fields = ", ".join("d." + qi(source.column_map.get(c["name"], c["name"])) for c in role.columns)
            # The page is selected before joining full records; identical values
            # never collapse different stable storage identities.
            paged = f"SELECT d.rowid, p.participations, {fields} FROM ({filtered} ORDER BY row_id LIMIT ? OFFSET ?) p JOIN {qi(source.storage or source.table)} d ON d.rowid=p.row_id ORDER BY d.rowid"
            rows = cursor.execute(paged, [*args, request.limit, request.offset]).fetchall()
            followed = next(i for i, c in enumerate(role.columns) if c["name"] == role.column)
            result.records = [
                ContributionRecord(
                    cell=Cell(dataset=source.id, execution=source.run, row=row[0], column=role.column),
                    value=clean(row[followed + 2]),
                    values=clean(row[2:]),
                    participations=row[1],
                )
                for row in rows
            ]
            return result
