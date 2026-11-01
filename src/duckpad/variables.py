"""Project variables: typed values declared in variables.json and used by root flow parameters.

A parameter of the root flow, including an exposed parameter of a component instance, takes a
variable's value with `{"$var": "name"}`. Binding replaces the reference with the value of the
selected environment before fingerprinting and compilation. The fingerprint therefore covers the
JSON type and value actually bound: renaming a variable or editing its description never
invalidates a result, and promoting a literal to a variable holding the same value keeps it valid.

Expression parameters can also reference variables inside their text, as `{{ var.name }}`.
Binding resolves each reference without changing the text; compilation turns it into a named
DuckDB parameter holding the typed value, and fingerprints cover the type and value in its place.
"""

import copy
import json
import math
import re
from collections.abc import Iterable

from .templates import VARIABLE_REFERENCE, base_type, directives, is_date, parse_parameter, type_argument
from .types import Record
from .util import Problem, dumps

FILE = "variables.json"
KEY = "$var"
NAME = re.compile(r"[a-z][a-z0-9_]*")
FIELDS = {"type", "description", "default", "environments"}
SCALAR_TYPES = ("text", "number", "boolean", "date", "identifier")
LIST_TYPE = re.compile(r"list\s*<\s*(text|number)\s*>")
CHOICE_TYPE = re.compile(r"choice\s*\((.*)\)")
# `{{ var.name }}` inside expression parameters; templates and components never accept them.
EXPRESSION_REFERENCE = VARIABLE_REFERENCE
EXPRESSION_PARAMETERS = ("expression", "expressions")
# Variable types an expression can reference: each becomes a DuckDB parameter of the same type.
EXPRESSION_TYPES = ("text", "number", "boolean", "date", "choice")
SECRET_HINTS = ("password", "passwd", "secret", "token", "apikey", "api_key", "credential", "private_key")
# Parameter types each variable type binds to. Choices also bind to choice and keyword
# parameters offering every option, and lists to the same list type.
BINDABLE = {
    "text": ("text", "file", "destination"),
    "number": ("number",),
    "boolean": ("boolean",),
    "date": ("date",),
    "identifier": ("identifier", "column"),
    "choice": ("text",),
}


def reference(value):
    """The variable named by a parameter value such as `{"$var": "order_status"}`, else None."""
    if isinstance(value, dict) and len(value) == 1 and isinstance(value.get(KEY), str):
        return value[KEY]
    return None


def references(params):
    """Parameter name -> variable name for the bound parameters of a node."""
    if not isinstance(params, dict):
        return {}
    return {param: name for param, value in params.items() if (name := reference(value)) is not None}


def parameter_texts(value):
    """The texts of a parameter value that can hold expression references."""
    if isinstance(value, str):
        return [value]
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def expression_references(value):
    """Variable names referenced as `{{ var.name }}` in a parameter value, each once, in order."""
    return list(
        dict.fromkeys(name for text in parameter_texts(value) for name in EXPRESSION_REFERENCE.findall(text))
    )


def referenced(params):
    """Parameter name -> variable names referenced inside its text, for the parameters that have some."""
    if not isinstance(params, dict):
        return {}
    return {param: names for param, value in params.items() if (names := expression_references(value))}


def substitute(value, replace):
    """A parameter value with each `{{ var.name }}` replaced by `replace(name)`."""
    if isinstance(value, list):
        return [substitute(item, replace) if isinstance(item, str) else item for item in value]
    return (
        EXPRESSION_REFERENCE.sub(lambda match: replace(match[1]), value) if isinstance(value, str) else value
    )


def read(text):
    """The bundle form of variables.json: an object, None without the file, or the raw text otherwise.

    Raw text keeps a malformed file saved and editable as it is, like other invalid content.
    """
    if text is None:
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return text
    return value if isinstance(value, dict) else text


def write(value):
    return value if isinstance(value, str) else dumps(value)


def options(type_name):
    argument = type_argument(type_name)
    return argument.split("|") if argument else []


def normalized_type(type_name):
    """A declared variable type in canonical form, or None when it is not a variable type."""
    if not isinstance(type_name, str):
        return None
    text = type_name.strip()
    if text in SCALAR_TYPES:
        return text
    if match := LIST_TYPE.fullmatch(text):
        return f"list<{match[1]}>"
    if match := CHOICE_TYPE.fullmatch(text):
        values = [value.strip() for value in match[1].split("|")]
        if all(values) and len(set(values)) == len(values) and not any(c in match[1] for c in "()"):
            return f"choice({'|'.join(values)})"
    return None


