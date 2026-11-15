"""Runs that keep valid results compute only the nodes that changed or were requested."""

from collections import Counter

import pytest
from fastapi.testclient import TestClient
from helpers import example_bundle, wait_run
from test_computed_variables import bundle as control_bundle
from test_partitions import bundle as partitioned_bundle

from duckpad.app import create_app
from duckpad.bundle import bundle_to_files
from duckpad.util import Problem


def change(projects, worktree, update):
    snapshot = projects.snapshot(worktree)
    update(snapshot["bundle"])
    projects.write(worktree, snapshot["revision"], bundle_to_files(snapshot["bundle"]))


def launch(services, worktree, node=None, **options):
    store, _, _, engine = services
    return wait_run(store, engine.launch(worktree, "dev", node, **options))


def computed(run):
    """The nodes a run computed itself."""
    return {key for key, state in run["nodes"].items() if "kept" not in state}


def generations(engine, worktree):
    return {node: outputs["result"].id for node, outputs in engine.context(worktree, "dev").outputs.items()}


@pytest.fixture
def flow(services, tmp_path):
    """A source, a filter and a total that ran once; the source file changed since."""
    _, projects, _, engine = services
    source = tmp_path / "input.csv"
    worktree = projects.create("Test", example_bundle(source))["id"]
    first = launch(services, worktree)
    assert first["status"] == "success", first
    source.write_text("id,region,amount\n1,North,40\n")
    return worktree, first, generations(engine, worktree)


def test_a_run_keeps_valid_results_and_computes_what_changed(services, flow):
    _, projects, _, engine = services
    worktree, first, before = flow
    change(projects, worktree, lambda bundle: bundle["flow"]["nodes"][2].update(params={}, label="Totals"))
    change(
        projects,
        worktree,
        lambda bundle: bundle["templates"].update(
            total=bundle["templates"]["total"].replace("SUM(amount)", "MAX(amount)")
        ),
    )
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "success", run
    assert run["reuse"] is True and run["kept_results"] == 2
    assert computed(run) == {"total"}
    for node in ("source", "filter"):
        state = run["nodes"][node]
        assert state["status"] == "success"
        assert state["kept"]["run"] == first["id"]
        assert state["outputs"]["result"]["id"] == before[node]
        assert "started" not in state and "duration" not in state
    after = generations(engine, worktree)
    assert {node: after[node] for node in ("source", "filter")} == {
        node: before[node] for node in ("source", "filter")
    }
    assert after["total"] != before["total"]
    # The source file changed, but its loaded rows were kept: the total reads the first load.
    assert engine.preview(worktree, "dev", "total")["rows"][0]["values"] == ["North", 20, 2]
    statuses = engine.statuses(worktree, "dev")["nodes"]
    assert statuses["source"]["result_run"] == first["id"]
    assert statuses["total"]["result_run"] == run["id"]
    assert all(statuses[node]["outputs"]["result"]["status"] == "valid" for node in statuses)


def test_a_run_without_changes_computes_nothing(services, flow):
    _, _, _, engine = services
    worktree, _, before = flow
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "success", run
    assert computed(run) == set()
    assert generations(engine, worktree) == before


def test_runs_compute_everything_unless_asked_to_keep_results(services, flow):
    _, _, _, engine = services
    worktree, _, before = flow
    run = launch(services, worktree)
    assert "reuse" not in run
    assert computed(run) == {"source", "filter", "total"}
    assert not set(generations(engine, worktree).values()) & set(before.values())
    assert engine.preview(worktree, "dev", "total")["rows"][0]["values"] == ["North", 40, 1]


def test_a_requested_node_always_runs_from_the_kept_results_of_its_ancestors(services, flow):
    _, _, _, engine = services
    worktree, _, before = flow
    run = launch(services, worktree, "filter", reuse=True)
    assert run["status"] == "success", run
    assert computed(run) == {"filter"}
    after = generations(engine, worktree)
    assert after["source"] == before["source"] and after["filter"] != before["filter"]
    # What reads the new result is stale until it runs, and only that runs then.
    assert engine.preview(worktree, "dev", "total")["status"] == "stale"
    assert computed(launch(services, worktree, reuse=True)) == {"total"}


def test_running_a_source_reads_it_again_and_the_next_run_follows(services, flow):
    _, _, _, engine = services
    worktree, _, _ = flow
    assert computed(launch(services, worktree, "source", reuse=True)) == {"source"}
    statuses = engine.statuses(worktree, "dev")["nodes"]
    assert [statuses[node]["outputs"]["result"]["status"] for node in ("source", "filter", "total")] == [
        "valid",
        "stale",
        "stale",
    ]
    assert computed(launch(services, worktree, reuse=True)) == {"filter", "total"}
    assert engine.preview(worktree, "dev", "total")["rows"][0]["values"] == ["North", 40, 1]


def test_the_ancestors_of_a_node_run_only_when_their_result_is_missing_or_stale(services, flow):
    _, projects, _, _ = services
    worktree, _, _ = flow
    assert computed(launch(services, worktree, "total", ancestors=True, reuse=True)) == set()
    change(projects, worktree, lambda bundle: bundle["flow"]["nodes"][1].update(params={"threshold": 15}))
    run = launch(services, worktree, "total", ancestors=True, reuse=True)
    assert set(run["nodes"]) == {"source", "filter"}
    assert computed(run) == {"filter"}


