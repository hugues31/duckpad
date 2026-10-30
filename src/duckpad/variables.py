"""Project variables: typed values declared in variables.json and bound to whole node parameters.

A parameter of the root flow, including an exposed parameter of a component instance, takes a
variable's value with `{"$var": "name"}`. Binding replaces the reference with the value of the
selected environment before fingerprinting and compilation. The fingerprint therefore covers the
JSON type and value actually bound: renaming a variable or editing its description never
invalidates a result, and promoting a literal to a variable holding the same value keeps it valid.
"""

import copy
import json
import math
import re

from .templates import base_type, directives, is_date, parse_parameter, type_argument
from .util import Problem, dumps

FILE = "variables.json"
KEY = "$var"
NAME = re.compile(r"[a-z][a-z0-9_]*")
FIELDS = {"type", "description", "default", "environments"}
SCALAR_TYPES = ("text", "number", "boolean", "date", "identifier")
LIST_TYPE = re.compile(r"list\s*<\s*(text|number)\s*>")
CHOICE_TYPE = re.compile(r"choice\s*\((.*)\)")
# Expression references are delivery step 3; templates and components never accept them.
EXPRESSION_REFERENCE = re.compile(r"{{\s*var\.(\w+)\s*}}")
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
        for param in references(node.get("params"))
    ]
    parameters = definition.get("parameters", {})
    if isinstance(parameters, dict):
        found += [
            f"default of {name}"
            for name, parameter in parameters.items()
            if isinstance(parameter, dict) and reference(parameter.get("default")) is not None
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
    """Environment-independent errors of the bound parameters of expanded nodes."""
    variables, file_error = declarations(bundle)
    excluded = unportable(bundle)
    result = []
    for key, node in nodes.items():
        bound = references(node.get("params"))
        if not bound or node.get("error") or file_error:
            continue
        if portability_error(bundle, node, excluded):
            # Reported once, on the definition.
            continue
        result += [
            {"file": "flow.json", "node": key, "message": message}
            for param, name in sorted(bound.items())
            if (message := reference_error(bundle, variables, None, node, param, name))
        ]
    return result


def bind(bundle, nodes, environment):
    """Replace the variable references of expanded nodes with their values in an environment.

    Each bound node records `variables`: parameter -> name, type, and value and source, or the
    binding error. A binding error becomes the node's error, which blocks the node and its
    descendants in that environment only; its parameter is unset so it is never compiled.
    """
    variables, file_error = declarations(bundle)
    excluded = unportable(bundle)
    for node in nodes.values():
        portability = portability_error(bundle, node, excluded) if any(excluded) else None
        if portability and not node.get("error"):
            node["error"] = portability
        bound = references(node.get("params"))
        if not bound:
            continue
        errors = [portability] if portability else []
        node["variables"] = {}
        for param, name in sorted(bound.items()):
            variable = variables.get(name)
            binding = {"name": name, "type": variable["type"] if variable else None}
            message = portability or reference_error(bundle, variables, file_error, node, param, name)
            if message is None:
                resolved = resolve(variable, environment)
                if "error" in resolved:
                    message = f"Variable {name}: {resolved['error']}"
                else:
                    binding.update(resolved)
            if message:
                binding["error"] = message
                if message not in errors:
                    errors.append(message)
                node["params"][param] = None
            else:
                node["params"][param] = binding["value"]
            node["variables"][param] = binding
        if errors and not node.get("error"):
            node["error"] = "; ".join(errors)
    return nodes


def used(bundle, nodes, keys, environment):
    """Variables used by bound nodes: name -> type, and value and source or the reason it has none."""
    variables, file_error = declarations(bundle)
    names = sorted({b["name"] for key in keys for b in nodes[key].get("variables", {}).values()})
    result = {}
    for name in names:
        if name in variables:
            result[name] = {"type": variables[name]["type"], **resolve(variables[name], environment)}
        else:
            result[name] = {"type": None, "error": file_error or "undeclared variable"}
    return result


def annotate(statements, node):
    """List the variables of a node's bound parameters next to its compiled statements."""
    listed = [{"parameter": param, **binding} for param, binding in sorted(node.get("variables", {}).items())]
    if listed:
        for statement in statements:
            statement["variables"] = copy.deepcopy(listed)
    return statements


def usages(bundle):
    """Variable name -> the root flow node parameters bound to it."""
    result = {}
    for node in bundle["flow"].get("nodes", []):
        for param, name in sorted(references(node.get("params")).items()):
            result.setdefault(name, []).append(
                {"node": node["id"], "label": node.get("label") or node["id"], "param": param}
            )
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
    """A copy of a bundle with a declared variable and every root flow reference to it renamed."""
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
    for node in result["flow"].get("nodes", []):
        for param, name in references(node.get("params")).items():
            if name == old:
                node["params"][param] = {KEY: new}
    return result


def computation(bundle, nodes):
    """Replace references with what their variables compute, for comparisons across environments.

    A declaration without its description stands for the variable: value changes in any
    environment affect the node, while renames and documentation edits do not.
    """
    variables, file_error = declarations(bundle)
    for node in nodes.values():
        for param, name in references(node.get("params")).items():
            variable = variables.get(name)
            node["params"][param] = {
                KEY: {k: v for k, v in variable.items() if k != "description"}
                if variable
                else file_error or "undeclared"
            }
    return nodes
