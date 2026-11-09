import copy

from helpers import example_bundle, wait_run


def test_reruns_capture_durable_timings_for_only_their_scope(services, tmp_path):
    store, projects, _, engine = services
    tree = projects.create("Timing", example_bundle(tmp_path / "input.csv"))["id"]
    first = wait_run(store, engine.launch(tree, "dev"))
    assert first["status"] == "success"
    assert all("estimated_duration" not in state for state in first["nodes"].values())
    second = wait_run(store, engine.launch(tree, "dev", "source"))
    assert set(second["nodes"]) == {"source"}
    assert second["nodes"]["source"]["estimated_duration"] == first["nodes"]["source"]["duration"]
    # Estimates are part of the durable snapshot returned by both workspace and Job APIs.
    assert store.get("run", second["id"])["nodes"] == second["nodes"]
    assert store.node_duration_estimates(tree, "prod") == {}
    other = projects.create("Other", example_bundle(tmp_path / "other.csv"))["id"]
    assert store.node_duration_estimates(other, "dev") == {}


def test_estimates_skip_unusable_recent_samples(services, tmp_path):
    store, projects, _, engine = services
    tree = projects.create("Timing", example_bundle(tmp_path / "input.csv"))["id"]
    first = wait_run(store, engine.launch(tree, "dev", "source"))
    unusable = [
        {"status": "failed", "duration": 100},
        {"status": "canceled", "duration": 100},
        {"status": "success", "duration": 100, "partitioned": True},
        {"status": "success", "duration": 0},
        {"status": "success", "duration": -1},
        {"status": "success", "duration": "unknown"},
        {"status": "success"},
    ]
    for index, state in enumerate(unusable):
        newer = copy.deepcopy(first)
        newer.update(id=f"newer-{index}", started=f"2099-01-01T00:00:0{index}+00:00", nodes={"source": state})
        store.put("run", newer["id"], newer)
    assert store.node_duration_estimates(tree, "dev") == {"source": first["nodes"]["source"]["duration"]}
