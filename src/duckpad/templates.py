"""Typed SQL templates. Compilation never executes SQL."""

import json
import math
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

import sqlglot
from sqlglot import exp
from sqlglot.tokens import TokenType

from .data_preparation import PREPARATION_TYPES, render_preparation
from .python_contract import parse_python
from .sql_errors import SqlSourceError, source_context
from .util import Problem, literal, qi
from .value_types import base_type, is_date, type_argument

REFERENCE = re.compile(r"{{\s*(\w+)\s*}}")
# A project variable referenced inside an expression parameter value.
VARIABLE_REFERENCE = re.compile(r"{{\s*var\.(\w+)\s*}}")
IDENTIFIER = re.compile(r"[A-Za-z_]\w*")
DIRECTIVE = re.compile(r"^\s*--\s*@([\w]+)\s*(.*?)\s*$")
PARAMETER = re.compile(r"(\w+)\s*:\s*([^=]+?)(?:\s*=\s*(.*))?")
URI = re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*://")
PARAMETER_TYPES = {
    "text",
    "number",
    "boolean",
    "date",
    "choice",
    "keyword",
    "file",
    "destination",
    "connection",
    "secret",
    "column",
    "identifier",
    "schema_name",
    "table_name",
    "expression",
    "expressions",
    "schema",
    "list",
    *PREPARATION_TYPES,
}
# Types whose argument names the connection parameter that resolves them.
CONNECTION_BOUND = {"file", "destination", "secret", "schema_name"}
# A database object name, listed from the connection (schemas) or the schema parameter (tables).
OBJECT_NAMES = {"schema_name": "schema", "table_name": "table"}
RESOURCE_TYPES = ("file", "destination")
# Directives that document a template without changing what it computes.
DESCRIPTIVE = ("label", "description")
LIST_ITEM_TYPES = ("text", "number", "boolean", "column")


def directive(line):
    """`-- @param limit: number` -> ("param", "limit: number"); None for a SQL line."""
    match = DIRECTIVE.match(line)
    return match.groups() if match else None


def directives(sql):
    """Every directive of a template, in order, without validating the template."""
    return [found for found in map(directive, (sql or "").splitlines()) if found]


def parse_template(sql, language="sql"):
    if language == "python":
        return parse_python(sql)
    template = {
        "label": "SQL template",
        "description": "",
        "inputs": [],
        "parameters": [],
        "outputs": [],
        "blocks": [],
    }
    current, buffer = None, []
    buffer_lines = []
    message_block = 0
    check = {}
    test_names = set()

    def flush():
        sql = "\n".join(buffer).strip()
        if check and not sql:
            kind = "test" if "test_name" in check else "message"
            raise Problem(f"Each @{kind} block must contain a query")
        if sql:
            first = next(i for i, text in enumerate(buffer) if text.strip())
            template["blocks"].append(
                {
                    "output": current,
                    "sql": sql,
                    "source_lines": buffer_lines[first:],
                    "source_column": len(buffer[first]) - len(buffer[first].lstrip()) + 1,
                    **check,
                }
            )
        buffer.clear()
        buffer_lines.clear()

    for line_number, line in enumerate(sql.splitlines(), 1):
        found = directive(line)
        if not found:
            buffer.append(line)
            buffer_lines.append(line_number)
            continue
        key, value = found
        if key in DESCRIPTIVE:
            template[key] = value
        elif key == "input":
            template["inputs"].append(value)
        elif key == "param":
            template["parameters"].append(parse_parameter(value))
        elif key == "output":
            flush()
            current = value
            check = {}
            template["outputs"].append(value)
        elif key == "message":
            if value:
                raise Problem("The @message directive does not take a name or arguments")
            flush()
            current = None
            message_block += 1
            check = {"message_block": message_block}
        elif key == "test":
            flush()
            name, separator, severity = value.partition(":")
            name, severity = name.strip(), severity.strip() if separator else "error"
            if not IDENTIFIER.fullmatch(name):
                raise Problem(
                    "An @test name must be an identifier containing letters, numbers or underscores"
                )
            if name in test_names:
                raise Problem(f"Duplicate @test name: {name}")
            if severity not in ("warning", "error"):
                raise Problem(f"Unknown @test severity: {severity!r}; expected warning or error")
            test_names.add(name)
            current = None
            check = {"test_name": name, "test_severity": severity}
        else:
            raise Problem(f"Unknown template directive: @{key}")
    flush()
    template["writes_external"] = any(not b["output"] and not is_check(b) for b in template["blocks"])
    validate_interface(template)
    template["download"] = downloadable_export(template)
    return template


