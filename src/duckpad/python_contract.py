"""Static Python port and parameter discovery. Never import or execute project code."""

import ast
import math
from typing import NoReturn

from .util import Problem

TYPES = {
    "str": "text",
    "int": "number",
    "float": "number",
    "bool": "boolean",
    "dp.Column": "column",
    "dp.Connection": "connection",
    "dp.File": "file",
    "dp.Destination": "destination",
    "dp.SchemaName": "schema_name",
    "dp.TableName": "table_name",
    "dp.Date": "date",
    "date": "date",
}
METADATA = {
    "default",
    "label",
    "description",
    "ge",
    "gt",
    "le",
    "lt",
    "input",
    "connection",
    "schema",
    "choices",
}


def spelling(node):
    return ast.unparse(node) if node is not None else ""


def fail(node, message) -> NoReturn:
    raise Problem(f"Python line {getattr(node, 'lineno', 1)}: {message}", 422)


def constant(node):
    try:
        value = ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError):
        fail(node, "Use an explicit literal for parameter defaults and metadata")
    if isinstance(value, float) and not math.isfinite(value):
        fail(node, "Parameter values must be finite")
    return value


def is_label(line):
    return line.strip().startswith("# @label ")


def executable_python(source):
    """Node code without its label comment, so relabeling never invalidates results."""
    return "\n".join(line for line in (source or "").splitlines() if not is_label(line))


def parse_python(source):
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        raise Problem(f"Python line {error.lineno}: {error.msg}", 422) from None
    nodes = [
        n for n in tree.body if isinstance(n, ast.ClassDef) and any(spelling(b) == "dp.Node" for b in n.bases)
    ]
    if len(nodes) != 1:
        raise Problem("Declare exactly one direct dp.Node subclass and import duckpad as dp", 422)
    cls = nodes[0]
    if len(cls.bases) != 1 or cls.keywords or cls.decorator_list:
        fail(cls, "Node inheritance and decorators must not change the static contract")
    methods = {n.name: n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    if "__init__" in methods or "__new__" in methods:
        fail(cls, "Use the supplied Node constructor; custom constructors are unsupported")
    run = methods.get("run")
    if not isinstance(run, ast.FunctionDef) or run.decorator_list:
        fail(cls, "Declare an ordinary run(self, ...) method")
    args = run.args
    if args.posonlyargs or args.vararg or args.kwarg or args.defaults or any(args.kw_defaults):
        fail(run, "Inputs need explicit named arguments without defaults, *args or **kwargs")
    if not args.args or args.args[0].arg != "self":
        fail(run, "The first argument of run must be self")
    inputs = []
    for argument in [*args.args[1:], *args.kwonlyargs]:
        if spelling(argument.annotation) != "dp.Relation":
            fail(argument, "Each run input must be annotated dp.Relation")
        inputs.append(argument.arg)
    output = spelling(run.returns)
    outputs = []
    if output == "dp.Relation":
        outputs = ["result"]
    elif output != "None":
        declarations = [n for n in cls.body if isinstance(n, ast.ClassDef) and n.name == output]
        if len(declarations) != 1 or [spelling(b) for b in declarations[0].bases] != ["dp.Outputs"]:
            fail(run, "Return dp.Relation, None, or a nested class inheriting dp.Outputs")
        declaration = declarations[0]
        if declaration.decorator_list or declaration.keywords:
            fail(declaration, "Output declarations must be static")
        for field in declaration.body:
            if (
                isinstance(field, ast.Expr)
                and isinstance(field.value, ast.Constant)
                and isinstance(field.value.value, str)
            ):
                continue
            if (
                not isinstance(field, ast.AnnAssign)
                or not isinstance(field.target, ast.Name)
                or field.value is not None
                or spelling(field.annotation) != "dp.Relation"
            ):
                fail(field, "Output fields must be name: dp.Relation without defaults")
            outputs.append(field.target.id)
    if len(outputs) != len(set(outputs)):
        fail(cls, "Output names must be unique")
    parameters = []
    for field in cls.body:
        docstring = (
            isinstance(field, ast.Expr)
            and isinstance(field.value, ast.Constant)
            and isinstance(field.value.value, str)
        )
        if not docstring and not isinstance(
            field, (ast.AnnAssign, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Pass)
        ):
            fail(
                field, "Use annotated parameters or ClassVar constants; dynamic declarations are unsupported"
            )
        if not isinstance(field, ast.AnnAssign):
            continue
        if not isinstance(field.target, ast.Name):
            fail(field, "Parameter declarations need a simple attribute name")
        annotation = spelling(field.annotation)
        if annotation.startswith(("ClassVar[", "typing.ClassVar[")):
            continue
        name = field.target.id
        if name.startswith("_") or name in {
            "run",
            "db",
            "write",
            "partition",
            "message",
            "check",
            "artifact",
            "connection",
            "Outputs",
        }:
            fail(field, f"Reserved parameter name: {name}")
        metadata = {}
        if isinstance(field.value, ast.Call):
            if spelling(field.value.func) != "dp.param" or field.value.args:
                fail(field, "Use dp.param with explicit keyword arguments")
            for kw in field.value.keywords:
                if kw.arg not in METADATA or kw.arg in metadata:
                    fail(field, f"Unsupported or repeated parameter metadata: {kw.arg}")
                metadata[kw.arg] = constant(kw.value)
        elif field.value is not None:
            metadata["default"] = constant(field.value)
        if any(not isinstance(metadata[key], str) for key in ("label", "description") if key in metadata):
            fail(field, "Parameter labels and descriptions must be literal strings")
        kind = TYPES.get(annotation)
        if isinstance(field.annotation, ast.Subscript) and spelling(field.annotation.value) in (
            "Literal",
            "typing.Literal",
        ):
            literal = field.annotation.slice
            choices = (
                [constant(n) for n in literal.elts] if isinstance(literal, ast.Tuple) else [constant(literal)]
            )
            metadata["choices"] = choices
            kind = "choice"
        if not kind:
            fail(field, f"Unsupported parameter annotation: {annotation}")
        if "choices" in metadata:
            choices = metadata["choices"]
            if (
                not isinstance(choices, list)
                or not choices
                or any(not isinstance(x, str) or "|" in x or ")" in x for x in choices)
            ):
                fail(field, "Choices must be a nonempty list of literal strings without | or )")
            kind = "choice(" + "|".join(choices) + ")"
        binding = metadata.get("input") or metadata.get("connection") or metadata.get("schema")
        if kind == "column" and binding not in inputs:
            fail(field, "A column parameter requires input= naming a declared input")
        if binding:
            if not isinstance(binding, str) or not binding.isidentifier():
                fail(field, "Parameter bindings must be identifiers")
            kind += "(" + binding + ")"
        for bound in ("ge", "gt", "le", "lt"):
            if bound in metadata and (
                annotation not in ("int", "float") or type(metadata[bound]) not in (int, float)
            ):
                fail(field, "Numeric constraints require a numeric parameter and literal number")
        parameters.append({"name": name, "type": kind, "python_type": annotation, **metadata})
    if len({p["name"] for p in parameters}) != len(parameters):
        fail(cls, "Parameter names must be unique")
    return {
        "label": next(
            (line.split("@label", 1)[1].strip() for line in source.splitlines() if is_label(line)),
            cls.name,
        ),
        "description": ast.get_docstring(cls) or "",
        "class": cls.name,
        "language": "python",
        "inputs": inputs,
        "outputs": outputs,
        "parameters": parameters,
        "blocks": [],
        "writes_external": True,
        "download": {"parameter": "", "format": "zip"},
    }
