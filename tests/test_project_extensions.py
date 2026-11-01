"""Project requirements survive sharing and govern every execution context."""

import copy
import io
import subprocess

import pytest
from fastapi.testclient import TestClient
from helpers import wait_run

from duckpad import project_extensions
from duckpad.app import create_app
from duckpad.archive import read_archive, write_archive
from duckpad.bundle import bundle_to_files, files_to_bundle, validate
from duckpad.merge import merge_files
from duckpad.services import Services
from duckpad.util import Problem


def bundle(extensions=None):
    return {
        "flow": {"nodes": [{"id": "source", "template": "source", "params": {}}], "edges": []},
        "templates": {"source": "-- @kind source\n-- @output result\nSELECT 42 AS value;"},
        "documentation": {},
        "components": {},
        "extensions": extensions,
    }


def save(instance, identity, requirements):
    snapshot = instance.projects.snapshot(identity)
    snapshot["bundle"]["extensions"] = requirements
    return instance.projects.write(identity, snapshot["revision"], bundle_to_files(snapshot["bundle"]))


@pytest.mark.parametrize("isolated", [False, True])
def test_contexts_reopen_only_when_enabled_requirements_change(tmp_path, isolated):
    home = tmp_path / "instance"
    instance = Services.open(home, enforce_access=isolated)
    requirements = {"json": {"source": "core", "enabled": True}}
    try:
        worktree = instance.projects.create("Extensions", bundle(requirements))
        unrelated = instance.projects.create("Unrelated", bundle())
        if isolated:
            for item in (worktree, unrelated):
                instance.engine.access.grant_connections(item["project"], [])
        identity = worktree["id"]
        for item in (worktree, unrelated):
            run = wait_run(instance.store, instance.engine.launch(item["id"], "dev", entry_point="scheduler"))
            assert run["status"] == "success", run
        context = instance.engine.context(identity, "dev")
        other = instance.engine.context(unrelated["id"], "dev")
        original_fingerprint = instance.engine.fingerprints.current(identity, "dev")
        # Disabled requirements are retained, without discarding valid results or workers.
        updated = {**requirements, "unavailable": {"source": "community", "enabled": False}}
        save(instance, identity, updated)
        assert instance.engine.fingerprints.current(identity, "dev") == original_fingerprint
        run = wait_run(instance.store, instance.engine.launch(identity, "dev"))
        assert run["status"] == "success", run
        assert instance.engine.context(identity, "dev") is context
        save(instance, identity, {"json": {"source": "core", "enabled": False}})
        assert instance.engine.fingerprints.current(identity, "dev") != original_fingerprint
        run = wait_run(instance.store, instance.engine.launch(identity, "dev"))
        assert run["status"] == "success", run
        assert instance.engine.context(identity, "dev") is not context
        assert instance.engine.context(unrelated["id"], "dev") is other
        save(instance, identity, requirements)
        instance.close()
        instance = Services.open(home, enforce_access=isolated)
        run = wait_run(instance.store, instance.engine.launch(identity, "prod", entry_point="scheduler"))
        assert run["status"] == "success", run
        assert run["extensions"] == requirements
        assert run["connections"] == {}
        assert instance.engine.pool.find(identity, "prod").extensions == [{"name": "json", "source": "core"}]
        assert instance.engine.extension_settings() == {"allow_unsigned_extensions": False}
    finally:
        instance.close()


@pytest.mark.parametrize("isolated", [False, True])
def test_missing_requirement_blocks_execution_without_installing(tmp_path, isolated):
    instance = Services.open(tmp_path / "instance", enforce_access=isolated)
    try:
        worktree = instance.projects.create(
            "Missing", bundle({"missing_capability": {"source": "community", "enabled": True}})
        )
        if isolated:
            instance.engine.access.grant_connections(worktree["project"], [])
        with pytest.raises(Problem, match="Import missing_capability from community"):
            instance.engine.launch(worktree["id"], "dev")
        assert not instance.engine.active
        assert instance.engine.project_extensions(worktree["id"])["requirements"][0]["status"] == "missing"
    finally:
        instance.close()


