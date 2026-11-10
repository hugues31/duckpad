"""Charts in charts.json: a registered project file, saved, archived, merged, compared and checked on save."""

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient
from helpers import example_bundle

from duckpad import charts
from duckpad.app import create_app
from duckpad.bundle import bundle_to_files
from duckpad.comparison import commit_message, compare_files
from duckpad.merge import merge_files
from duckpad.util import Problem
from duckpad.validation import validate

BARS = {
    "name": "Amount by channel",
    "spec": {
        "mark": "bar",
        "encoding": {
            "x": {"field": "channel", "type": "nominal"},
            "y": {"field": "amount", "type": "quantitative"},
        },
    },
}

LINES = {"name": "Amount over time", "spec": {"mark": "line"}}


def project(tmp_path, charts=None):
    bundle = example_bundle(tmp_path / "input.csv")
    if charts is not None:
        bundle["charts"] = charts
    return bundle


def problems(bundle):
    return [item["message"] for item in validate(bundle) if item["file"] == "charts.json"]


def test_charts_are_saved_and_committed_as_display_changes(services, tmp_path):
    _, projects, _, _ = services
    worktree = projects.create("Charts", project(tmp_path))["id"]
    snapshot = projects.snapshot(worktree)
    assert snapshot["bundle"]["charts"] is None
    snapshot["bundle"]["charts"] = {"filter:result": [BARS]}
    saved = projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))
    assert json.loads(saved["files"]["charts.json"]) == {"filter:result": [BARS]}
    assert saved["bundle"]["charts"] == {"filter:result": [BARS]}
    assert not saved["diagnostics"]
    message = projects.versioning.history(worktree, limit=1)["items"][0]["message"]
    assert message.startswith("docs(chart): add Amount by channel chart of filter:result")


def test_charts_of_nested_nodes_are_valid(tmp_path):
    assert not problems(project(tmp_path, {"report::rank:result": [BARS], "filter:result": []}))


@pytest.mark.parametrize(
    ("charts", "message"),
    [
        ([], "object of charts"),
        ("{", "not valid JSON"),
        ({"filter": [BARS]}, "node:port"),
        ({"filter:result": {}}, "must be a list"),
        ({"filter:result": ["x"]}, "must be an object"),
        ({"filter:result": [{"spec": BARS["spec"]}]}, "needs a name"),
        ({"filter:result": [{**BARS, "name": "x" * 101}]}, "needs a name"),
        ({"filter:result": [{**BARS, "color": "red"}]}, "unknown fields: color"),
        ({"filter:result": [{"name": "Bars"}]}, "needs a Vega-Lite spec"),
        ({"filter:result": [{"name": "Bars", "spec": "bar"}]}, "needs a Vega-Lite spec"),
        ({"filter:result": [BARS, BARS]}, "distinct names"),
    ],
)
def test_invalid_charts_are_reported_on_the_file(tmp_path, charts, message):
    [problem] = problems(project(tmp_path, charts))
    assert message in problem


def chart(spec):
    return {"filter:result": [{"name": "Bars", "spec": spec}]}


def encoded(**definition):
    return {"mark": "bar", "encoding": {"x": {"field": "channel", "type": "nominal", **definition}}}


EXPR = {"expr": "alert(1)"}

