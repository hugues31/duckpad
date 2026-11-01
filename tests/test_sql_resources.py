"""Instance SQL resources size every SQL session from its next run and survive restarts."""

import pytest
from fastapi.testclient import TestClient
from helpers import wait_run

from duckpad.app import create_app
from duckpad.auth import Auth
from duckpad.execution.contexts import automatic_resources
from duckpad.services import Services


def bundle(query="SELECT current_setting('threads') AS threads, current_setting('memory_limit') AS memory"):
    return {
        "flow": {"nodes": [{"id": "source", "template": "source", "params": {}}], "edges": []},
        "templates": {"source": "-- @kind source\n-- @output result\n" + query + ";"},
        "components": {},
        "documentation": {},
    }


@pytest.mark.parametrize("isolated", [False, True], ids=["embedded", "isolated"])
def test_sql_resources_restart_sessions_at_their_next_run_and_persist(tmp_path, isolated):
    home = tmp_path / "instance"
    instance = Services.open(home, enforce_access=isolated)
    automatic = automatic_resources()
    try:
        worktree = instance.projects.create("SQL resources", bundle())
        if isolated:
            Auth(instance.store)
            instance.engine.access.own(worktree, {"id": "admin"}, ["local"])
        identity = worktree["id"]

        def preview():
            return instance.engine.preview(identity, "dev", "source")["rows"][0]["values"]

        def run():
            result = wait_run(instance.store, instance.engine.launch(identity, "dev"))
            assert result["status"] == "success", result
            return preview()

        # Without explicit resources, sessions keep DuckDB's sizing, even inside the sandbox.
        assert run() == [automatic["threads"], automatic["memory_limit"]]
        session = instance.engine.context(identity, "dev").db
        assert instance.engine.configure_sql_resources({"threads": 3, "memory_limit": "1GiB"}) == {
            "threads": 3,
            "memory_limit": "1GiB",
            "automatic": automatic,
        }
        # The current session keeps its results until its next run restarts it.
        assert instance.engine.context(identity, "dev").db is session
        assert preview() == [automatic["threads"], automatic["memory_limit"]]
        assert run() == [3, "1.0 GiB"]
        assert instance.engine.context(identity, "dev").db is not session
        session = instance.engine.context(identity, "dev").db
        assert run() == [3, "1.0 GiB"]
        assert instance.engine.context(identity, "dev").db is session

        instance.close()
        instance = Services.open(home, enforce_access=isolated)
        assert instance.engine.sql_resources() == {
            "threads": 3,
            "memory_limit": "1GiB",
            "automatic": automatic,
        }
        assert run() == [3, "1.0 GiB"]
        instance.engine.configure_sql_resources({"threads": None, "memory_limit": None})
        assert run() == [automatic["threads"], automatic["memory_limit"]]
    finally:
        instance.close()


def test_sql_resources_api_validates_values_and_keeps_active_runs(tmp_path):
    app = create_app(tmp_path / "instance", watch=False)
    automatic = automatic_resources()
    defaults = {"threads": None, "memory_limit": None, "automatic": automatic}
    with TestClient(app) as client:
        assert client.get("/api/sql-resources").status_code == 401
        assert client.put("/api/sql-resources", json={}).status_code == 401
        client.post("/api/login", json={"password": app.state.auth.initial_password})
        assert client.get("/api/sql-resources").json() == defaults
        for body in (
            {"threads": 0},
            {"threads": 1025},
            {"threads": "4"},
            {"threads": 2.5},
            {"memory_limit": "16"},
            {"memory_limit": "0GB"},
            {"memory_limit": "120%"},
            {"memory_limit": "-1GB"},
            {"memory_limit": 512},
            {"cpus": 4},
        ):
            assert client.put("/api/sql-resources", json=body).status_code == 422, body
        assert client.get("/api/sql-resources").json() == defaults

        response = client.put("/api/sql-resources", json={"threads": 4, "memory_limit": " 16 gib "})
        assert response.json() == {"threads": 4, "memory_limit": "16GiB", "automatic": automatic}
        assert client.put("/api/sql-resources", json={"memory_limit": "50%"}).json() == {
            **defaults,
            "memory_limit": "50%",
        }

        services = app.state.services
        worktree = services.projects.create(
            "Active pipeline", bundle("SELECT sum(i::HUGEINT) FROM range(1000000000000) r(i)")
        )
        app.state.access.own(worktree, {"id": "admin"}, ["local"])
        run = services.engine.launch(worktree["id"], "dev")
        try:
            session = services.engine.context(worktree["id"], "dev").db
            # Saving needs no idle instance: running sessions keep their resources.
            response = client.put("/api/sql-resources", json={"threads": None, "memory_limit": ""})
            assert response.json() == defaults
            assert services.engine.context(worktree["id"], "dev").db is session
            assert not session.closed
        finally:
            services.engine.cancel(run["id"])
            wait_run(services.store, run)