def test_requirements_roundtrip_merge_and_invalid_files_remain_reviewable():
    requirements = {"duckfn_statrs": {"source": "community", "enabled": True}}
    original = bundle(requirements)
    files = bundle_to_files(original)
    restored = files_to_bundle(read_archive(io.BytesIO(write_archive(files))))
    assert restored["extensions"] == requirements
    assert validate(restored) == []
    old = bundle_to_files(bundle())
    other = bundle_to_files(bundle({"json": {"source": "core", "enabled": True}}))
    merged, conflicts = merge_files(old, files, other)
    assert conflicts == []
    assert files_to_bundle(merged)["extensions"] == {
        **requirements,
        "json": {"source": "core", "enabled": True},
    }
    for invalid in (
        "{broken",
        [],
        {"../outside": {"source": "core", "enabled": True}},
        {"json": {"source": [], "enabled": True}},
        {"json": {"source": "core", "enabled": "false"}},
    ):
        changed = copy.deepcopy(original)
        changed["extensions"] = invalid
        reread = files_to_bundle(bundle_to_files(changed))
        assert reread["extensions"] == invalid
        assert any(error["file"] == "extensions.json" for error in validate(reread))
        with pytest.raises(Problem):
            project_extensions.enabled(invalid)


@pytest.mark.parametrize("isolated", [False, True])
def test_editing_requirements_does_not_close_an_active_run_database(tmp_path, isolated):
    instance = Services.open(tmp_path / "instance", enforce_access=isolated)
    try:
        definitions = bundle({"json": {"source": "core", "enabled": True}})
        definitions["templates"]["source"] = (
            "-- @kind source\n-- @output result\nSELECT sum(random()) FROM range(1000000000000);"
        )
        worktree = instance.projects.create("Active extension edit", definitions)
        if isolated:
            instance.engine.access.grant_connections(worktree["project"], [])
        run = instance.engine.launch(worktree["id"], "dev")
        context = instance.engine.context(worktree["id"], "dev")
        save(instance, worktree["id"], {})
        # Status and preview readers keep the run's captured session. Only a later launch replaces it.
        assert instance.engine.context(worktree["id"], "dev") is context
        instance.engine.cancel(run["id"])
        assert wait_run(instance.store, run)["status"] == "canceled"
    finally:
        instance.close()


def test_origin_policy_missing_binary_and_runtime_compatibility(tmp_path):
    from duckpad.extensions import runtime

    version, platform = runtime()
    entry = {"source": "community", "repository": "offline_test", "version": version, "platform": platform}
    requirement = {"name": "example", "source": "community"}
    imports = {"example": entry}
    available = [("example", "REPOSITORY", "core")]

    def resolve():
        return project_extensions.resolve(requirement, imports, available, False, tmp_path)

    assert resolve()["status"] == "missing"
    binary = tmp_path / version / platform / "repositories/offline_test/example.duckdb_extension"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"not a valid binary")
    assert resolve()["status"] == "ready"
    entry["platform"] = "wrong_platform"
    assert resolve()["status"] == "incompatible"
    entry["platform"] = platform
    requirement["source"] = "unsigned"
    assert resolve()["status"] == "policy"
    requirement["source"] = "community"
    entry["source"] = "unsigned"
    assert resolve()["status"] == "missing"


def test_loading_crashes_and_timeouts_are_actionable(tmp_path, monkeypatch):
    config = {"extension_directory": str(tmp_path), "allow_unsigned_extensions": False}
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess([], -4, "", ""))
    with pytest.raises(Problem, match="server CPU and native dependencies"):
        project_extensions.check(config, [], {})

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("probe", 30)

    monkeypatch.setattr(subprocess, "run", timeout)
    with pytest.raises(Problem, match="timed out"):
        project_extensions.check(config, [], {})


def test_project_api_checks_loading_and_retains_unavailable_imported_requirements(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        files = bundle_to_files(bundle({"missing_capability": {"source": "community", "enabled": True}}))
        response = client.post("/api/projects/import", files={"file": ("project.zip", write_archive(files))})
        assert response.status_code == 200, response.text
        identity = response.json()["id"]
        url = f"/api/worktrees/{identity}"
        state = client.get(url + "/extensions").json()
        assert state["core_extensions"] == client.get("/api/extensions/runtime").json()["core_extensions"]
        state = state["requirements"][0]
        assert state["status"] == "missing" and state["enabled"]
        response = client.post(url + "/extensions/check", json={"name": "json", "source": "core"})
        assert response.status_code == 200, response.text
        response = client.post(url + "/extensions/check", json={"name": "json", "source": "community"})
        assert response.status_code == 422
        assert "from community" in response.json()["error"]
        assert (
            client.post(url + "/extensions/check", json={"name": "../json", "source": "core"}).status_code
            == 422
        )
        exported = read_archive(io.BytesIO(client.get(url + "/archive.zip").content))
        assert files_to_bundle(exported)["extensions"] == files_to_bundle(files)["extensions"]
        assert client.get("/api/extensions/settings").json() == {"allow_unsigned_extensions": False}