def parse_parameter(declaration):
    match = PARAMETER.fullmatch(declaration)
    if not match:
        raise Problem(f"Invalid parameter declaration: {declaration}")
    name, type_name, default = match.groups()
    if base_type(type_name) not in PARAMETER_TYPES:
        raise Problem(f"Unsupported parameter type: {type_name}")
    parameter = {"name": name, "type": type_name.strip()}
    if default is not None:
        try:
            parameter["default"] = json.loads(default)
        except json.JSONDecodeError:
            parameter["default"] = default.strip("'\"")
    return parameter


def validate_interface(template):
    parameters = {p["name"]: p for p in template["parameters"]}
    names = template["inputs"] + template["outputs"] + list(parameters)
    if len(set(names)) != len(names) or len(parameters) != len(template["parameters"]):
        raise Problem("Inputs, outputs and parameters must have unique names")
    if any(not IDENTIFIER.fullmatch(n) for n in names):
        raise Problem("Port and parameter identifiers must contain letters, numbers or underscores")
    for parameter in template["parameters"]:
        kind, argument = base_type(parameter["type"]), type_argument(parameter["type"])
        if kind in PREPARATION_TYPES and argument not in template["inputs"]:
            raise Problem(f"Parameter {parameter['name']} must reference a declared input port")
        if kind == "table_name" and (
            argument is None or base_type(parameters.get(argument, {}).get("type", "")) != "schema_name"
        ):
            raise Problem(f"Parameter {parameter['name']} must reference a declared schema_name parameter")
        if kind == "schema_name" and argument is None:
            raise Problem(f"Parameter {parameter['name']} must reference a declared connection parameter")
        if kind not in CONNECTION_BOUND or (argument is None and kind != "secret"):
            continue
        if argument is None or parameters.get(argument, {}).get("type") != "connection":
            raise Problem(f"Parameter {parameter['name']} must reference a declared connection parameter")
    available = set(template["inputs"]) | set(parameters)
    for block in execution_blocks(template):
        missing = set(REFERENCE.findall(block["sql"])) - available
        if missing:
            raise Problem("Undeclared, self or forward reference: " + ", ".join(sorted(missing)))
        if block["output"]:
            available.add(block["output"])
    if not template["blocks"]:
        raise Problem("Template has no SQL statements")
    if template["writes_external"] and template["outputs"]:
        raise Problem("Queries need an @output; external writes go in a node without outputs")


def parse_templates(templates):
    """Parse every template, reporting each invalid one in place of its interface."""
    parsed = {}
    for name, sql in templates.items():
        try:
            parsed[name] = parse_template(sql, "python" if name.endswith(".py") else "sql")
        except Problem as error:
            parsed[name] = {"error": str(error)}
    return parsed


def is_check(block):
    return bool(block.get("message_block") or block.get("test_name"))


def execution_blocks(template):
    """Outputs first, checks in declaration order, external writes last."""
    return sorted(
        template["blocks"],
        key=lambda block: 1 if is_check(block) else (0 if block["output"] else 2),
    )


def executable_sql(sql):
    """Template text without descriptive directives, so relabeling never invalidates results."""
    return "\n".join(line for line in (sql or "").splitlines() if not is_descriptive(line))


def is_descriptive(line):
    found = directive(line)
    return found is not None and found[0] in DESCRIPTIVE


