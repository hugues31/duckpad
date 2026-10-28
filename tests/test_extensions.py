"""Instance extension policy applies to every database and survives restarts."""

import duckdb
import pytest
from fastapi.testclient import TestClient
from helpers import wait_run

from duckpad.app import create_app
from duckpad.services import Services


def bundle(query="SELECT current_setting('allow_unsigned_extensions') AS allowed"):
    return {
        "flow": {"nodes": [{"id": "source", "template": "source", "params": {}}], "edges": []},
        "templates": {"source": "-- @kind source\n-- @output result\n" + query + ";"},
        "components": {},
        "documentation": {},
    }


@pytest.mark.parametrize("isolated", [False, True], ids=["embedded", "isolated"])
def test_extension_policy_recreates_databases_and_persists_across_restarts(tmp_path, isolated):
    home = tmp_path / "instance"
    instance = Services.open(home, enforce_access=isolated)
    try:
        worktree = instance.projects.create("Extension policy", bundle())
        if isolated:
            instance.engine.access.own(worktree, {"id": "admin"}, ["local"])
        identity = worktree["id"]
        commit = instance.projects.snapshot(identity)["commit"]
        for enabled in (False, True, False):
            assert instance.engine.configure_extensions(enabled) == {"allow_unsigned_extensions": enabled}
            run = wait_run(instance.store, instance.engine.launch(identity, "dev"))
            assert run["status"] == "success", run
            assert instance.engine.preview(identity, "dev", "source")["rows"][0]["values"] == [enabled]
            assert instance.projects.snapshot(identity)["commit"] == commit
            if isolated:
                cursor = instance.engine.context(identity, "dev").db.cursor()
                try:
                    with pytest.raises(duckdb.Error, match=r"[Ll]ocked|[Cc]annot"):
                        cursor.execute(f"SET allow_unsigned_extensions = {'false' if enabled else 'true'}")
                finally:
                    cursor.close()
            instance.close()
            instance = Services.open(home, enforce_access=isolated)
            assert instance.engine.extension_settings() == {"allow_unsigned_extensions": enabled}
            run = wait_run(instance.store, instance.engine.launch(identity, "dev"))
            assert run["status"] == "success", run
            assert instance.engine.preview(identity, "dev", "source")["rows"][0]["values"] == [enabled]
    finally:
        instance.close()


def test_extension_settings_api_requires_a_boolean_and_preserves_active_runs(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        assert client.get("/api/extensions/settings").status_code == 401
        assert client.get("/api/extensions/runtime").status_code == 401
        assert client.post("/api/extensions/import").status_code == 401
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        defaults = {"allow_unsigned_extensions": False}
        assert client.get("/api/extensions/settings").json() == defaults
        for body in ({}, {"allow_unsigned_extensions": "true"}, {"allow_unsigned_extensions": 1}):
            assert client.put("/api/extensions/settings", json=body).status_code == 422
            assert client.get("/api/extensions/settings").json() == defaults
        enabled = {"allow_unsigned_extensions": True}
        assert client.put("/api/extensions/settings", json=enabled).json() == enabled
        services = app.state.services
        worktree = services.projects.create(
            "Active pipeline", bundle("SELECT sum(i::HUGEINT) FROM range(1000000000000) r(i)")
        )
        app.state.access.own(worktree, {"id": "admin"}, ["local"])
        run = services.engine.launch(worktree["id"], "dev")
        try:
            response = client.put("/api/extensions/settings", json=defaults)
            assert response.status_code == 409
            assert "active executions" in response.json()["error"]
            assert client.get("/api/extensions/settings").json() == enabled
            assert client.put("/api/extensions/settings", json=enabled).status_code == 200
            assert (
                client.post(
                    "/api/extensions/import",
                    data={"source": "core"},
                    files={"file": ("example.duckdb_extension", b"invalid")},
                ).status_code
                == 409
            )
        finally:
            services.engine.cancel(run["id"])
            wait_run(services.store, run)
        context = services.engine.context(worktree["id"], "dev")
        assert client.put("/api/extensions/settings", json=defaults).json() == defaults
        assert context.db.closed
        assert services.engine.contexts == {}


def test_extension_upload_validation_preserves_settings_and_cache(tmp_path, monkeypatch):
    from duckpad import extensions

    app = create_app(tmp_path / "instance", watch=False)
    with TestClient(app) as client:
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        runtime = client.get("/api/extensions/runtime").json()
        assert runtime["version"] and runtime["platform"] and runtime["imports"] == []
        for filename, body, source in [
            ("../../outside.duckdb_extension", b"invalid", "core"),
            ("C:\\outside.duckdb_extension", b"invalid", "core"),
            ("bundle.tar.gz", b"invalid", "community"),
            ("example.duckdb_extension.gz", b"not gzip", "community"),
            ("example.duckdb_extension", b"not an extension", "core"),
            ("example.duckdb_extension", b"not an extension", "unsigned"),
        ]:
            response = client.post(
                "/api/extensions/import", data={"source": source}, files={"file": (filename, body)}
            )
            assert response.status_code == 400, response.text
            assert client.get("/api/extensions/runtime").json() == runtime
        assert (
            client.post(
                "/api/extensions/import",
                data={"source": "untrusted-key"},
                files={"file": ("example.duckdb_extension", b"invalid")},
            ).status_code
            == 422
        )
        monkeypatch.setattr(extensions, "MAX_UPLOAD_BYTES", 16)
        assert (
            client.post(
                "/api/extensions/import",
                data={"source": "core"},
                files={"file": ("example.duckdb_extension", b"x" * 17)},
            ).status_code
            == 413
        )
        monkeypatch.setattr(extensions, "MAX_UPLOAD_BYTES", 1024)
        monkeypatch.setattr(extensions, "MAX_BINARY_BYTES", 16)
        import gzip

        assert (
            client.post(
                "/api/extensions/import",
                data={"source": "core"},
                files={"file": ("example.duckdb_extension.gz", gzip.compress(b"x" * 17))},
            ).status_code
            == 413
        )
        assert app.state.services.store.get("settings", "offline_extensions", {}) == {}
        assert not list((tmp_path / "instance" / "extensions").glob(".import-*"))
