"""Typed SQL templates. Compilation never executes SQL."""

import json
import re
from pathlib import Path

import sqlglot
from sqlglot import exp

from .util import Problem, literal, qi

REFERENCE = re.compile(r"{{\s*(\w+)\s*}}")
DIRECTIVE = re.compile(r"^\s*--\s*@([\w]+)\s*(.*?)\s*$")


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
        match = DIRECTIVE.match(line)
        if not match:
            buffer.append(line)
            continue
        key, value = match.groups()
        if key in ("label", "description", "kind"):
            template[key] = value
        elif key == "input":
            template["inputs"].append(value)
        elif key == "param":
            match = re.fullmatch(r"(\w+)\s*:\s*([^=]+?)(?:\s*=\s*(.*))?", value)
            if not match:
                raise Problem(f"Invalid parameter declaration: {value}")
            name, type_name, default = match.groups()
            base_type = re.split(r"[<(]", type_name.strip())[0]
            if base_type not in {
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
            }:
                raise Problem(f"Unsupported parameter type: {type_name}")
            parameter = {"name": name, "type": type_name.strip()}
            if default is not None:
                try:
                    parameter["default"] = json.loads(default)
                except json.JSONDecodeError:
                    parameter["default"] = default.strip("'\"")
            template["parameters"].append(parameter)
        elif key == "output":
            flush()
            current = value
            template["outputs"].append(value)
        else:
            raise Problem(f"Unknown template directive: @{key}")
    flush()
    names = template["inputs"] + template["outputs"] + [p["name"] for p in template["parameters"]]
    if len(set(names)) != len(names):
        raise Problem("Inputs, outputs and parameters must have unique names")
    if any(not re.fullmatch(r"[A-Za-z_]\w*", n) for n in names):
        raise Problem("Port and parameter identifiers must contain letters, numbers or underscores")
    available = set(template["inputs"] + [p["name"] for p in template["parameters"]])
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
    if template["kind"] not in ("source", "transform", "export"):
        raise Problem("Template kind must be source, transform or export")
    if template["kind"] == "export" and template["outputs"]:
        raise Problem("An export cannot declare a tabular output")
    return template


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