def test_a_failed_node_runs_again_and_its_previous_result_is_not_kept(services, flow):
    _, projects, _, engine = services
    worktree, _, _ = flow
    change(
        projects,
        worktree,
        lambda bundle: bundle["templates"].update(
            filter=bundle["templates"]["filter"].replace("amount >", "missing >")
        ),
    )
    failed = launch(services, worktree, reuse=True)
    assert failed["status"] == "partial_failure"
    assert computed(failed) == {"filter", "total"}
    assert failed["nodes"]["total"]["status"] == "blocked"
    change(
        projects,
        worktree,
        lambda bundle: bundle["templates"].update(
            filter=bundle["templates"]["filter"].replace("missing >", "amount >")
        ),
    )
    # The definitions are those of the first run again, but its results turned stale meanwhile.
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "success", run
    assert computed(run) == {"filter", "total"}
    assert engine.preview(worktree, "dev", "total")["rows"][0]["values"] == ["North", 30, 2]


def test_nodes_that_write_outside_duckpad_always_run(services, tmp_path):
    _, projects, _, _ = services
    bundle = example_bundle(tmp_path / "input.csv")
    destination = tmp_path / "totals.csv"
    bundle["templates"]["export"] = (
        f"-- @input source\nCOPY (SELECT * FROM {{{{ source }}}}) TO '{destination}' (FORMAT csv);"
    )
    bundle["flow"]["nodes"].append({"id": "export", "template": "export", "params": {}})
    bundle["flow"]["edges"].append(
        {"id": "c", "source": "total", "sourceHandle": "result", "target": "export", "targetHandle": "source"}
    )
    worktree = projects.create("Test", bundle)["id"]
    assert launch(services, worktree)["status"] == "success"
    destination.unlink()
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "success", run
    assert computed(run) == {"export"}
    assert destination.exists()


def test_a_value_calculated_again_runs_the_nodes_that_use_it(services):
    _, projects, _, engine = services
    worktree = projects.create("Values", control_bundle())["id"]
    assert launch(services, worktree)["status"] == "success"
    run = launch(services, worktree, reuse=True)
    assert computed(run) == set()
    assert run["variables"]["amount"]["value"] == 4
    change(
        projects,
        worktree,
        lambda bundle: bundle["templates"].update(
            control="-- @output result\nSELECT 7 AS amount, '2026-06-30' AS day;"
        ),
    )
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "success", run
    # The consumer was planned as kept: the new value changed its definition during the run.
    assert computed(run) == {"control", "consumer"}
    assert "kept" in run["nodes"]["independent"] and run["kept_results"] == 1
    assert engine.preview(worktree, "dev", "consumer")["rows"][0]["values"] == [7]
    assert engine.preview(worktree, "dev", "consumer")["status"] == "valid"


