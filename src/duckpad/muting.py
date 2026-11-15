"""Replace muted node code with deterministic input-to-output passthroughs."""

from .node_code import node_sql
from .templates import IDENTIFIER, directives, parse_template
from .util import Problem


def passthrough(bundle, node, parent=None):
    if node.get("component"):
        definition = bundle["components"].get(node["component"])
        if definition is None:
            raise Problem(f"Missing component: {node['component']}")
        inputs, outputs = [list(definition.get(direction, {})) for direction in ("inputs", "outputs")]
    elif node.get("language") == "python":
        contract = node.get("python_contract") or parse_template(node_sql(bundle, node, parent), "python")
        inputs, outputs = contract["inputs"], contract["outputs"]
    else:
        declared = directives(node_sql(bundle, node, parent))
        inputs, outputs = [
            [port for kind, port in declared if kind == direction] for direction in ("input", "output")
        ]
    if not inputs:
        raise Problem("Only nodes with inputs can be muted")
    if any(not IDENTIFIER.fullmatch(port) for port in [*inputs, *outputs]):
        raise Problem("Muted nodes need valid port identifiers")
    if len(set(inputs)) != len(inputs) or len(set(outputs)) != len(outputs):
        raise Problem("Muted nodes need unique input and output ports")
    # Port order defines the route. A single input fans out; extra outputs use the first input.
    routes = {
        output: inputs[index] if index < len(inputs) else inputs[0] for index, output in enumerate(outputs)
    }
    aliases = {}
    for index, port in enumerate(dict.fromkeys(routes.values())):
        alias = f"mute_input_{index}"
        while alias in outputs:
            alias = "_" + alias
        aliases[alias] = port
    reverse = {port: alias for alias, port in aliases.items()}
    text = "\n".join(
        [
            *(f"-- @input {alias}" for alias in aliases),
            *(
                f"-- @output {output}\nSELECT * FROM {{{{ {reverse[port]} }}}};"
                for output, port in routes.items()
            ),
        ]
    )
    # Muted exports have no statements at all: no write, message or test is executed.
    template = (
        parse_template(text)
        if outputs
        else {
            "inputs": [],
            "outputs": [],
            "parameters": [],
            "blocks": [],
            "writes_external": False,
        }
    )
    template["inputs"] = inputs
    return template, text, aliases