def downloadable_export(template):
    """Destination parameter and format of an export whose file Duckpad can offer for download.

    Decided from the template text, so copies imported under another identifier keep it.
    """
    blocks = [block for block in template["blocks"] if not block["output"] and not is_check(block)]
    if len(blocks) != 1:
        return None
    # Inputs become tables, resources a literal of their own name, every other parameter a placeholder.
    names = [p["name"] for p in template["parameters"] if base_type(p["type"]) in RESOURCE_TYPES]
    values = {name: qi(name) for name in template["inputs"]} | {name: literal(name) for name in names}
    sql = REFERENCE.sub(lambda m: values.get(m[1], "$" + m[1]), blocks[0]["sql"])
    try:
        tree = parse_block(sql)
    except (Problem, sqlglot.errors.SqlglotError):
        return None
    export = file_export(tree, [literal(name) for name in names]).get("export_file")
    return {"parameter": export["path"], "format": export["format"]} if export else None


def expression(value):
    try:
        parsed = sqlglot.parse(str(value), read="duckdb")
        if len(parsed) != 1 or parsed[0] is None:
            raise ValueError()
        node = parsed[0]
        if any(node.find_all(exp.Query, exp.DDL, exp.DML, exp.Command)):
            raise ValueError()
        return node.sql(dialect="duckdb")
    except Exception as error:
        raise Problem(f"Invalid SQL expression: {value}") from error


def expression_list(value):
    """A projection list such as `region, SUM(amount) AS revenue`, without any other clause."""
    if not isinstance(value, str):
        return value
    try:
        parsed = sqlglot.parse_one("SELECT " + value, read="duckdb")
    except sqlglot.errors.ParseError as error:
        raise Problem(f"Invalid SQL expression list: {value}") from error
    if not isinstance(parsed, exp.Select) or any(v for k, v in parsed.args.items() if k != "expressions"):
        raise Problem(f"Expression lists cannot contain query clauses: {value}")
    return [x.sql(dialect="duckdb") for x in parsed.expressions]


def variable_placeholders(variables, parameters):
    """Variable name -> the named DuckDB parameter binding its value, distinct from template parameters."""
    # DuckDB treats parameter names as case-insensitive, including generated suffixes.
    parameter_names = {name.lower() for name in parameters}
    taken = parameter_names | {"var_" + name for name in variables}
    result = {}
    for name in sorted(variables):
        placeholder = "var_" + name
        if placeholder in parameter_names:
            suffix = 2
            while f"{placeholder}_{suffix}" in taken:
                suffix += 1
            placeholder = f"{placeholder}_{suffix}"
            taken.add(placeholder)
        result[name] = placeholder
    return result


def bind_variables(name, value, variables, placeholders):
    """An expression parameter value with its `{{ var.name }}` references turned into named parameters.

    The text never receives a variable's value:
    DuckDB binds it with its type, and dates are cast like date parameters.
    """

    def replace(match):
        variable = match[1]
        if variable not in placeholders:
            raise Problem(f"{name} references variable {variable}, which has no value here")
        placeholder = "$" + placeholders[variable]
        return (
            f"CAST({placeholder} AS DATE)"
            if base_type(variables[variable]["type"]) == "date"
            else placeholder
        )

    def substitute(text):
        if not isinstance(text, str):
            return text
        check_variables(name, text)
        return VARIABLE_REFERENCE.sub(replace, text)

    return [substitute(item) for item in value] if isinstance(value, list) else substitute(value)


def check_variables(name, text):
    """Check each reference's source position before substitution or SQL normalization."""
    matches = list(VARIABLE_REFERENCE.finditer(text))
    if not matches:
        return
    try:
        tokens = sqlglot.tokenize(text, read="duckdb")
    except sqlglot.errors.TokenError as error:
        raise Problem(f"Invalid SQL expression: {text}") from error
    # Only a reference in SQL code starts with a brace token. Braces in strings,
    # quoted identifiers, dollar-quoted strings and comments are not code tokens.
    starts = {token.start for token in tokens if token.token_type == TokenType.L_BRACE}
    missing = sorted({match[1] for match in matches if match.start() not in starts})
    if missing:
        variables = ", ".join(f"{{{{ var.{variable} }}}}" for variable in missing)
        raise Problem(
            f"{name}: write {variables} as a value, outside quotes and comments. "
            "Its value is bound with its type, never inserted into the SQL text."
        )