def check_value(type_name, value):
    """Why a value does not match a variable type, or None."""
    kind = base_type(type_name)
    if kind == "text":
        valid = isinstance(value, str)
    elif kind == "identifier":
        valid = isinstance(value, str) and value.strip() != ""
    elif kind == "number":
        # Integers are exact and always finite: math.isfinite would convert them to floats,
        # which overflows beyond about 10**308.
        valid = (isinstance(value, int) and not isinstance(value, bool)) or (
            isinstance(value, float) and math.isfinite(value)
        )
    elif kind == "boolean":
        valid = isinstance(value, bool)
    elif kind == "date":
        valid = is_date(value)
    elif kind == "choice":
        valid = isinstance(value, str) and value in options(type_name)
    else:
        item = "text" if type_name == "list<text>" else "number"
        valid = isinstance(value, list) and all(check_value(item, x) is None for x in value)
    if valid:
        return None
    expected = {
        "text": "text",
        "identifier": "a non-empty identifier",
        "number": "a finite number",
        "boolean": "true or false",
        "date": "a date written YYYY-MM-DD",
        "choice": "one of " + ", ".join(options(type_name)),
    }.get(kind, "a list of " + ("text values" if type_name == "list<text>" else "numbers"))
    return f"expected {expected}, got {json.dumps(value, ensure_ascii=False, default=str)}"


def declarations(bundle):
    """Parse a bundle's variables into `(variables, file_error)`.

    Each variable holds its canonical type, description, environment values and optional
    default, plus `errors`: the default or environment keys whose value does not match the
    type. A file error makes every variable unavailable.
    """
    raw = bundle.get("variables")
    if raw is None:
        return {}, None
    if isinstance(raw, str):
        try:
            json.loads(raw)
        except ValueError as error:
            return {}, f"{FILE} is not valid JSON: {error}"
    if not isinstance(raw, dict):
        return {}, f"{FILE} must contain a JSON object of variables"
    result = {}
    for name, declaration in raw.items():
        if not NAME.fullmatch(name):
            return {}, (
                f"Invalid variable name {name!r}: use lowercase letters, digits and underscores, "
                "starting with a letter"
            )
        if not isinstance(declaration, dict):
            return {}, f"Variable {name} must be an object with a type"
        unknown = sorted(declaration.keys() - FIELDS)
        if unknown:
            return {}, f"Variable {name} has unknown fields: {', '.join(unknown)}"
        type_name = normalized_type(declaration.get("type"))
        if type_name is None:
            return {}, (
                f"Variable {name} has an unknown type {declaration.get('type')!r}. Use text, number, "
                "boolean, date, choice(a|b), identifier, list<text> or list<number>."
            )
        description = declaration.get("description", "")
        environments = declaration.get("environments", {})
        if not isinstance(description, str):
            return {}, f"Variable {name}: the description must be text"
        if not isinstance(environments, dict):
            return {}, f"Variable {name}: environments must be an object of values"
        errors = {}
        if "default" in declaration:
            message = check_value(type_name, declaration["default"])
            if message:
                errors["default"] = f"invalid default value, {message}"
        for environment, value in environments.items():
            message = check_value(type_name, value)
            if message:
                errors["environment:" + environment] = f"invalid value for {environment}, {message}"
        result[name] = {
            "type": type_name,
            "description": description,
            **({"default": declaration["default"]} if "default" in declaration else {}),
            "environments": environments,
            "errors": errors,
        }
    return result, None


def resolve(variable, environment):
    """`{"value", "source"}` of a variable in an environment, or `{"error"}` when it has no valid value."""
    if environment in variable["environments"]:
        source, key, value = (
            "environment",
            "environment:" + environment,
            variable["environments"][environment],
        )
    elif "default" in variable:
        source, key, value = "default", "default", variable["default"]
    else:
        return {"error": f"no value in {environment}"}
    if key in variable["errors"]:
        return {"error": variable["errors"][key]}
    return {"value": copy.deepcopy(value), "source": source}


def compatible(variable_type, parameter_type):
    kind, target = base_type(variable_type), base_type(parameter_type)
    if kind == "list":
        return re.sub(r"\s+", "", parameter_type) == variable_type
    if target in BINDABLE.get(kind, ()):
        return True
    if kind == "choice" and target in ("choice", "keyword"):
        offered = options(parameter_type)
        return (target == "choice" and not offered) or set(options(variable_type)) <= set(offered)
    return False


