"""Versioned product guidance, independent of user-authored project documentation."""

import subprocess
from importlib.resources import files
from importlib.resources.abc import Traversable
from pathlib import Path

from pydantic_ai import RunContext

from ..util import Problem
from .tools import Dependencies


def guide_files() -> dict[str, Traversable]:
    """Topic -> guide: every docs/*.md, bundled by the build hook, or read in place by editable installs."""
    packaged = files("duckpad.assistant").joinpath("guides")
    if packaged.is_dir():
        return {f.name.removesuffix(".md").lower(): f for f in packaged.iterdir() if f.name.endswith(".md")}
    return checkout_guides(Path(__file__).resolve().parents[3])


def checkout_guides(root: Path) -> dict[str, Traversable]:
    """The guides of a source checkout, without the Git-ignored files the build hook leaves out of
    wheels, such as an operator's private docs/MULTICA.md."""
    docs = root / "docs"
    if not docs.is_dir():
        return {}
    guides = sorted(f for f in docs.iterdir() if f.name.endswith(".md"))
    # --no-index applies the ignore rules to tracked files too, as the build hook does.
    result = subprocess.run(
        ["git", "-C", str(root), "check-ignore", "--no-index", "-z", "--stdin"],
        input="\0".join(f"docs/{f.name}" for f in guides),
        capture_output=True,
        text=True,
        check=False,
    )
    # 1: nothing is ignored. Outside a Git checkout, no ignore rule applies either.
    ignored = set(result.stdout.split("\0")) if result.returncode == 0 else set()
    return {f.name.removesuffix(".md").lower(): f for f in guides if f"docs/{f.name}" not in ignored}


# Only release-owned files are readable: never a path, nor the project's README.
GUIDES = guide_files()

AUTHORING_INSTRUCTIONS = (
    """
Duckpad is a versioned visual SQL pipeline using DuckDB, not a general SQL console.
Use read_guide for the bundled product reference before writing unfamiliar syntax or explaining
features. It is available on every page, including outside a project; its topics are listed at
the end of these instructions. read_documentation reads the user's project documentation; it is
not the Duckpad reference.

SQL definitions and parameters:
- A normal node owns nodes/<id>.sql; a linked node uses templates/<id>.sql shared by all linked
  instances. Components hold reusable inner graphs and expose inputs, outputs and parameters.
- Directives are SQL comments on their own lines: -- @input source, -- @param minimum: number = 0,
  -- @output result. @param declares a typed node parameter, generates its inspector field and
  may supply a default. It is neither a project variable nor DuckDB's parameter syntax.
- Use {{ source }} to reference a declared input, and {{ minimum }} for a declared parameter.
  Example of a complete definition (connect its source input when adding the node):
  -- @input source
  -- @param minimum: number = 0
  -- @output result
  SELECT * FROM {{ source }} WHERE amount >= {{ minimum }};
- Scalar placeholders are bound safely; never quote '{{ minimum }}'. Each output contains one
  semicolon-terminated query. Outputs can reference earlier outputs, never themselves or later ones.
  Use DuckDB SQL (e.g. double-quoted identifiers, single-quoted strings, CAST and TRY_CAST).
  Read schemas before choosing columns. Canvas labels are not SQL table names. Inputs need edges
  with the exact declared source and target port names. Unknown directives are errors.
- Types include text, number, boolean, date, choice(a|b), keyword(inner|left), identifier,
  column(source), expression(source), expressions, list<text>, list<number>, list<boolean>,
  list<column>, schema, connection, file(connection), destination(connection), secret(connection),
  schema_name(connection) and table_name(schema). Read the sql guide for their contracts.
- Outputs cannot write externally. Export nodes have no @output and use explicit COPY or INSERT.
  Read files/tables through declared resource parameters and granted connections; do not invent
  paths, connection IDs, credentials, ATTACH or INSTALL commands. Empty connection selects project
  files. Extensions must be enabled for the project. Saving or compiling does not execute SQL.
- -- @test name: error queries return failing rows (not COUNT(*)). -- @message queries return
  level and message columns. Checks run before outputs publish or external writes occur.

Project variables:
- variables.json declarations are separate from SQL @param declarations. Names are lowercase
  letters, digits and underscores, starting with a letter. Ordinary variables have type,
  description, default and environments; an environment override wins over the default.
- Bind a root instance parameter with {"$var":"minimum"} in its params using edit_flow.
  For root expression/expressions and file/destination values, {{ var.minimum }} can appear in
  the parameter value, outside quotes/comments in expressions. Never put project references in
  reusable SQL, template defaults or component definitions; expose and bind a parameter instead.
- Computed variables use "from": {"node":"control","port":"result","column":"value"}
  instead of default/environments. Their source must return exactly one non-null compatible cell.
  Reading definitions, compiling and inspecting values never run that source.
- Use read_variables for declarations, values by environment and paginated usages. Use
  edit_variable to create, update, rename or delete; rename updates references. To clear a field
  use remove_fields, and to restore inheritance use remove_environments, not null. Changing
  ordinary/computed mode must remove incompatible fields in the same call.
  Delete refuses variables still used by nodes or saved result views. Report the usages and
  replace/remove only the bindings the user requested before deleting. Do not silently break them.
"""
    + f"read_guide topics: {', '.join(sorted(GUIDES))}.\n"
)


def guide_text(topic: str) -> str:
    if topic not in GUIDES:
        raise Problem(f"Unknown Duckpad guide. Choose one of: {', '.join(sorted(GUIDES))}", 404)
    return GUIDES[topic].read_text(encoding="utf-8")


def read_guide(ctx: RunContext[Dependencies], topic: str, offset: int = 0) -> dict:
    """Read the bundled Duckpad manual, not project documentation; no project needs to be open.

    Choose sql for @param/types, inputs, outputs and DuckDB SQL examples; variables for bindings,
    environments and computed values; authoring/components for code ownership and reuse;
    connectors for sources/exports; environments, git, jobs or automation for those features;
    tests/messages/results/partitions for execution behavior; assistant for capabilities.
    Follow next_offset to read the remaining characters.
    """
    ctx.deps.check()
    text = guide_text(topic)
    offset = max(0, offset)
    end = offset + 12000
    return {
        "topic": topic,
        "source": f"docs/{GUIDES[topic].name}",
        "text": text[offset:end],
        "next_offset": end if end < len(text) else None,
    }