def render_path(name, text, values):
    """Render only scalar variable references, once, with no general interpolation."""
    if not isinstance(text, str):
        raise Problem(f"{name} requires a path")
    remainder = VARIABLE_REFERENCE.sub("", text)
    if "{{" in remainder or "}}" in remainder:
        raise Problem(f"{name}: invalid path reference; use {{{{ var.name }}}}")

    def replace(match):
        variable = values.get(match[1])
        if not variable or "value" not in variable:
            raise Problem(f"{name}: variable {match[1]} has no resolved value")
        kind, value = base_type(variable["type"]), variable["value"]
        if kind not in ("text", "choice", "date", "number", "boolean"):
            raise Problem(f"{name}: {kind} cannot be used in a path")
        if kind == "boolean":
            return "true" if value else "false"
        if kind == "number":
            if (
                isinstance(value, bool)
                or not isinstance(value, (float, int))
                or (isinstance(value, float) and not math.isfinite(value))
            ):
                raise Problem(f"{name}: expected a finite number")
            return json.dumps(value)
        if "\x00" in str(value):
            raise Problem(f"{name}: a path cannot contain a NUL character")
        return str(value)

    return VARIABLE_REFERENCE.sub(replace, text)


def authorize_path(template, path, root, kind, connections, reference):
    """Check the resolved resource against its captured root, including glob matches."""
    if reference:
        connection = connection_for(connections, reference)
        capability = "write" if kind == "destination" else "read"
        if capability not in connection["definition"].get("capabilities", []):
            raise Problem(f"Connection {reference} does not support {capability}")
    if URI.match(path):
        # An interpolated authority cannot select a different credential scope.
        baseline = str(root) if URI.match(str(root)) else template
        before, after = urlsplit(baseline), urlsplit(path)
        if not before.scheme or (before.scheme, before.netloc) != (after.scheme, after.netloc):
            raise Problem("Path references cannot change the URI scheme or authority")
        # A query can carry settings such as s3_endpoint; only the written one is allowed.
        written = urlsplit(template)
        if (after.query, after.fragment) != (written.query, written.fragment):
            raise Problem("Path references cannot change a URI query or fragment")
        if any(part == ".." for part in unquote(after.path).split("/")):
            raise Problem("Path references cannot traverse a resource root")
        if URI.match(str(root)) and not after.path.startswith(before.path.rstrip("/") + "/"):
            raise Problem("Path is outside the connection root")
        return path
    if URI.match(str(root)):
        raise Problem("Path references cannot change the URI scheme or authority")
    base = Path(root).resolve()
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = base / candidate
    # Return the checked path: DuckDB and export capture must not reinterpret `..` or symlinks.
    candidate = candidate.resolve()
    if not candidate.is_relative_to(base):
        raise Problem("Path is outside the allowed resource root")
    for matched in base.glob(str(candidate.relative_to(base))):
        if not matched.resolve().is_relative_to(base):
            raise Problem("Path glob follows a symlink outside the resource root")
    return str(candidate)


def connection_for(connections, reference):
    if reference not in connections:
        raise Problem(f"Missing connection: {reference}")
    return connections[reference]


def is_project_files(reference):
    """An empty connection selects project files: the project's uploads and exports, never a connection."""
    return reference in (None, "")


def under_root(root, path):
    """Append a relative path to a storage root; a URI prefix such as `s3://bucket/landing` stays as written."""
    if URI.match(root):
        return root + ("" if root.endswith("/") else "/") + path
    return str(Path(root) / path)