def template_references(text):
    """Variable references written in a template, which must not depend on a project."""
    found = [f"{{{{ var.{name} }}}}" for name in EXPRESSION_REFERENCE.findall(text or "")]
    for kind, value in directives(text):
        if kind == "param":
            try:
                parameter = parse_parameter(value)
            except Problem:
                continue
            if reference(parameter.get("default")) is not None:
                found.append(f"default of {parameter['name']}")
    return found


def component_references(definition):
    """Variable references written in a component definition, which must not depend on a project."""
    if not isinstance(definition, dict):
        return []
    nodes = definition.get("nodes", [])
    found = [
        f"{node.get('id')}.{param}"
        for node in (nodes if isinstance(nodes, list) else [])
        if isinstance(node, dict)
        for param in sorted(references(node.get("params")).keys() | referenced(node.get("params")).keys())
    ]
    parameters = definition.get("parameters", {})
    if isinstance(parameters, dict):
        found += [
            f"default of {name}"
            for name, parameter in parameters.items()
            if isinstance(parameter, dict)
            and (
                reference(parameter.get("default")) is not None
                or expression_references(parameter.get("default"))
            )
        ]
    return found


def definition_problems(bundle):
    """Errors on templates and component definitions that reference variables."""
    problems = []
    for key, text in sorted(bundle.get("templates", {}).items()):
        if found := template_references(text):
            problems.append(
                {
                    "file": f"templates/{key}.sql",
                    "message": f"Templates cannot reference project variables ({', '.join(found)}). "
                    "Declare a parameter, then bind it to the variable on the node in the flow.",
                }
            )
    for path, text in sorted(bundle.get("node_sql", {}).items()):
        if found := template_references(text):
            problems.append(
                {
                    "file": path,
                    "message": f"Node code cannot reference project variables ({', '.join(found)}). "
                    "Declare a parameter, then bind it to the variable on the node in the flow.",
                }
            )
    for key, definition in sorted(bundle.get("components", {}).items()):
        if found := component_references(definition):
            problems.append(
                {
                    "file": f"components/{key}.json",
                    "message": "Component definitions cannot reference project variables "
                    f"({', '.join(found)}). Expose the parameter, then bind it to the variable "
                    "on the component instance.",
                }
            )
    return problems


def definition_chain(bundle, key):
    """Component IDs that an expanded node key passes through, outermost first."""
    graph, chain = bundle["flow"], []
    for part in key.split("::")[:-1]:
        node = next((n for n in graph.get("nodes", []) if n.get("id") == part), None)
        identity = node.get("component") if node else None
        if identity not in bundle.get("components", {}):
            break
        chain.append(identity)
        graph = bundle["components"][identity]
    return chain


def exposed_types(bundle, key, param):
    """`(component, parameter, type)` of the typed exposed parameters that carry a leaf parameter.

    Expansion copies an instance's exposed parameter value to its targets, possibly through
    nested instances. Walking back from the leaf, each exposed parameter on the way is a
    contract that a variable bound on the root instance must meet, like the template parameter.
    """
    parts, chain, result = key.split("::"), definition_chain(bundle, key), []
    for index in reversed(range(len(chain))):
        parameters = bundle["components"][chain[index]].get("parameters", {})
        target = (parts[index + 1], param)
        carriers = [
            name
            for name, parameter in (parameters.items() if isinstance(parameters, dict) else ())
            if isinstance(parameter, dict)
            and isinstance(parameter.get("targets"), list)
            and any(
                isinstance(t, dict) and (t.get("node"), t.get("param")) == target
                for t in parameter["targets"]
            )
        ]
        if not carriers:
            break
        # Like expansion, the last exposed parameter targeting the same parameter wins.
        param = carriers[-1]
        if isinstance(type_name := parameters[param].get("type"), str):
            result.append((chain[index], param, type_name))
    return result


def unportable(bundle):
    """IDs of the components and templates whose definitions reference variables themselves."""
    return (
        {key for key, definition in bundle.get("components", {}).items() if component_references(definition)},
        {key for key, text in bundle.get("templates", {}).items() if template_references(text)},
    )