def compile_template(template, params, inputs, physical_outputs, connections, directory):
    values, bindings = dict(inputs), {}
    parameters = {p["name"]: params.get(p["name"], p.get("default")) for p in template["parameters"]}
    allowed = set(inputs.values())
    for parameter in template["parameters"]:
        name, type_name = parameter["name"], parameter["type"]
        value = parameters[name]
        if value is None:
            raise Problem(f"Parameter {name} is required")
        base_type = re.split(r"[<(]", type_name)[0]
        if base_type == "connection":
            if value not in connections:
                raise Problem(f"Missing connection: {value}")
            connection = connections[value]
            capability = "write" if template["kind"] == "export" else "read"
            if capability not in connection["definition"].get("capabilities", []):
                raise Problem(f"Connection {value} does not support {capability}")
            values[name] = qi(connection["alias"])
        elif base_type == "secret":
            ref = re.search(r"\((\w+)\)", type_name)
            connection = connections[parameters[ref[1]]]
            values[name] = literal(connection["secret_name"])
        elif base_type in ("file", "destination"):
            ref = re.search(r"\((\w+)\)", type_name)
            root = connections[parameters[ref[1]]]["values"].get("root", "") if ref else ""
            path = str(value)
            if not re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*://", path) and not Path(path).is_absolute():
                path = str(Path(root or directory) / path)
            values[name] = literal(path)
        elif base_type in ("column", "identifier"):
            values[name] = ".".join(qi(part) for part in str(value).split("."))
        elif base_type == "expression":
            values[name] = expression(value)
        elif base_type == "expressions":
            if isinstance(value, str):
                parsed = sqlglot.parse_one("SELECT " + value, read="duckdb")
                items = [x.sql(dialect="duckdb") for x in parsed.expressions]
            else:
                items = value
            values[name] = ", ".join(expression(x) for x in items)
        elif base_type == "schema":
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except ValueError as error:
                    raise Problem(
                        f"{name} requires a JSON object of column names and DuckDB types"
                    ) from error
            if not isinstance(value, dict) or not all(isinstance(v, str) for v in value.values()):
                raise Problem(f"{name} requires an object of column names and DuckDB types")
            values[name] = "{" + ", ".join(f"{literal(k)}: {literal(v)}" for k, v in value.items()) + "}"
        elif base_type == "keyword":
            choices = re.search(r"\((.*)\)", type_name)
            if (
                not choices
                or str(value) not in choices[1].split("|")
                or not re.fullmatch(r"[A-Za-z ]+", str(value))
            ):
                raise Problem(f"Invalid SQL keyword parameter: {name}")
            values[name] = str(value).upper()
        elif base_type == "list":
            subtype = re.search(r"<(\w+)>", type_name)
            if (
                not subtype
                or subtype[1] not in ("text", "number", "boolean", "column")
                or not isinstance(value, list)
            ):
                raise Problem(f"{name} requires a typed list (text, number, boolean or column)")
            for item in value:
                valid = (
                    isinstance(item, str)
                    if subtype[1] in ("text", "column")
                    else isinstance(item, bool)
                    if subtype[1] == "boolean"
                    else isinstance(item, (int, float)) and not isinstance(item, bool)
                )
                if not valid:
                    raise Problem(f"{name} contains a value incompatible with {subtype[1]}")
            values[name] = ", ".join(
                qi(x) if subtype and subtype[1] == "column" else literal(x) for x in value
            )
        else:
            if base_type == "number":
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise Problem(f"{name} requires a number")
            elif base_type == "boolean" and not isinstance(value, bool):
                raise Problem(f"{name} requires a boolean")
            elif base_type == "choice":
                choices = re.search(r"\((.*)\)", type_name)
                if choices and str(value) not in choices[1].split("|"):
                    raise Problem(f"{name} must be one of {choices[1]}")
            bindings[name] = value
            values[name] = "$" + name
    statements = []
    for block in template["blocks"]:
        sql = REFERENCE.sub(lambda m: values[m[1]], block["sql"])
        try:
            trees = [x for x in sqlglot.parse(sql, read="duckdb") if x]
        except sqlglot.errors.ParseError as error:
            raise Problem(str(error)) from error
        if len(trees) != 1:
            raise Problem("Each output block must contain exactly one statement")
        tree = trees[0]
        if template["kind"] == "transform":
            if not isinstance(tree, exp.Query):
                raise Problem("Transformations must be read-only tabular queries")
            ctes = {cte.alias for cte in tree.find_all(exp.CTE)}
            allowed_names = {x.strip('"') for x in allowed} | ctes
            for table in tree.find_all(exp.Table):
                if (
                    not isinstance(table.this, exp.Identifier)
                    or table.name not in allowed_names
                    or table.db
                    or table.catalog
                ):
                    raise Problem(f"Undeclared data access: {table.sql(dialect='duckdb')}")
            # Subqueries, CTEs and ordinary scalar functions are permitted. Table
            # functions are rejected above, including readers and query() access.
        elif template["kind"] == "source":
            if not isinstance(tree, exp.Query):
                raise Problem("Sources must return a tabular query")
            aliases = {c["alias"] for c in connections.values()}
            local_names = {x.strip('"') for x in allowed} | {cte.alias for cte in tree.find_all(exp.CTE)}
            resources = [
                values[p["name"]]
                for p in template["parameters"]
                if p["type"].split("(")[0] in ("file", "destination")
            ]
            for table in tree.find_all(exp.Table):
                if isinstance(table.this, exp.Identifier):
                    if (
                        table.name not in local_names
                        and table.catalog not in aliases
                        and table.db not in aliases
                    ):
                        raise Problem(
                            f"Source table requires a declared connection: {table.sql(dialect='duckdb')}"
                        )
                elif not isinstance(table.this, (exp.GenerateSeries, exp.ExplodingGenerateSeries)):
                    if not any(resource in table.sql(dialect="duckdb") for resource in resources):
                        raise Problem("Source readers must use a declared file resource parameter")
        elif template["kind"] == "export":
            if not isinstance(tree, (exp.Copy, exp.Insert)):
                raise Problem("Exports must use an explicit COPY TO or INSERT statement")
            ctes = {cte.alias for cte in tree.find_all(exp.CTE)}
            allowed_names = {x.strip('"') for x in allowed} | ctes
            aliases = {c["alias"] for c in connections.values()}
            destination = tree.this if isinstance(tree, exp.Insert) else None
            if isinstance(destination, exp.Schema):
                destination = destination.this
            for table in tree.find_all(exp.Table):
                if table is destination and (table.catalog in aliases or table.db in aliases):
                    continue
                if (
                    not isinstance(table.this, exp.Identifier)
                    or table.name not in allowed_names
                    or table.db
                    or table.catalog
                ):
                    raise Problem(f"Undeclared export input or destination: {table.sql(dialect='duckdb')}")
            if isinstance(tree, exp.Copy) and tree.args.get("kind"):
                raise Problem("Export COPY must write TO its declared destination")
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
                "sql": f"CREATE TABLE {qi(physical)} AS {query}" if output else query,
                "bindings": used,
            }
        )
        if output:
            values[output] = qi(physical)
            allowed.add(qi(physical))
    return statements


