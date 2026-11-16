"""Charts: named Vega-Lite specs of node outputs, saved in charts.json with the project.

A chart only draws the retained rows of an output in the results panel; like a view it never
changes what runs compute. Charts are keyed like views, by `node:port`, and an entry has exactly
a `name` and a `spec`. The Chart tab renders nothing while this file has diagnostics.

A spec passes a structural allowlist, so a valid chart carries no data, no shaping and no
expression: shaping belongs in SQL nodes, where every plotted value keeps its lineage. Wherever
the allowlist expects a literal, only a JSON scalar is accepted, never an object such as
`{"expr": ...}`.
"""

import json
import re

from . import named_documents
from .project_files import CHARTS as DOCUMENT
from .util import Problem

FILE = DOCUMENT.file
FIELDS = {"name", "spec"}
MAX_SPEC_BYTES = 64 * 1024
SCHEMA = re.compile(r"https://vega\.github\.io/schema/vega-lite/v6(?:\.\d+\.\d+)?\.json")
DATA = {"name": "data"}
TOP_LEVEL = {"$schema", "data", "mark", "encoding", "layer", "title", "description", "width", "height"}
LAYER = {"mark", "encoding", "title", "description"}
TITLE = {"text", "subtitle"}
MARKS = ("bar", "line", "area", "point", "circle", "square", "tick", "rect", "rule", "text", "arc")
MARK_STYLE = {
    "type",
    "color",
    "opacity",
    "filled",
    "size",
    "strokeWidth",
    "interpolate",
    "point",
    "orient",
    "tooltip",
    "innerRadius",
    "outerRadius",
    "cornerRadius",
}
CHANNELS = (
    "x",
    "y",
    "x2",
    "y2",
    "xOffset",
    "yOffset",
    "theta",
    "radius",
    "color",
    "fill",
    "stroke",
    "opacity",
    "size",
    "shape",
    "strokeDash",
    "text",
    "tooltip",
    "detail",
    "order",
)
DEFINITION = {
    "field",
    "type",
    "title",
    "format",
    "formatType",
    "value",
    "scale",
    "axis",
    "legend",
    "sort",
    "stack",
}
TYPES = ("quantitative", "temporal", "ordinal", "nominal")
# The format types of Vega-Lite 6: it drops any other, with its format, as an unconfigured custom type.
FORMAT_TYPES = ("number", "time")
SCALE = {"type", "domain", "range", "scheme", "zero", "nice", "reverse"}
AXIS = {"title", "format", "formatType", "labelAngle", "grid", "orient", "tickCount"}
LEGEND = {"title", "format", "formatType", "orient"}
ORDERS = ("ascending", "descending")
STACKS = ("zero", "center")


class Invalid(Exception):
    """A spec construct outside the allowlist, described from the spec's root."""


def literal(value):
    """A JSON scalar: an object or a list could carry an expression."""
    return value is None or isinstance(value, str | int | float)


def text(value, path, nullable=False):
    if not isinstance(value, str) and not (nullable and value is None):
        raise Invalid(f"{path} must be a string")


def choice(value, path, choices):
    if not isinstance(value, str) or value not in choices:
        raise Invalid(f"{path} must be {', '.join(choices[:-1])} or {choices[-1]}")


def properties(value, path, allowed):
    if not isinstance(value, dict):
        raise Invalid(f"{path} must be an object")
    for name in value:
        if name not in allowed:
            raise Invalid(f"{path}.{name} is not allowed" if path else f"{name} is not allowed")


def literals(value, path):
    if not isinstance(value, list) or not all(literal(item) for item in value):
        raise Invalid(f"{path} must be a list of literals (strings, numbers, booleans or null)")


def scalar(value, path):
    if not literal(value):
        raise Invalid(f"{path} must be a literal (a string, number, boolean or null)")


def check_format(value, path):
    """A d3 format. Vega-Lite writes number formats into an expression string without escaping
    them, so a quote or a backslash would end the string and run the rest as an expression."""
    if not isinstance(value, str) or any(character in value for character in "\"'\\"):
        raise Invalid(f"{path} must be a string without quotes or backslashes")


def check_title(value, path):
    if isinstance(value, dict):
        properties(value, path, TITLE)
        for name, item in value.items():
            text(item, f"{path}.{name}")
    else:
        text(value, path)


def check_size(value, path):
    positive = isinstance(value, int | float) and not isinstance(value, bool) and value > 0
    if not positive and value != "container":
        raise Invalid(f'{path} must be a positive number or "container"')


def check_mark(value, path):
    if isinstance(value, dict):
        properties(value, path, MARK_STYLE)
        for name, item in value.items():
            if name != "type":
                scalar(item, f"{path}.{name}")
        value = value.get("type")
    if not isinstance(value, str):
        raise Invalid(f"{path} must be a mark type or an object with a type")
    if value not in MARKS:
        raise Invalid(f"{path} {value} is not allowed")


def check_guide(value, path, allowed, hidable=True):
    """A scale, axis or legend: literal properties, or null to hide an axis or a legend."""
    if value is None and hidable:
        return
    properties(value, path, allowed)
    for name, item in value.items():
        where = f"{path}.{name}"
        if name in ("domain", "range"):
            literals(item, where)
        elif name == "format":
            check_format(item, where)
        elif name == "formatType":
            choice(item, where, FORMAT_TYPES)
        else:
            scalar(item, where)


