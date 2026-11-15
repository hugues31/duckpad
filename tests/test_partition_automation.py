"""Partition Job selectors use the existing role and idempotency contracts."""

import test_jobs
from fastapi.testclient import TestClient
from helpers import join_run
from test_partitions import bundle

from duckpad.bundle import bundle_to_files

instance = test_jobs.instance


def test_job_partition_pages_authorization_and_idempotency(instance):
    app, tree, _, _, users = instance
    services = app.state.services
    snapshot = services.projects.snapshot(tree["id"])
    services.projects.write(tree["id"], snapshot["revision"], bundle_to_files(bundle()))
    test_jobs.create(instance, kind="branch", ref="main")
    with TestClient(app) as client:

        def call(method, path, data=None, actor="operator", key=None):
            return client.request(
                method,
                "/api/v1" + path,
                json=data,
                headers={**users[actor][1], **({"Idempotency-Key": key} if key else {})},
            )

        body = {
            "partitions": {"mode": "selected", "keys": [{"type": "text", "value": "b"}]},
            "partition_execution": {"parallelism": 2},
        }
        assert call("POST", "/jobs/daily/runs", body, actor="reader").status_code == 403
        accepted = call("POST", "/jobs/daily/runs", body, key="one-key")
        assert accepted.status_code == 202, accepted.text
        identity = accepted.json()["id"]
        run = join_run(services.store, identity)
        assert run["partitions"]["selected"] == 1
        assert call("POST", "/jobs/daily/runs", body, key="one-key").json()["id"] == identity
        assert (
            call("POST", "/jobs/daily/runs", {"partitions": {"mode": "all"}}, key="one-key").status_code
            == 422
        )
        path = f"/runs/{identity}/partitions"
        assert call("GET", path, actor="outsider").status_code == 404
        page = call("GET", path + "?node=transform&limit=1", actor="reader").json()
        assert page["entries"][0]["nodes"]["transform"]["status"] == "not_started"
        next_page = call(
            "GET", path + "?node=transform&limit=1&cursor=" + page["next_cursor"], actor="reader"
        ).json()
        selected = next_page["entries"][0]
        assert selected["key"]["value"] == "b"
        assert selected["nodes"]["transform"]["status"] == "success"
        log = call("GET", f"/runs/{identity}/log?partition_id={selected['partition_id']}", actor="reader")
        assert log.status_code == 200
        assert "Node transform" in log.text and "Node keys" not in log.text
        assert call("GET", f"/runs/{identity}/log?partition_id=wrong", actor="reader").status_code == 404