ACCEPTED = {
    "top level": {
        "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
        "data": {"name": "data"},
        "mark": "bar",
        "encoding": BARS["spec"]["encoding"],
        "title": {"text": "Amounts", "subtitle": "By channel"},
        "description": "Amount per sales channel",
        "width": "container",
        "height": 240,
    },
    "patch schema and no data": {
        "$schema": "https://vega.github.io/schema/vega-lite/v6.4.1.json",
        "mark": "line",
    },
    "string title": {"mark": "point", "title": "Amounts"},
    "layers": {
        "layer": [
            {"mark": "bar", "encoding": BARS["spec"]["encoding"], "title": "Bars", "description": "Bars"},
            {"mark": {"type": "rule", "color": "red"}, "encoding": {"y": {"value": 300}}},
        ]
    },
    "every mark": {"layer": [{"mark": mark} for mark in charts.MARKS]},
    "mark styles": {
        "mark": {
            "type": "line",
            "color": "#336699",
            "opacity": 0.8,
            "filled": False,
            "size": 3,
            "strokeWidth": 2,
            "interpolate": "monotone",
            "point": True,
            "orient": "vertical",
            "tooltip": True,
            "innerRadius": 10,
            "outerRadius": 50,
            "cornerRadius": None,
        }
    },
    "every channel": {"mark": "point", "encoding": {name: {"field": "amount"} for name in charts.CHANNELS}},
    "tooltip list": {"mark": "bar", "encoding": {"tooltip": [{"field": "channel"}, {"field": "amount"}]}},
    "channel definition": encoded(
        title="Channel",
        format=",.2f",
        formatType="number",
        scale={
            "type": "linear",
            "domain": [0, None],
            "range": ["red", "blue"],
            "scheme": "blues",
            "zero": True,
            "nice": True,
            "reverse": False,
        },
        axis={
            "title": None,
            "format": "%Y",
            "formatType": "time",
            "labelAngle": -45,
            "grid": False,
            "orient": "top",
            "tickCount": 5,
        },
        legend={"title": "Channel", "format": "%d %b", "formatType": "time", "orient": "bottom"},
        stack="zero",
    ),
    "hidden axis and legend": encoded(axis=None, legend=None),
    "literal values": {"mark": "rule", "encoding": {"y": {"value": None}, "color": {"value": "red"}}},
    "sort by channel": encoded(sort="-y"),
    "sort by order": encoded(sort="descending"),
    "sort by null": encoded(sort=None),
    "sort by values": encoded(sort=["Web", "Partner", None]),
    "sort by encoding": encoded(sort={"encoding": "y", "order": "descending"}),
    "stacks": {
        "mark": "area",
        "encoding": {"x": {"stack": None}, "y": {"stack": "center"}},
    },
}


@pytest.mark.parametrize("spec", ACCEPTED.values(), ids=ACCEPTED.keys())
def test_allowlisted_specs_are_valid(tmp_path, spec):
    assert not problems(project(tmp_path, chart(spec)))