def test_the_api_keeps_valid_results_on_request_through_components_and_values(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    store = app.state.services.store
    with TestClient(app) as client:
        client.post("/api/login", json={"username": "admin", "password": app.state.auth.initial_password})
        example = client.post("/api/example", json={}).json()
        path = f"/api/worktrees/{example['id']}/runs"

        def run(**options):
            response = client.post(path, json={"environment": "dev", **options})
            assert response.status_code == 200, response.text
            return wait_run(store, response.json(), timeout=120)

        first = run()
        assert first["status"] == "success", first
        assert computed(first) == set(first["nodes"])
        second = run(reuse=True)
        assert second["status"] == "success", second
        exports = {key for key, state in second["nodes"].items() if state["writes_external"]}
        assert exports and computed(second) == exports
        assert second["kept_results"] == len(second["nodes"]) - len(exports)
        # A requested component runs its nodes from the kept results of its ancestors.
        third = run(node="report", reuse=True)
        assert third["status"] == "success", third
        inner = {key for key in third["nodes"] if key.startswith("report::")}
        assert inner and computed(third) == inner
        assert client.post(path, json={"environment": "dev", "reuse": "yes"}).status_code == 422


def test_a_canceled_run_leaves_the_results_it_kept_valid(services, flow, monkeypatch):
    _, projects, _, engine = services
    worktree, _, before = flow
    change(
        projects,
        worktree,
        lambda bundle: bundle["templates"].update(
            total=bundle["templates"]["total"].replace("SUM(amount)", "MAX(amount)")
        ),
    )
    compute = engine.runs.nodes.compute

    def cancel_first(execution, key, created):
        engine.cancel(execution.run["id"])
        return compute(execution, key, created)

    monkeypatch.setattr(engine.runs.nodes, "compute", cancel_first)
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "canceled"
    assert run["nodes"]["total"]["status"] == "canceled"
    assert computed(run) == {"total"} and run["kept_results"] == 2
    statuses = engine.statuses(worktree, "dev")["nodes"]
    assert [statuses[node]["outputs"]["result"]["status"] for node in ("source", "filter", "total")] == [
        "valid",
        "valid",
        "stale",
    ]
    assert generations(engine, worktree) == before
    monkeypatch.undo()
    assert computed(launch(services, worktree, reuse=True)) == {"total"}


@pytest.fixture
def partitioned(services, monkeypatch):
    """A flow whose keys ran once, counting what runs afterwards by node and key."""
    _, projects, _, engine = services
    project = partitioned_bundle()
    project["flow"]["partitions"]["batch"]["execution"] = {"on_error": "continue"}
    worktree = projects.create("Partitions", project)["id"]
    calls = Counter()
    compute = engine.runs.nodes.compute

    def counted(execution, key, tables):
        calls[key, (execution.partition or {}).get("key", {}).get("value")] += 1
        return compute(execution, key, tables)

    monkeypatch.setattr(engine.runs.nodes, "compute", counted)
    first = launch(services, worktree)
    assert first["status"] == "success", first
    assert computed(first) == {"keys", "source", "lookup", "transform", "collect"}
    calls.clear()
    return worktree, calls


def test_a_partitioned_flow_keeps_valid_keys_and_what_collects_them(services, partitioned):
    _, _, _, engine = services
    worktree, calls = partitioned
    collected = engine.preview(worktree, "dev", "collect")["id"]
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "success", run
    assert not calls and computed(run) == set()
    assert run["kept_results"] == 5 and run["partitions"]["selected"] == 0
    assert run["nodes"]["transform"]["kept"] == {"partitions": 2}
    assert engine.preview(worktree, "dev", "collect")["id"] == collected
    # Every key runs again on request, from the kept results of the other nodes.
    run = launch(services, worktree, reuse=True, partition_selection={"mode": "all"})
    assert computed(run) == {"source", "transform", "collect"}
    assert calls == Counter({(node, key): 1 for node in ("source", "transform") for key in "ab"}) + Counter(
        {("collect", None): 1}
    )


def test_changed_keys_run_with_what_collects_them(services, partitioned):
    _, projects, _, engine = services
    worktree, calls = partitioned
    change(
        projects, worktree, lambda bundle: bundle["flow"]["nodes"][3].update(params={"value": "'changed'"})
    )
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "success", run
    assert computed(run) == {"source", "transform", "collect"}
    assert run["partitions"]["selected"] == 2 and calls["transform", "a"] == calls["transform", "b"] == 1
    assert {row["values"][1] for row in engine.preview(worktree, "dev", "collect")["rows"]} == {"changed"}
    # A new key runs alone; the other keys are kept, and what collects them all runs again.
    calls.clear()
    change(
        projects,
        worktree,
        lambda bundle: bundle["templates"].update(
            keys=bundle["templates"]["keys"].replace(";", " UNION ALL SELECT 'c', 'three';")
        ),
    )
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "success", run
    assert computed(run) == {"keys", "source", "transform", "collect"}
    assert run["partitions"]["total"] == 3 and run["partitions"]["selected"] == 1
    assert {key for (node, key) in calls if node == "transform"} == {"c"}


def test_only_the_keys_that_failed_run_again(services, partitioned, monkeypatch):
    _, projects, _, engine = services
    worktree, calls = partitioned
    counted = engine.runs.nodes.compute

    def failing(execution, key, tables):
        if key == "transform" and execution.partition["key"]["value"] == "b":
            raise Problem("Temporary failure")
        return counted(execution, key, tables)

    change(
        projects, worktree, lambda bundle: bundle["flow"]["nodes"][3].update(params={"value": "'changed'"})
    )
    with monkeypatch.context() as patch:
        patch.setattr(engine.runs.nodes, "compute", failing)
        failed = launch(services, worktree, reuse=True)
    assert failed["status"] == "partial_failure", failed
    assert failed["nodes"]["collect"]["status"] == "blocked"
    calls.clear()
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "success", run
    assert computed(run) == {"source", "transform", "collect"}
    assert run["partitions"]["selected"] == 1
    assert calls == Counter({("source", "b"): 1, ("transform", "b"): 1, ("collect", None): 1})


def test_keys_follow_an_input_that_ran_again_and_a_requested_partitioned_node(services, partitioned):
    worktree, calls = partitioned
    assert computed(launch(services, worktree, "lookup", reuse=True)) == {"lookup"}
    calls.clear()
    # The keys were computed from the previous result of the input: they all run again.
    run = launch(services, worktree, reuse=True)
    assert run["status"] == "success", run
    assert computed(run) == {"source", "transform", "collect"}
    assert run["partitions"]["selected"] == 2 and calls["transform", "a"] == calls["transform", "b"] == 1
    assert computed(launch(services, worktree, reuse=True)) == set()
    # A requested partitioned node runs every key, from the kept result of its other input.
    calls.clear()
    run = launch(services, worktree, "transform", reuse=True)
    assert computed(run) == {"source", "transform"}
    assert calls["transform", "a"] == calls["transform", "b"] == 1 and not calls["lookup", None]
    # What collects the keys turned stale, and runs alone next.
    calls.clear()
    assert computed(launch(services, worktree, reuse=True)) == {"collect"}
    assert calls == Counter({("collect", None): 1})