BUILTINS = {
    "load_csv": """-- @label Load CSV
-- @description Read a CSV resource using native DuckDB options.
-- @kind source
-- @param connection: connection = "local"
-- @param file: file(connection) = "orders.csv"
-- @param delimiter: text = ","
-- @param header: boolean = true
-- @param types: schema = {}
-- @output result
SELECT * FROM read_csv({{ file }}, delim={{ delimiter }}, header={{ header }}, types={{ types }});
""",
    "load_parquet": """-- @label Load Parquet
-- @kind source
-- @param connection: connection = "local"
-- @param file: file(connection) = "customers.parquet"
-- @output result
SELECT * FROM read_parquet({{ file }});
""",
    "load_oracle": """-- @label Load Oracle
-- @kind source
-- @param connection: connection = "oracle"
-- @param schema: identifier = "DEMO"
-- @param resource: identifier = "ORDERS"
-- @output result
SELECT * FROM {{ connection }}.{{ schema }}.{{ resource }};
""",
    "join": """-- @label Join
-- @input left
-- @input right
-- @param join_type: keyword(inner|left|right|full) = "inner"
-- @param condition: expression = "l.customer_id = r.customer_id"
-- @param columns: expressions = "l.*, r.* EXCLUDE (customer_id)"
-- @output result
SELECT {{ columns }} FROM {{ left }} AS l {{ join_type }} JOIN {{ right }} AS r ON {{ condition }};
""",
    "filter": """-- @label Filter
-- @input source
-- @param condition: expression(source) = "amount > 0"
-- @output result
SELECT * FROM {{ source }} WHERE {{ condition }};
""",
    "aggregate": """-- @label Aggregate
-- @input source
-- @param groups: expressions = "region"
-- @param measures: expressions = "SUM(amount) AS revenue, COUNT(*) AS orders"
-- @output result
SELECT {{ groups }}, {{ measures }} FROM {{ source }} GROUP BY {{ groups }};
""",
    "export_csv": """-- @label Export CSV
-- @kind export
-- @input source
-- @param connection: connection = "local"
-- @param destination: destination(connection) = "export.csv"
-- @param delimiter: text = ","
-- @param header: boolean = true
COPY {{ source }} TO {{ destination }} (FORMAT CSV, HEADER {{ header }}, DELIMITER {{ delimiter }});
""",
    "export_oracle": """-- @label Export Oracle
-- @kind export
-- @input source
-- @param connection: connection = "oracle"
-- @param secret: secret(connection) = ""
-- @param destination: text = "DEMO.ORDER_TOTALS"
-- @param columns: expressions = "*"
COPY (SELECT {{ columns }} FROM {{ source }}) TO {{ destination }} (FORMAT oraduck, CONNECTION {{ secret }});
""",
    "sql": """-- @label SQL transform
-- @description A reusable SQL template with named ports and typed parameters.
-- @input source
-- @output result
SELECT * FROM {{ source }};
""",
}