def portability_error(bundle, node, excluded):
    """The error of a node built from a definition that references variables, else None.

    Only the root flow binds variables. Every node of such a definition is blocked, so no
    reference is ever resolved from a template or component.
    """
    components, templates = excluded
    for identity in definition_chain(bundle, node["id"]):
        if identity in components:
            return (
                f"Component {identity} references project variables. Expose the parameter, then bind "
                "it to the variable on the component instance."
            )
    if not node.get("template") and template_references(node.get("template_sql", "")):
        return "Node code references project variables. Declare a parameter, then bind it to the variable on the node in the flow."
    if node.get("template") in templates:
        return (
            f"Template {node['template']} references project variables. Declare a parameter, then "
            "bind it to the variable on the node in the flow."
        )
    return None


def reference_error(bundle, variables, file_error, node, param, name):
    """Why a node parameter cannot take a variable in any environment, else None."""
    if file_error:
        return f"Cannot bind {param} to variable {name}: {file_error}"
    if name not in variables:
        return f"Parameter {param} references undeclared variable {name}"
    parameter = next((p for p in node["parsed"]["parameters"] if p["name"] == param), None)
    variable_type = variables[name]["type"]
    contracts = [(None, param, parameter["type"])] if parameter else []
    for component, target, type_name in contracts + exposed_types(bundle, node["id"], param):
        if not compatible(variable_type, type_name):
            where = f" of component {component}" if component else ""
            return f"Variable {name} ({variable_type}) cannot be bound to parameter {target}{where} ({type_name})"
    return None


def expression_error(variables, file_error, parameter, name):
    """Why a `{{ var.name }}` reference inside a node parameter cannot take a value in any environment."""
    param, type_name = parameter["name"], parameter["type"]
    if base_type(type_name) not in EXPRESSION_PARAMETERS:
        return (
            f"Parameter {param} ({type_name}) cannot reference variable {name} inside its text: only "
            "expression parameters can. Bind the whole parameter to the variable instead."
        )
    if file_error:
        return f"Cannot use variable {name} in {param}: {file_error}"
    if name not in variables:
        return f"Parameter {param} references undeclared variable {name}"
    variable_type = variables[name]["type"]
    kind = base_type(variable_type)
    if kind == "identifier":
        return (
            f"Variable {name} (identifier) cannot be used inside expression {param}. Bind it to a column "
            "or identifier parameter instead."
        )
    if kind not in EXPRESSION_TYPES:
        return (
            f"Variable {name} ({variable_type}) cannot be used inside expression {param}. Bind it to a "
            "parameter of the same list type instead."
        )
    return None


def expression_references_of(node):
    """Declared parameter -> variable names referenced inside its text, for an expanded node.

    Compilation ignores undeclared parameters, so their text references nothing.
    """
    declared = {p["name"] for p in node["parsed"]["parameters"]}
    return {param: names for param, names in referenced(node.get("params")).items() if param in declared}


def problems(bundle):
    """Errors of variables.json and of references inside definitions. Warnings are separate."""
    variables, file_error = declarations(bundle)
    if file_error:
        result = [{"file": FILE, "message": file_error}]
    else:
        result = [
            {"file": FILE, "variable": name, "message": f"Variable {name}: {message}"}
            for name, variable in sorted(variables.items())
            for message in variable["errors"].values()
        ]
    return result + definition_problems(bundle)


def node_problems(bundle, nodes):
    """Environment-independent errors of the bound parameters and expression references of expanded nodes."""
    variables, file_error = declarations(bundle)
    excluded = unportable(bundle)
    result = []
    for key, node in nodes.items():
        bound, texts = references(node.get("params")), expression_references_of(node)
        if not (bound or texts) or node.get("error"):
            continue
        if portability_error(bundle, node, excluded):
            # Reported once, on the definition.
            continue
        parameters = {p["name"]: p for p in node["parsed"]["parameters"]}
        messages = [
            reference_error(bundle, variables, None, node, param, name)
            for param, name in sorted(bound.items())
            if not file_error
        ]
        for param, names in sorted(texts.items()):
            # A file error is reported once, on the file; a misplaced reference does not depend on it.
            if not file_error or base_type(parameters[param]["type"]) not in EXPRESSION_PARAMETERS:
                messages += [expression_error(variables, None, parameters[param], name) for name in names]
        result += [{"file": "flow.json", "node": key, "message": message} for message in messages if message]
    return result