def render_parameter(
    template,
    parameter,
    parameters,
    connections,
    project_files,
    input_schemas=None,
    variables=None,
    placeholders=None,
    bound=None,
):
    """Return the SQL text of a structural parameter, or None for a bound scalar value.

    `bound` maps parameters bound whole to a variable to their binding: such values are
    never rendered again, and a computed one is checked like `{{ var.name }}`.
    """
    name, type_name = parameter["name"], parameter["type"]
    kind, argument = base_type(type_name), type_argument(type_name)
    value = parameters[name]
    if (bound or {}).get(name, {}).get("plan"):
        return literal("<partition parameter: " + name + ">") if kind in RESOURCE_TYPES else None
    if kind in ("expression", "expressions"):
        value = bind_variables(name, value, variables or {}, placeholders or {})
        return (
            expression(value)
            if kind == "expression"
            else ", ".join(expression(x) for x in expression_list(value))
        )
    if kind in PREPARATION_TYPES:
        return render_preparation(kind, value, (input_schemas or {}).get(argument))
    if kind == "connection":
        if is_project_files(value):
            # Only file and destination parameters can resolve project files.
            if any(name in REFERENCE.findall(block["sql"]) for block in template["blocks"]):
                raise Problem(f"Choose a connection for {name}")
            return ""
        connection = connection_for(connections, value)
        capability = "write" if template["writes_external"] else "read"
        if capability not in connection["definition"].get("capabilities", []):
            raise Problem(f"Connection {value} does not support {capability}")
        return qi(connection["alias"])
    if kind == "secret":
        if is_project_files(parameters[argument]):
            raise Problem(f"Choose a connection for {argument}")
        return literal(connection_for(connections, parameters[argument])["secret_name"])
    if kind in RESOURCE_TYPES:
        reference = parameters[argument] if argument else None
        if is_project_files(reference):
            root = str(project_files[kind])
        else:
            connection = connection_for(connections, reference)
            if connection["definition"].get("family") != "storage":
                raise Problem(f"Connection {reference} is not a file storage location")
            root = connection["values"].get("root") or ""
        path, binding = str(value), (bound or {}).get(name)
        if binding is not None and binding.get("source") == "node":
            # A value read from data must not choose a resource outside the captured root.
            template, values = "{{ var." + binding["name"] + " }}", {binding["name"]: binding}
        elif binding is None and ("{{" in path or "}}" in path):
            template, values = path, variables or {}
        else:
            template = None
        if template is not None:
            path = render_path(name, template, values)
        if kind == "file" and not path.strip():
            raise Problem(f"Choose or upload a file for parameter {name}")
        relative = not URI.match(path) and not Path(path).is_absolute()
        if relative and not root:
            raise Problem(f"Connection {reference} has no root in this environment; use an absolute path")
        if template is None:
            return literal(under_root(root, path) if relative else path)
        if relative and URI.match(root):
            path = under_root(root, path)
        return literal(
            authorize_path(template, path, root or str(project_files[kind]), kind, connections, reference)
        )
    if kind in ("column", "identifier"):
        return ".".join(qi(part) for part in str(value).split("."))
    if kind in OBJECT_NAMES:
        if not isinstance(value, str) or not value.strip():
            raise Problem(f"Choose a {OBJECT_NAMES[kind]} for {name}")
        # One name, which may contain dots: databases list it as is.
        return qi(value)
    if kind == "schema":
        return render_schema(name, value)
    if kind == "keyword":
        if (
            argument is None
            or str(value) not in argument.split("|")
            or not re.fullmatch(r"[A-Za-z ]+", str(value))
        ):
            raise Problem(f"Invalid SQL keyword parameter: {name}")
        return str(value).upper()
    if kind == "list":
        return render_list(name, type_name, value)
    check_scalar(name, kind, argument, value)
    return None