REJECTED = {
    "unknown top-level key": ({"mark": "bar", "params": []}, "params is not allowed"),
    "named data": ({"mark": "bar", "data": {"name": "orders"}}, 'data must be {"name": "data"}'),
    "inline data": ({"mark": "bar", "data": {"values": [{"a": 1}]}}, 'data must be {"name": "data"}'),
    "datasets": ({"mark": "bar", "datasets": {"a": []}}, "datasets is not allowed"),
    "transform": ({"mark": "bar", "transform": [{"filter": "true"}]}, "transform is not allowed"),
    "config": ({"mark": "bar", "config": {}}, "config is not allowed"),
    "facet": ({"facet": {"row": {"field": "a"}}, "spec": {"mark": "bar"}}, "facet is not allowed"),
    "repeat": ({"repeat": ["a"], "spec": {"mark": "bar"}}, "repeat is not allowed"),
    "concat": ({"concat": [{"mark": "bar"}]}, "concat is not allowed"),
    "hconcat": ({"hconcat": [{"mark": "bar"}]}, "hconcat is not allowed"),
    "vconcat": ({"vconcat": [{"mark": "bar"}]}, "vconcat is not allowed"),
    "sub-spec data": (
        {"layer": [{"mark": "bar", "data": {"sequence": {"start": 0, "stop": 9}}}]},
        "layer[0].data is not allowed",
    ),
    "nested layer": ({"layer": [{"layer": []}]}, "layer[0].layer is not allowed"),
    "no mark": ({"encoding": BARS["spec"]["encoding"]}, "a chart needs a mark or a layer"),
    "layer without mark": ({"layer": [{"mark": "bar"}, {"encoding": {}}]}, "layer[1] needs a mark"),
    "layer list": ({"layer": {"mark": "bar"}}, "layer must be a list of objects"),
    "boxplot": ({"mark": "boxplot"}, "mark boxplot is not allowed"),
    "errorbar": ({"mark": {"type": "errorbar"}}, "mark errorbar is not allowed"),
    "errorband": ({"layer": [{"mark": "errorband"}]}, "mark errorband is not allowed"),
    "unknown mark": ({"mark": "geoshape"}, "mark geoshape is not allowed"),
    "mark list": ({"mark": ["bar"]}, "mark must be a mark type or an object with a type"),
    "unknown mark style": ({"mark": {"type": "bar", "href": "x"}}, "mark.href is not allowed"),
    "href channel": ({"mark": "bar", "encoding": {"href": {"field": "url"}}}, "encoding.href is not allowed"),
    "url channel": ({"mark": "point", "encoding": {"url": {"field": "u"}}}, "encoding.url is not allowed"),
    "datum": (encoded(datum=1), "encoding.x.datum is not allowed"),
    "condition": (encoded(condition={"test": "true", "value": 1}), "encoding.x.condition is not allowed"),
    "aggregate": (encoded(aggregate="sum"), "encoding.x.aggregate is not allowed"),
    "bin": (encoded(bin=True), "encoding.x.bin is not allowed"),
    "timeUnit": (encoded(timeUnit="month"), "encoding.x.timeUnit is not allowed"),
    "impute": (encoded(impute={"value": 0}), "encoding.x.impute is not allowed"),
    "sort op": (encoded(sort={"field": "amount", "op": "sum"}), "encoding.x.sort"),
    "sort encoding op": (encoded(sort={"encoding": "y", "op": "sum"}), "encoding.x.sort"),
    "sort unknown channel": (encoded(sort="-href"), "encoding.x.sort"),
    "stack normalize": (encoded(stack="normalize"), "encoding.x.stack"),
    "stack number": (encoded(stack=1), "encoding.x.stack"),
    "axis labelExpr": (
        encoded(axis={"labelExpr": "datum.label"}),
        "encoding.x.axis.labelExpr is not allowed",
    ),
    "scale expr": (encoded(scale={"domain": EXPR}), "encoding.x.scale.domain must be a list of literals"),
    "axis expr property": (encoded(axis={"expr": "1"}), "encoding.x.axis.expr is not allowed"),
    "channel formatType": (
        encoded(formatType="myFormat"),
        "encoding.x.formatType must be number or time",
    ),
    "utc formatType": (encoded(formatType="utc"), "encoding.x.formatType must be number or time"),
    # Vega-Lite writes number formats into an expression string without escaping them.
    "format closing its string": (
        encoded(format='d") + warn(sequence(0, 5)) + ("'),
        "encoding.x.format must be a string without quotes or backslashes",
    ),
    "format ending with a backslash": (
        {"mark": "text", "encoding": {"tooltip": [{"field": "a", "format": "d\\"}, {"field": "b"}]}},
        "encoding.tooltip[0].format must be a string without quotes or backslashes",
    ),
    "axis format quote": (encoded(axis={"format": "'"}), "encoding.x.axis.format must be a string without"),
    "legend format quote": (
        encoded(legend={"format": '"'}),
        "encoding.x.legend.format must be a string without",
    ),
    "format number": (encoded(format=1), "encoding.x.format must be a string"),
    "axis formatType": (encoded(axis={"formatType": "custom"}), "encoding.x.axis.formatType must be"),
    "legend formatType": (encoded(legend={"formatType": None}), "encoding.x.legend.formatType must be"),
    "schema v5": (
        {"$schema": "https://vega.github.io/schema/vega-lite/v5.json"},
        "$schema must be a Vega-Lite 6",
    ),
    "schema other host": ({"$schema": "https://example.com/schema/vega-lite/v6.json"}, "$schema must be"),
    "unknown type": (encoded(type="geojson"), "encoding.x.type must be"),
    "field object": (encoded(field={"repeat": "row"}), "encoding.x.field must be a string"),
    "width": ({"mark": "bar", "width": -1}, 'width must be a positive number or "container"'),
    "height": ({"mark": "bar", "height": True}, "height must be"),
    "title object": ({"mark": "bar", "title": {"text": "a", "color": "red"}}, "title.color is not allowed"),
    "description": ({"mark": "bar", "description": 1}, "description must be a string"),
    "encoding list": ({"mark": "bar", "encoding": []}, "encoding must be an object"),
    "definition list": ({"mark": "bar", "encoding": {"x": []}}, "encoding.x must be an object"),
}