def check_sort(value, path):
    if value is None or (isinstance(value, list) and all(literal(item) for item in value)):
        return
    if isinstance(value, str) and (value in ORDERS or value.removeprefix("-") in CHANNELS):
        return
    if (
        isinstance(value, dict)
        and value.keys() <= {"encoding", "order"}
        and isinstance(value.get("encoding"), str)
        and value["encoding"] in CHANNELS
        and (value.get("order") is None or value["order"] in ORDERS)
    ):
        return
    raise Invalid(
        f"{path} must be ascending, descending, null, a channel name, a list of literals "
        'or {"encoding", "order"}'
    )


def check_stack(value, path):
    if not (value is None or isinstance(value, bool) or (isinstance(value, str) and value in STACKS)):
        raise Invalid(f'{path} must be true, false, null, "zero" or "center"')


def check_definition(value, path):
    properties(value, path, DEFINITION)
    for name, item in value.items():
        where = f"{path}.{name}"
        if name == "field":
            text(item, where)
        elif name == "type":
            choice(item, where, TYPES)
        elif name == "title":
            text(item, where, nullable=True)
        elif name == "format":
            check_format(item, where)
        elif name == "formatType":
            choice(item, where, FORMAT_TYPES)
        elif name == "value":
            scalar(item, where)
        elif name == "scale":
            check_guide(item, where, SCALE, hidable=False)
        elif name == "axis":
            check_guide(item, where, AXIS)
        elif name == "legend":
            check_guide(item, where, LEGEND)
        elif name == "sort":
            check_sort(item, where)
        else:
            check_stack(item, where)


def check_encoding(value, path):
    properties(value, path, CHANNELS)
    for channel, definition in value.items():
        where = f"{path}.{channel}"
        if channel == "tooltip" and isinstance(definition, list):
            for index, item in enumerate(definition):
                check_definition(item, f"{where}[{index}]")
        else:
            check_definition(definition, where)


def check_spec_part(spec, path, allowed):
    """The keys a spec or a layer shares: mark, encoding, title and description."""
    properties(spec, path, allowed)
    prefix = f"{path}." if path else ""
    if "mark" in spec:
        check_mark(spec["mark"], f"{prefix}mark")
    if "encoding" in spec:
        check_encoding(spec["encoding"], f"{prefix}encoding")
    if "title" in spec:
        check_title(spec["title"], f"{prefix}title")
    if "description" in spec:
        text(spec["description"], f"{prefix}description")


def check_spec(spec):
    check_spec_part(spec, "", TOP_LEVEL)
    schema = spec.get("$schema")
    if "$schema" in spec and not (isinstance(schema, str) and SCHEMA.fullmatch(schema)):
        raise Invalid("$schema must be a Vega-Lite 6 schema URL (v6.json or v6.x.y.json)")
    if "data" in spec and spec["data"] != DATA:
        raise Invalid('data must be {"name": "data"}: Duckpad supplies the rows of the output')
    for name in ("width", "height"):
        if name in spec:
            check_size(spec[name], name)
    layers = spec.get("layer", [])
    if not isinstance(layers, list) or not all(isinstance(layer, dict) for layer in layers):
        raise Invalid("layer must be a list of objects")
    for index, layer in enumerate(layers):
        check_spec_part(layer, f"layer[{index}]", LAYER)
        if "mark" not in layer:
            raise Invalid(f"layer[{index}] needs a mark")
    # Vega-Lite would refuse it when drawing, quoting the whole spec with its rows.
    if "mark" not in spec and "layer" not in spec:
        raise Invalid("a chart needs a mark or a layer")


def check_chart(key, chart):
    """Problems of one chart's spec; Duckpad metadata stays beside the spec, never inside it."""
    name = chart["name"]
    spec = chart.get("spec")
    if not isinstance(spec, dict):
        raise Problem(f"{FILE}: chart {name} of {key} needs a Vega-Lite spec object", 422)
    size = len(json.dumps(spec, ensure_ascii=False, separators=(",", ":")).encode())
    if size > MAX_SPEC_BYTES:
        raise Problem(f"{FILE}: chart {name} of {key} has a spec larger than 64 KiB", 422)
    try:
        check_spec(spec)
    except Invalid as error:
        raise Problem(f"{FILE}: chart {name} of {key}: {error}", 422) from None


def unknown_fields(spec, columns):
    """The fields a valid spec encodes that `columns` lack, in order and without duplicates.

    Mirrors the Chart tab's unknownFields: reads the top level and the layers; a tooltip may list
    several definitions.
    """
    fields = [
        definition.get("field")
        for part in [spec, *spec.get("layer", [])]
        for channel in part.get("encoding", {}).values()
        for definition in (channel if isinstance(channel, list) else [channel])
    ]
    return list(dict.fromkeys(field for field in fields if field is not None and field not in columns))


def declarations(bundle):
    """The charts of a bundle by output key, or a Problem describing why charts.json is invalid."""
    return named_documents.declarations(DOCUMENT, bundle.get("charts"), FIELDS, check_chart, "chart")


def problems(bundle):
    return DOCUMENT.problems(declarations, bundle)