def render_schema(name, value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as error:
            raise Problem(f"{name} requires a JSON object of column names and DuckDB types") from error
    if not isinstance(value, dict) or not all(isinstance(v, str) for v in value.values()):
        raise Problem(f"{name} requires an object of column names and DuckDB types")
    return "{" + ", ".join(f"{literal(k)}: {literal(v)}" for k, v in value.items()) + "}"


def render_list(name, type_name, value):
    subtype = re.search(r"<(\w+)>", type_name)
    if not subtype or subtype[1] not in LIST_ITEM_TYPES or not isinstance(value, list):
        raise Problem(f"{name} requires a typed list (text, number, boolean or column)")
    item_type = subtype[1]
    for item in value:
        if item_type in ("text", "column"):
            valid = isinstance(item, str)
        elif item_type == "boolean":
            valid = isinstance(item, bool)
        else:
            valid = isinstance(item, (int, float)) and not isinstance(item, bool)
        if not valid:
            raise Problem(f"{name} contains a value incompatible with {item_type}")
    return ", ".join(qi(x) if item_type == "column" else literal(x) for x in value)


def check_scalar(name, kind, argument, value):
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise Problem(f"{name} requires a number")
    elif kind == "boolean" and not isinstance(value, bool):
        raise Problem(f"{name} requires a boolean")
    elif kind == "date" and not is_date(value):
        raise Problem(f"{name} requires a date written YYYY-MM-DD")
    elif kind == "choice" and argument and str(value) not in argument.split("|"):
        raise Problem(f"{name} must be one of {argument}")


def parse_block(sql):
    try:
        trees = [x for x in sqlglot.parse(sql, read="duckdb") if x]
    except sqlglot.errors.ParseError as error:
        raise Problem(str(error)) from error
    if len(trees) != 1:
        raise Problem("Each SQL block must contain exactly one statement")
    return trees[0]


def check_access(block, tree, allowed, connections, resources):
    """Reject data access outside the node's declared inputs, earlier outputs, resources and connections.

    Return whether the query's result is a lineage source: it reads external data, or
    no flow data at all. Later outputs can trace through that snapshot normally.
    """
    if block["output"] or is_check(block):
        if not isinstance(tree, exp.Query):
            raise Problem("Outputs, tests and messages must be read-only tabular queries")
    elif not isinstance(tree, (exp.Copy, exp.Insert)):
        raise Problem("A tabular query needs an @output declaration; writes must use COPY TO or INSERT")
    local_names = {x.strip('"') for x in allowed} | {cte.alias for cte in tree.find_all(exp.CTE)}
    aliases = {c["alias"] for c in connections.values()}
    destination = tree.this if isinstance(tree, exp.Insert) else None
    if isinstance(destination, exp.Schema):
        destination = destination.this
    reads_local = reads_external = False
    for table in tree.find_all(exp.Table):
        if table is not destination and is_local_table(table, local_names):
            reads_local = True
            continue
        if isinstance(table.this, exp.Identifier):
            if table.catalog not in aliases and table.db not in aliases:
                raise Problem(f"Undeclared data access or destination: {table.sql(dialect='duckdb')}")
        elif table is destination:
            raise Problem("INSERT requires a declared connection destination")
        elif not isinstance(table.this, (exp.GenerateSeries, exp.ExplodingGenerateSeries)):
            # Readers name declared resources; query() and other table functions are rejected.
            check_reader(table.this, resources)
        reads_external = reads_external or table is not destination
    if isinstance(tree, exp.Copy) and tree.args.get("kind"):
        raise Problem("Export COPY must write TO its declared destination")
    return reads_external or not reads_local


def check_reader(function, resources):
    """A reader's only positional argument names declared resources; the rest are named options."""
    arguments = [
        value
        for values in function.args.values()
        for value in (values if isinstance(values, list) else [values])
        if isinstance(value, exp.Expression)
    ]
    positional = [argument for argument in arguments if not is_option(argument)]
    files = positional[0].expressions if positional and isinstance(positional[0], exp.Array) else positional
    if len(positional) != 1 or not files or any(f.sql(dialect="duckdb") not in resources for f in files):
        raise Problem("Readers must read only declared file resource parameters")


def is_option(argument):
    """`delim = ','` or `delim := ','`, as passed to DuckDB table functions."""
    return isinstance(argument, (exp.EQ, exp.PropertyEQ, exp.Kwarg)) and isinstance(
        argument.this, (exp.Column, exp.Identifier, exp.Var)
    )


def is_local_table(table, local_names):
    return (
        isinstance(table.this, exp.Identifier)
        and table.name in local_names
        and not table.db
        and not table.catalog
    )


def compile_template(
    template,
    params,
    inputs,
    physical_outputs,
    connections,
    project_files,
    input_schemas=None,
    variables=None,
    bound=None,
):
    """Compile a template's blocks into statements with their bound parameters.

    `project_files` maps `file` and `destination` to the directories that resolve their relative
    paths when no connection root applies: the project's resources and the environment's exports.
    `variables` maps the variables referenced inside expression parameters to their type and
    value; each statement lists the named parameters binding them in `variable_bindings`.
    `bound` maps parameters bound whole to a variable to their binding.
    """
    values, bindings = dict(inputs), {}
    parameters = {p["name"]: params.get(p["name"], p.get("default")) for p in template["parameters"]}
    # Captured connections span the run; a block may only access this node's declarations.
    references = {parameters[p["name"]] for p in template["parameters"] if p["type"] == "connection"}
    connections = {reference: c for reference, c in connections.items() if reference in references}
    variables = variables or {}
    placeholders = variable_placeholders(variables, parameters)
    bindings.update({placeholders[name]: variable["value"] for name, variable in variables.items()})
    for parameter in template["parameters"]:
        name = parameter["name"]
        # A connection without a value selects project files.
        if (
            parameters[name] is None
            and parameter["type"] != "connection"
            and not (bound or {}).get(name, {}).get("plan")
        ):
            raise Problem(f"Parameter {name} is required")
        rendered = render_parameter(
            template,
            parameter,
            parameters,
            connections,
            project_files,
            input_schemas,
            variables,
            placeholders,
            bound,
        )
        if rendered is None:
            bindings[name] = parameters[name]
            # Dates are bound as ISO text, which a bound VARCHAR would not compare with a DATE.
            values[name] = f"CAST(${name} AS DATE)" if base_type(parameter["type"]) == "date" else "$" + name
        else:
            values[name] = rendered
    resources = [values[p["name"]] for p in template["parameters"] if base_type(p["type"]) in RESOURCE_TYPES]
    allowed = set(inputs.values())
    statements = []
    for block in execution_blocks(template):
        source_location = source_context(block, values, physical_outputs)
        rendered = REFERENCE.sub(lambda m: values[m[1]], block["sql"])
        try:
            tree = parse_block(rendered)
        except Problem as error:
            raise SqlSourceError(error, source_location, rendered, phase="compilation") from error
        message_block = block.get("message_block")
        source = check_access(block, tree, allowed, connections, resources)
        query = tree.sql(dialect="duckdb")
        used = {
            name: value
            for name, value in bindings.items()
            if re.search(r"\$" + re.escape(name) + r"\b", query)
        }
        labels = {placeholder: name for name, placeholder in placeholders.items() if placeholder in used}
        output = block["output"]
        physical = physical_outputs.get(output)
        referenced_outputs = set(REFERENCE.findall(block["sql"])) & set(template["outputs"])
        statements.append(
            {
                "output": output,
                "table": physical,
                "source_location": source_location,
                "source": source,
                # Runs materialize outputs from this query and record the statements they execute.
                "sql": query,
                "bindings": used,
                **(
                    {
                        **(
                            {"message_block": message_block}
                            if message_block
                            else {
                                "test_name": block["test_name"],
                                "test_severity": block["test_severity"],
                            }
                        ),
                        "message_output": next(iter(referenced_outputs))
                        if len(referenced_outputs) == 1
                        else None,
                    }
                    if is_check(block)
                    else {}
                ),
                **({"variable_bindings": labels} if labels else {}),
                **file_export(tree, resources),
            }
        )
        if output:
            values[output] = qi(physical)
            allowed.add(qi(physical))
    paths = {
        p["name"]: {
            "template": parameters[p["name"]],
            "variables": VARIABLE_REFERENCE.findall(str(parameters[p["name"]])),
            "resource": sqlglot.parse_one(values[p["name"]], read="duckdb").this,
        }
        for p in template["parameters"]
        if base_type(p["type"]) in RESOURCE_TYPES
    }
    if paths:
        for statement in statements:
            statement["paths"] = paths
    return statements


def file_export(tree, resources):
    """Recognize a single local CSV/XLSX COPY to a declared destination."""
    if not isinstance(tree, exp.Copy) or tree.args.get("kind"):
        return {}
    files = tree.args.get("files", [])
    options = {p.name.upper(): p.args.get("expression") for p in tree.args.get("params", [])}
    format_name = options.get("FORMAT")
    format_name = format_name.name.lower() if format_name is not None else ""
    if (
        format_name not in ("csv", "xlsx")
        or len(files) != 1
        or not isinstance(files[0], exp.Literal)
        or not files[0].is_string
        or files[0].sql(dialect="duckdb") not in resources
        or URI.match(files[0].this)
        or set(options) - {"FORMAT", "HEADER", "DELIMITER", "SHEET"}
    ):
        return {}
    return {"export_file": {"path": files[0].this, "format": format_name}}