def bind(bundle, nodes, environment):
    """Replace the variable references of expanded nodes with their values in an environment.

    Each bound node records `variables`: parameter -> name, type, and value and source, or the
    binding error. A binding error becomes the node's error, which blocks the node and its
    descendants in that environment only; its parameter is unset so it is never compiled.

    Expression parameters keep their text. Their `{{ var.name }}` references are recorded in
    `references`: parameter -> list of the same bindings, in order of first appearance.
    """
    variables, file_error = declarations(bundle)
    excluded = unportable(bundle)

    def resolved(name, message):
        variable = variables.get(name)
        binding = {"name": name, "type": variable["type"] if variable else None}
        if message is None:
            value = resolve(variable, environment)
            if "error" in value:
                message = f"Variable {name}: {value['error']}"
            else:
                binding.update(value)
        if message:
            binding["error"] = message
        return binding

    for node in nodes.values():
        portability = portability_error(bundle, node, excluded) if any(excluded) else None
        if portability and not node.get("error"):
            node["error"] = portability
        bound, texts = references(node.get("params")), expression_references_of(node)
        if not (bound or texts):
            continue
        errors = [portability] if portability else []
        if bound:
            node["variables"] = {}
        for param, name in sorted(bound.items()):
            binding = resolved(
                name, portability or reference_error(bundle, variables, file_error, node, param, name)
            )
            node["params"][param] = binding.get("value")
            node["variables"][param] = binding
        if texts:
            parameters = {p["name"]: p for p in node["parsed"]["parameters"]}
            node["references"] = {
                param: [
                    resolved(
                        name, portability or expression_error(variables, file_error, parameters[param], name)
                    )
                    for name in names
                ]
                for param, names in sorted(texts.items())
            }
        for binding in [*node.get("variables", {}).values(), *expression_bindings(node)]:
            if "error" in binding and binding["error"] not in errors:
                errors.append(binding["error"])
        if errors and not node.get("error"):
            node["error"] = "; ".join(errors)
    return nodes


def expression_bindings(node):
    """The bindings of a bound node's expression references, across its parameters."""
    return [binding for bindings in node.get("references", {}).values() for binding in bindings]


def expression_values(node):
    """Variable name -> type and value, for the expression references of a bound node to compile."""
    return {
        binding["name"]: {"type": binding["type"], "value": binding["value"]}
        for binding in expression_bindings(node)
        if "value" in binding
    }


def used(bundle: Record, nodes: dict[str, Record], keys: Iterable[str], environment: str) -> Record:
    """Variables used by bound nodes: name -> type, and value and source or the reason it has none."""
    variables, file_error = declarations(bundle)
    names = sorted(
        {
            b["name"]
            for key in keys
            for b in [*nodes[key].get("variables", {}).values(), *expression_bindings(nodes[key])]
        }
    )
    result = {}
    for name in names:
        if name in variables:
            result[name] = {"type": variables[name]["type"], **resolve(variables[name], environment)}
        else:
            result[name] = {"type": None, "error": file_error or "undeclared variable"}
    return result


def run_usages(node):
    """What a run records about a node's variables: bound parameters, and expression references."""
    result = {}
    if node.get("variables"):
        result["variables"] = {param: binding["name"] for param, binding in node["variables"].items()}
    if node.get("references"):
        result["references"] = {
            param: [binding["name"] for binding in bindings] for param, bindings in node["references"].items()
        }
    return result


def annotate(statements: list[Record], node: Record) -> list[Record]:
    """List the variables of a node's bound parameters and expressions next to its compiled statements.

    An expression reference also names the DuckDB parameter that binds its value in a statement.
    """
    bound = [{"parameter": param, **binding} for param, binding in sorted(node.get("variables", {}).items())]
    texts = [
        {"parameter": param, **binding}
        for param, bindings in sorted(node.get("references", {}).items())
        for binding in bindings
    ]
    if bound or texts:
        for statement in statements:
            placeholders = {name: key for key, name in statement.get("variable_bindings", {}).items()}
            statement["variables"] = copy.deepcopy(bound) + [
                {
                    **copy.deepcopy(item),
                    **({"binding": placeholders[item["name"]]} if item["name"] in placeholders else {}),
                }
                for item in texts
            ]
    return statements


def usages(bundle):
    """Variable name -> the root flow node parameters bound to it or referencing it in their text."""
    result: dict[str, list[Record]] = {}
    for node in bundle["flow"].get("nodes", []):
        usage = {"node": node["id"], "label": node.get("label") or node["id"]}
        for param, name in sorted(references(node.get("params")).items()):
            result.setdefault(name, []).append({**usage, "param": param})
        for param, names in sorted(referenced(node.get("params")).items()):
            for name in names:
                result.setdefault(name, []).append({**usage, "param": param, "expression": True})
    return result