# The central safety property: no object, such as an expression, where a literal is expected.
OBJECTS = {
    "mark color": {"mark": {"type": "bar", "color": EXPR}},
    "mark tooltip": {"mark": {"type": "bar", "tooltip": {"content": "data"}}},
    "mark opacity list": {"mark": {"type": "bar", "opacity": [1]}},
    "value": encoded(value=EXPR),
    "domain item": encoded(scale={"domain": [0, EXPR]}),
    "range": encoded(scale={"range": EXPR}),
    "range item": encoded(scale={"range": [["red"]]}),
    "scheme": encoded(scale={"scheme": {"name": "blues", "extent": EXPR}}),
    "axis title": encoded(axis={"title": EXPR}),
    "tickCount": encoded(axis={"tickCount": {"interval": "month"}}),
    "sort value": encoded(sort=["Web", EXPR]),
    "channel title": encoded(title=EXPR),
}
REJECTED |= {f"{name} object": (spec, "must be") for name, spec in OBJECTS.items()}


@pytest.mark.parametrize(("spec", "message"), REJECTED.values(), ids=REJECTED.keys())
def test_constructs_outside_the_allowlist_are_diagnosed(tmp_path, spec, message):
    [problem] = problems(project(tmp_path, chart(spec)))
    assert problem.startswith("charts.json: chart Bars of filter:result: ")
    assert message in problem


def test_oversized_specs_are_diagnosed(tmp_path):
    spec = {"mark": "bar", "description": "x" * (64 * 1024)}
    [problem] = problems(project(tmp_path, chart(spec)))
    assert "larger than 64 KiB" in problem


@pytest.mark.parametrize(
    "invalid",
    [
        {"filter:result": [{**BARS, "color": "red"}]},
        chart(encoded(value=EXPR)),
        chart({"mark": "bar", "description": "x" * (64 * 1024)}),
        {"filter:result": [{**BARS, "name": "x" * 101}]},
        {"filter:result": [BARS, BARS]},
    ],
    ids=["unknown field", "expression", "oversized", "overlong name", "duplicate names"],
)
def test_invalid_charts_are_saved_and_diagnosed(services, tmp_path, invalid):
    _, projects, _, _ = services
    worktree = projects.create("Charts", project(tmp_path))
    snapshot = projects.snapshot(worktree["id"])
    files = {**bundle_to_files(snapshot["bundle"]), "charts.json": json.dumps(invalid)}
    saved = projects.write(worktree["id"], snapshot["revision"], files)
    assert saved["bundle"]["charts"] == invalid
    assert json.loads(saved["files"]["charts.json"]) == invalid
    assert [d["file"] for d in saved["diagnostics"]] == ["charts.json"]


