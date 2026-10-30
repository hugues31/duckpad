"""Typed SQL templates. Compilation never executes SQL."""

import json
import re
from pathlib import Path

import sqlglot
from sqlglot import exp

from .data_preparation import PREPARATION_TYPES, render_preparation
from .util import Problem, literal, qi

REFERENCE = re.compile(r"{{\s*(\w+)\s*}}")
IDENTIFIER = re.compile(r"[A-Za-z_]\w*")
DIRECTIVE = re.compile(r"^\s*--\s*@([\w]+)\s*(.*?)\s*$")
PARAMETER = re.compile(r"(\w+)\s*:\s*([^=]+?)(?:\s*=\s*(.*))?")
URI = re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*://")
KINDS = ("source", "transform", "export")
PARAMETER_TYPES = {
    "text",
    "number",
    "boolean",
    "choice",
    "keyword",
    "file",
    "destination",
    "connection",
    "secret",
    "column",
    "identifier",
    "expression",
    "expressions",
    "schema",
    "list",
    *PREPARATION_TYPES,
}
# Types whose argument names the connection parameter that resolves them.
CONNECTION_BOUND = {"file", "destination", "secret"}
RESOURCE_TYPES = ("file", "destination")
# Directives that document a template without changing what it computes.
DESCRIPTIVE = ("label", "description")
LIST_ITEM_TYPES = ("text", "number", "boolean", "column")


def base_type(type_name):
    """`file(connection)` -> `file`, `list<text>` -> `list`."""
    return re.split(r"[<(]", type_name.strip())[0]


def type_argument(type_name):
    """`choice(a|b)` -> `a|b`; None without parentheses."""
    match = re.search(r"\((.*)\)", type_name)
    return (match[1] or None) if match else None


def directive(line):
    """`-- @param limit: number` -> ("param", "limit: number"); None for a SQL line."""
    match = DIRECTIVE.match(line)
    return match.groups() if match else None


def directives(sql):
    """Every directive of a template, in order, without validating the template."""
    return [found for found in map(directive, (sql or "").splitlines()) if found]


def parse_template(sql):
    template = {
        "label": "SQL template",
        "description": "",
        "kind": "transform",
        "inputs": [],
        "parameters": [],
        "outputs": [],
        "blocks": [],
    }
    current, buffer = None, []

    def flush():
        if "\n".join(buffer).strip():
            template["blocks"].append({"output": current, "sql": "\n".join(buffer).strip()})
        buffer.clear()

    for line in sql.splitlines():
        found = directive(line)
        if not found:
            buffer.append(line)
            continue
        key, value = found
        if key in ("label", "description", "kind"):
            template[key] = value
        elif key == "input":
            template["inputs"].append(value)
        elif key == "param":
            template["parameters"].append(parse_parameter(value))
        elif key == "output":
            flush()
            current = value
            template["outputs"].append(value)
        else:
            raise Problem(f"Unknown template directive: @{key}")
    flush()
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
        if kind not in CONNECTION_BOUND or (argument is None and kind != "secret"):
            continue
        if argument is None or parameters.get(argument, {}).get("type") != "connection":
            raise Problem(f"Parameter {parameter['name']} must reference a declared connection parameter")
    available = set(template["inputs"]) | set(parameters)
    for block in template["blocks"]:
        missing = set(REFERENCE.findall(block["sql"])) - available
        if missing:
            raise Problem("Undeclared, self or forward reference: " + ", ".join(sorted(missing)))
        if block["output"]:
            available.add(block["output"])
        elif template["kind"] != "export":
            raise Problem("A tabular query needs an @output declaration")
    if not template["blocks"]:
        raise Problem("Template has no SQL statements")
    if template["kind"] not in KINDS:
        raise Problem("Template kind must be source, transform or export")
    if template["kind"] == "export" and template["outputs"]:
        raise Problem("An export cannot declare a tabular output")


def parse_templates(templates):
    """Parse every template, reporting each invalid one in place of its interface."""
    parsed = {}
    for name, sql in templates.items():
        try:
            parsed[name] = parse_template(sql)
        except Problem as error:
            parsed[name] = {"error": str(error)}
    return parsed


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
    if template["kind"] != "export" or len(template["blocks"]) != 1:
        return None
    # Inputs become tables, resources a literal of their own name, every other parameter a placeholder.
    names = [p["name"] for p in template["parameters"] if base_type(p["type"]) in RESOURCE_TYPES]
    values = {name: qi(name) for name in template["inputs"]} | {name: literal(name) for name in names}
    sql = REFERENCE.sub(lambda m: values.get(m[1], "$" + m[1]), template["blocks"][0]["sql"])
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


def connection_for(connections, reference):
    if reference not in connections:
        raise Problem(f"Missing connection: {reference}")
    return connections[reference]