def warnings(bundle, environments):
    """Non-blocking advice: values for environments this instance lacks, and secret-like names."""
    variables, _ = declarations(bundle)
    result = []
    for name, variable in sorted(variables.items()):
        result += [
            {
                "file": FILE,
                "variable": name,
                "message": f"Variable {name} has a value for {environment}, which is not an "
                "environment of this instance",
            }
            for environment in sorted(variable["environments"])
            if environment not in environments
        ]
        if any(hint in name for hint in SECRET_HINTS):
            result.append(
                {
                    "file": FILE,
                    "variable": name,
                    "message": f"Variable {name} looks like a credential. Variables are visible in Git, "
                    "compiled SQL and run history; keep secrets in a connection.",
                }
            )
    return result


def summary(bundle, environments):
    """A bundle's variables for the interface: values per environment, usages and diagnostics."""
    variables, file_error = declarations(bundle)
    used_by = usages(bundle)
    advice = warnings(bundle, environments)
    return {
        "file_error": file_error,
        "declarations": {
            name: {
                **{k: copy.deepcopy(v) for k, v in variable.items() if k != "errors"},
                "errors": list(variable["errors"].values()),
                "warnings": [w["message"] for w in advice if w["variable"] == name],
                "values": {environment: resolve(variable, environment) for environment in environments},
                "usages": used_by.get(name, []),
            }
            for name, variable in variables.items()
        },
        "undeclared": {name: found for name, found in used_by.items() if name not in variables},
        "diagnostics": problems(bundle),
        "warnings": advice,
    }


def rename(bundle, old, new):
    """A copy of a bundle with a declared variable and its root flow and view references renamed."""
    variables, file_error = declarations(bundle)
    if file_error:
        raise Problem(f"Correct {FILE} before renaming a variable: {file_error}", 422)
    if old not in variables:
        raise Problem(f"Variable {old} not found", 404)
    if not NAME.fullmatch(new):
        raise Problem("Variable names use lowercase letters, digits and underscores, starting with a letter")
    if new != old and new in variables:
        raise Problem(f"A variable named {new} already exists", 409)
    result = copy.deepcopy(bundle)
    result["variables"] = {
        (new if name == old else name): value for name, value in result["variables"].items()
    }

    def renamed(name):
        return f"{{{{ var.{new if name == old else name} }}}}"

    for node in result["flow"].get("nodes", []):
        for param, name in references(node.get("params")).items():
            if name == old:
                node["params"][param] = {KEY: new}
        for param in referenced(node.get("params")):
            node["params"][param] = substitute(node["params"][param], renamed)
    # Shared result views filter with the same references.
    saved = result.get("views")
    for views in saved.values() if isinstance(saved, dict) else []:
        for view in views if isinstance(views, list) else []:
            if isinstance(view, dict) and "filter" in view:
                view["filter"] = substitute(view["filter"], renamed)
    return result


def computation(bundle, nodes):
    """Replace references with what their variables compute, for comparisons across environments.

    A declaration without its description stands for the variable: value changes in any
    environment affect the node, while renames and documentation edits do not.
    """
    variables, file_error = declarations(bundle)

    def computed(name):
        variable = variables.get(name)
        return (
            {k: v for k, v in variable.items() if k != "description"}
            if variable
            else file_error or "undeclared"
        )

    for node in nodes.values():
        for param, name in references(node.get("params")).items():
            node["params"][param] = {KEY: computed(name)}
        for param in referenced(node.get("params")):
            node["params"][param] = substitute(
                node["params"][param],
                lambda name: "{{ var " + json.dumps(computed(name), sort_keys=True) + " }}",
            )
    return nodes


def fingerprinted(node, params):
    """Parameters with each expression reference replaced by the type and value it binds.

    Renaming a variable keeps a fingerprint, while changing the value it binds in this
    environment changes it. Parameters without references are returned unchanged.
    """
    bindings = {binding["name"]: binding for binding in expression_bindings(node)}
    if not bindings:
        return params

    def bound(name):
        binding = bindings[name]
        computed = {k: binding[k] for k in ("type", "value", "error") if k in binding}
        return "{{ var " + json.dumps(computed, sort_keys=True) + " }}"

    return {
        param: substitute(value, bound) if param in node["references"] else value
        for param, value in params.items()
    }