def test_charts_travel_in_project_archives(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert (
            client.post(
                "/api/login", json={"username": "admin", "password": app.state.auth.initial_password}
            ).status_code
            == 200
        )
        worktree = client.post("/api/projects", json={"name": "Charts"}).json()
        snapshot = client.get(f"/api/worktrees/{worktree['id']}").json()
        bundle = {**snapshot["bundle"], "charts": {"orders:result": [BARS]}}
        saved = client.put(
            f"/api/worktrees/{worktree['id']}", json={"revision": snapshot["revision"], "bundle": bundle}
        )
        assert saved.status_code == 200, saved.text
        archive = client.get(f"/api/worktrees/{worktree['id']}/archive.zip")
        with zipfile.ZipFile(io.BytesIO(archive.content)) as content:
            assert json.loads(content.read("charts.json")) == {"orders:result": [BARS]}
        imported = client.post(
            "/api/projects/import", files={"file": ("project.zip", archive.content, "application/zip")}
        )
        assert imported.status_code == 200, imported.text
        copy_id = imported.json()["id"]
        assert client.get(f"/api/worktrees/{copy_id}").json()["bundle"]["charts"] == {"orders:result": [BARS]}


def with_charts(files, charts):
    return {**files, "charts.json": json.dumps(charts)}


def test_charts_merge_by_output_then_by_name(tmp_path):
    base = with_charts(bundle_to_files(project(tmp_path)), {"filter:result": [BARS]})
    current = with_charts(base, {"filter:result": [BARS, LINES]})
    proposal = with_charts(base, {"filter:result": [BARS, {**LINES, "name": "Amount per day"}]})
    merged, conflicts = merge_files(base, current, proposal)
    assert conflicts == []
    assert json.loads(merged["charts.json"]) == {
        "filter:result": [BARS, LINES, {**LINES, "name": "Amount per day"}]
    }
    # The first charts of an output, added on both branches, survive too.
    merged, conflicts = merge_files(
        base,
        with_charts(base, {"filter:result": [BARS], "total:result": [LINES]}),
        with_charts(base, {"filter:result": [BARS], "total:result": [BARS]}),
    )
    assert conflicts == []
    assert json.loads(merged["charts.json"]) == {"filter:result": [BARS], "total:result": [LINES, BARS]}


def test_branches_that_both_create_charts_json_merge(tmp_path):
    empty = bundle_to_files(project(tmp_path))
    first = with_charts(empty, {"filter:result": [BARS]})
    second = with_charts(empty, {"filter:result": [LINES], "total:result": [BARS]})
    merged, conflicts = merge_files(empty, first, second)
    assert conflicts == []
    assert json.loads(merged["charts.json"]) == {"filter:result": [BARS, LINES], "total:result": [BARS]}


def edit(chart, **encoding):
    spec = chart["spec"]
    return {**chart, "spec": {**spec, "encoding": {**spec["encoding"], **encoding}}}


@pytest.mark.parametrize(
    "saved",
    [
        # Different fields of one spec: a field-level merge would combine them into a meaningless chart.
        [edit(BARS, color={"field": "channel", "type": "nominal"})],
        # Deleted on one side, changed on the other.
        [],
    ],
)
def test_a_chart_conflicts_and_resolves_as_one_unit(services, tmp_path, saved):
    _, projects, _, _ = services
    tree = projects.create("Charts", project(tmp_path, {"filter:result": [BARS, LINES]}))["id"]
    base = projects.snapshot(tree)
    projects.write(tree, base["revision"], with_charts(base["files"], {"filter:result": [*saved, LINES]}))
    incoming = edit(BARS, y={"field": "amount", "type": "quantitative", "aggregate": "sum"})
    with pytest.raises(Problem, match="Concurrent edits"):
        projects.write(
            tree, base["revision"], with_charts(base["files"], {"filter:result": [incoming, LINES]})
        )
    review = projects.snapshot(tree)["conflicts"][0]
    [field] = review["fields"]
    assert field["path"] == "charts.json/filter:result/Amount by channel"
    assert field["current"] == {"present": bool(saved), "value": saved[0] if saved else None}
    assert field["incoming"] == {"present": True, "value": incoming}
    # The conflict dialog submits the merge with the incoming chart chosen as a whole.
    resolved = projects.resolve(review["id"], "combined", review["merged"])
    assert json.loads(resolved["files"]["charts.json"])["filter:result"] == (
        [incoming, LINES] if saved else [LINES, incoming]
    )
    assert not resolved["conflicts"]


def test_comparison_lists_each_chart_as_an_entity(tmp_path):
    before = with_charts(bundle_to_files(project(tmp_path)), {"report::rank:result": [BARS]})
    after = with_charts(
        before, {"report::rank:result": [{**BARS, "spec": {**BARS["spec"], "mark": "point"}}, LINES]}
    )
    report = compare_files(before, after)
    changes = {c["id"]: c for c in report["entities"] if c["status"] != "unchanged"}
    assert {
        key: {k: change[k] for k in ("kind", "name", "file", "status", "fields", "categories")}
        for key, change in changes.items()
    } == {
        "chart/report::rank:result/Amount by channel": {
            "kind": "chart",
            "name": "Amount by channel chart of report::rank:result",
            "file": "charts.json",
            "status": "modified",
            "fields": ["spec/mark"],
            "categories": ["documentation"],
        },
        "chart/report::rank:result/Amount over time": {
            "kind": "chart",
            "name": "Amount over time chart of report::rank:result",
            "file": "charts.json",
            "status": "added",
            "fields": ["value"],
            "categories": ["documentation"],
        },
    }
    assert changes["chart/report::rank:result/Amount over time"]["after"] == LINES
    assert commit_message(before, after).startswith("docs(project): update 2 elements (2 chart)")
