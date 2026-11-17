"""External-agent tools over the assistant's bounded views and application services."""

import inspect
from types import SimpleNamespace
from typing import Any, get_type_hints

from pydantic import ConfigDict, create_model

from . import secret_references
from .assistant import editing, knowledge, runs, tools, workspace
from .assistant.actions import describe
from .assistant.tools import Dependencies
from .builtin_templates import BUILTINS
from .catalog import secret_names
from .git.workspace import diagnose, require_valid
from .util import Problem, clean

MAX_RESPONSE = 128 * 1024


class Policy:
    """External clients use API permissions, independently of a configured LLM provider."""

    def get(self):
        return {"enabled": True, "revision": "mcp", "allow_data": True, "max_rows": 50}

    def secrets(self):
        return []


class TokenAuth:
    def __init__(self, auth):
        self.auth = auth

    def check(self, token):
        return self.auth.check_api_token(token)[0]


class AgentDependencies(Dependencies):
    def safe(self, value):
        return redact(value, self.secrets or [])


def secrets(ctx, token):
    """Include retained, default and server-referenced connection secrets in output redaction."""
    values = [token, *ctx.assistant.configuration.secrets()]
    for connection in ctx.services.store.all("connection"):
        definition = ctx.services.catalog.connector(connection["connector"]) or {}
        hidden = set(connection.get("secret_fields", [])) | secret_names(definition)
        defaults = {p["name"]: p["default"] for p in definition.get("parameters", []) if "default" in p}
        for environment in connection["environments"].values():
            for name, value in {**defaults, **environment}.items():
                if name not in hidden:
                    continue
                if secret_references.is_reference(value):
                    try:
                        value = secret_references.resolve(value)
                    except Problem:
                        continue
                if value is not None and str(value):
                    values.extend((str(value), str(value).replace("'", "''")))
    return sorted(set(values), key=len, reverse=True)


def redact(value, hidden):
    def mask(value):
        if isinstance(value, str):
            for secret in hidden:
                if secret:
                    value = value.replace(secret, "[redacted]")
            return value
        if isinstance(value, dict):
            return {mask(key): mask(item) for key, item in value.items()}
        if isinstance(value, list):
            return [mask(item) for item in value]
        return "[redacted]" if str(value) in hidden else value

    return mask(clean(value))


def dependencies(ctx, token, worktree="", environment="", hidden=None):
    user, _ = ctx.auth.check_api_token(token)
    context = {"environment": environment or ctx.services.catalog.environment_names()[0]}
    if worktree:
        ctx.access.worktree(user, worktree)
        branch = ctx.services.projects.get(worktree)
        context.update(worktree=worktree, project=branch["project"], branch=branch["branch"])
    return AgentDependencies(
        ctx.services,
        TokenAuth(ctx.auth),
        token,
        Policy(),
        "mcp",
        context,
        secrets=hidden if hidden is not None else secrets(ctx, token),
    )


def validate_project(ctx):
    """Validate current working definitions without executing code. Return revision and Git commit."""
    branch = tools.reading(ctx)
    snapshot = ctx.deps.services.projects.snapshot(branch.worktree)
    _, errors = diagnose(snapshot["files"])
    return {
        "valid": not errors,
        "errors": errors,
        "revision": snapshot["revision"],
        "commit": snapshot["commit"],
    }


def create_branch(ctx, name: str):
    """Create a working branch from worktree. Return its worktree ID; never merge a branch."""
    ctx.deps.check(write=True)
    branch = ctx.deps.services.projects.branch(ctx.deps.context["worktree"], name)
    return {k: branch[k] for k in ("id", "project", "branch")}


def list_templates(ctx, template: str = "", offset: int = 0, limit: int = 20):
    """List built-in templates, or read one template's SQL. Use read_flow for project templates."""
    ctx.deps.check()
    if template:
        if template not in BUILTINS:
            raise Problem("Template not found", 404)
        return {"id": template, "sql": BUILTINS[template]}
    return tools.page([{"id": name} for name in BUILTINS], offset, limit)


READS = (
    workspace.list_projects,
    tools.read_flow,
    tools.read_file,
    tools.read_sql,
    tools.read_documentation,
    tools.read_variables,
    tools.read_schemas,
    tools.read_runs,
    tools.read_history,
    tools.preview_output,
    tools.explain_column,
    tools.explain_value,
    runs.inspect_run,
    runs.wait_for_run,
    knowledge.read_guide,
    validate_project,
    list_templates,
)
EDITS = (editing.edit_flow, editing.write_sql)


class Tool:
    def __init__(self, function, *, write=False, edit=False):
        self.function, self.write, self.edit = function, write, edit
        fields: dict[str, Any] = {}
        hints = get_type_hints(function, include_extras=True)
        for name, param in inspect.signature(function).parameters.items():
            if name in ("ctx", "worktree", "environment"):
                continue
            fields[name] = (hints[name], ... if param.default is inspect.Parameter.empty else param.default)
        fields["worktree"] = (str, ... if write else "")
        fields["environment"] = (str, "")
        if edit:
            fields["revision"] = (str, ...)
        self.arguments = create_model(
            function.__name__ + "Arguments", __config__=ConfigDict(extra="forbid"), **fields
        )

    def public(self):
        return {
            "name": self.function.__name__,
            "description": inspect.getdoc(self.function) or "",
            "inputSchema": self.arguments.model_json_schema(),
            "annotations": {"readOnlyHint": not self.write, "openWorldHint": self.write},
        }

    def call(self, ctx, token, raw, hidden):
        args = self.arguments.model_validate(raw)
        # Keep nested operation models: edit_flow uses their discriminated Python types.
        values = {name: getattr(args, name) for name in type(args).model_fields}
        deps = dependencies(ctx, token, values.pop("worktree"), values.pop("environment"), hidden)
        deps.check(write=self.write)
        if self.function in (tools.read_file, tools.read_sql):
            # Mask complete file contents before character pagination; otherwise an offset could
            # split a credential and reveal it in pieces. Keep the raw bundle for path resolution.
            branch = deps.branch()
            snapshot = branch.snapshot()
            snapshot["files"] = deps.safe(snapshot["files"])
            deps.snapshots[branch.worktree] = snapshot
        revision = values.pop("revision", None)
        if self.edit:
            projects = deps.services.projects

            def writer(call, before, files, details):
                with projects.locked(deps.context["worktree"]):
                    deps.check(write=True)
                    current = projects.snapshot(deps.context["worktree"])
                    if current["revision"] != revision or before["revision"] != revision:
                        raise Problem(
                            "Branch changed. Validate and read its latest revision before editing.", 409
                        )
                    if current["conflicts"]:
                        raise Problem("Resolve the pending project conflict before editing", 409)
                    require_valid(files, "The proposed changes are invalid", baseline=current["files"])
                    result = projects.write(
                        deps.context["worktree"],
                        revision,
                        files,
                        validate=True,
                        message="feat(project): apply external agent edit",
                    )
                return {
                    "revision": result["revision"],
                    "commit": result["commit"],
                    **describe(current["files"], result["files"]),
                    **details,
                }

            deps.writer = writer
        result = self.function(SimpleNamespace(deps=deps, tool_call_id="mcp"), **values)
        deps.check(write=self.write)
        return result


TOOLS = {f.__name__: Tool(f) for f in READS}
TOOLS.update({f.__name__: Tool(f, write=True, edit=True) for f in EDITS})
TOOLS.update({f.__name__: Tool(f, write=True) for f in (create_branch, runs.cancel_run)})