def render_parameter(template, parameter, parameters, connections, directory, input_schemas=None):
    """Return the SQL text of a structural parameter, or None for a bound scalar value."""
    name, type_name = parameter["name"], parameter["type"]
    kind, argument = base_type(type_name), type_argument(type_name)
    value = parameters[name]
    if kind in PREPARATION_TYPES:
        return render_preparation(kind, value, (input_schemas or {}).get(argument))
    if kind == "connection":
        connection = connection_for(connections, value)
        capability = "write" if template["kind"] == "export" else "read"
        if capability not in connection["definition"].get("capabilities", []):
            raise Problem(f"Connection {value} does not support {capability}")
        return qi(connection["alias"])
    if kind == "secret":
        return literal(connection_for(connections, parameters[argument])["secret_name"])
    if kind in ("file", "destination"):
        root = connection_for(connections, parameters[argument])["values"].get("root", "") if argument else ""
        path = str(value)
        if not URI.match(path) and not Path(path).is_absolute():
            path = str(Path(root or directory) / path)
        return literal(path)
    if kind in ("column", "identifier"):
        return ".".join(qi(part) for part in str(value).split("."))
    if kind == "expression":
        return expression(value)
    if kind == "expressions":
        return ", ".join(expression(x) for x in expression_list(value))
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
    elif kind == "choice" and argument and str(value) not in argument.split("|"):
        raise Problem(f"{name} must be one of {argument}")


def parse_block(sql):
    try:
        trees = [x for x in sqlglot.parse(sql, read="duckdb") if x]
    except sqlglot.errors.ParseError as error:
        raise Problem(str(error)) from error
    if len(trees) != 1:
        raise Problem("Each output block must contain exactly one statement")
    return trees[0]


def check_access(template, tree, allowed, connections, resources):
    """Reject data access that the template's kind and declared interface do not permit."""
    local_names = {x.strip('"') for x in allowed} | {cte.alias for cte in tree.find_all(exp.CTE)}
    aliases = {c["alias"] for c in connections.values()}
    kind = template["kind"]
    if kind == "transform":
        if not isinstance(tree, exp.Query):
            raise Problem("Transformations must be read-only tabular queries")
        # Subqueries, CTEs and ordinary scalar functions are permitted. Table
        # functions are rejected here, including readers and query() access.
        for table in tree.find_all(exp.Table):
            if not is_local_table(table, local_names):
                raise Problem(f"Undeclared data access: {table.sql(dialect='duckdb')}")
    elif kind == "source":
        if not isinstance(tree, exp.Query):
            raise Problem("Sources must return a tabular query")
        for table in tree.find_all(exp.Table):
            if isinstance(table.this, exp.Identifier):
                if table.name not in local_names and table.catalog not in aliases and table.db not in aliases:
                    raise Problem(
                        f"Source table requires a declared connection: {table.sql(dialect='duckdb')}"
                    )
            elif not isinstance(table.this, (exp.GenerateSeries, exp.ExplodingGenerateSeries)):
                check_reader(table.this, resources)
    else:
        if not isinstance(tree, (exp.Copy, exp.Insert)):
            raise Problem("Exports must use an explicit COPY TO or INSERT statement")
        destination = tree.this if isinstance(tree, exp.Insert) else None
        if isinstance(destination, exp.Schema):
            destination = destination.this
        for table in tree.find_all(exp.Table):
            if table is destination and (table.catalog in aliases or table.db in aliases):
                continue
            if not is_local_table(table, local_names):
                raise Problem(f"Undeclared export input or destination: {table.sql(dialect='duckdb')}")
        if isinstance(tree, exp.Copy) and tree.args.get("kind"):
            raise Problem("Export COPY must write TO its declared destination")


def check_reader(function, resources):
    """A source reader's only positional argument names declared resources; the rest are named options."""
    arguments = [
        value
        for values in function.args.values()
        for value in (values if isinstance(values, list) else [values])
        if isinstance(value, exp.Expression)
    ]
    positional = [argument for argument in arguments if not is_option(argument)]
    files = positional[0].expressions if positional and isinstance(positional[0], exp.Array) else positional
    if len(positional) != 1 or not files or any(f.sql(dialect="duckdb") not in resources for f in files):
        raise Problem("Source readers must read only declared file resource parameters")


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


def compile_template(template, params, inputs, physical_outputs, connections, directory, input_schemas=None):
    values, bindings = dict(inputs), {}
    parameters = {p["name"]: params.get(p["name"], p.get("default")) for p in template["parameters"]}
    for parameter in template["parameters"]:
        name = parameter["name"]
        if parameters[name] is None:
            raise Problem(f"Parameter {name} is required")
        rendered = render_parameter(template, parameter, parameters, connections, directory, input_schemas)
        if rendered is None:
            bindings[name] = parameters[name]
            values[name] = "$" + name
        else:
            values[name] = rendered
    resources = [values[p["name"]] for p in template["parameters"] if base_type(p["type"]) in RESOURCE_TYPES]
    allowed = set(inputs.values())
    statements = []
    for block in template["blocks"]:
        tree = parse_block(REFERENCE.sub(lambda m: values[m[1]], block["sql"]))
        check_access(template, tree, allowed, connections, resources)
        query = tree.sql(dialect="duckdb")
        used = {
            name: value
            for name, value in bindings.items()
            if re.search(r"\$" + re.escape(name) + r"\b", query)
        }
        output = block["output"]
        physical = physical_outputs.get(output)
        statements.append(
            {
                "output": output,
                "table": physical,
                "query": query,
                # Runs materialize outputs from this query and record the statements they execute.
                "sql": query,
                "bindings": used,
                **file_export(tree, resources),
            }
        )
        if output:
            values[output] = qi(physical)
            allowed.add(qi(physical))
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
