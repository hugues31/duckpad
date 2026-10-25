"""Reproducible job-service experiments; no application schedules are installed."""

import importlib.metadata
import json
import tempfile
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.schedulers.background import BackgroundScheduler
from huey import SqliteHuey

from duckpad.catalog import Catalog
from duckpad.engine import Engine
from duckpad.projects import Projects
from duckpad.store import Store
from duckpad.util import Problem


def scheduled_request(payload):
    """Future handlers would resolve an instance service and call Engine.launch."""
    return payload


def wait(store, identity):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        run = store.get("run", identity)
        if run["status"] not in ("preparing", "running", "canceling"):
            return run
        time.sleep(0.01)
    raise AssertionError("Prototype did not finish")


def prototype(directory):
    database = "sqlite:///" + str(directory / "schedules.sqlite")
    scheduler = BackgroundScheduler(jobstores={"default": SQLAlchemyJobStore(url=database)})
    scheduler.start(paused=True)
    first = datetime.now(UTC) + timedelta(days=2)
    scheduler.add_job(
        scheduled_request,
        "interval",
        days=1,
        start_date=first,
        id="daily",
        args=[{"worktree": "demo", "environment": "dev"}],
    )
    scheduler.modify_job("daily", args=[{"worktree": "demo", "environment": "prod"}])
    scheduler.reschedule_job("daily", trigger="interval", hours=12, start_date=first)
    scheduler.shutdown()
    restored = BackgroundScheduler(jobstores={"default": SQLAlchemyJobStore(url=database)})
    restored.start(paused=True)
    job = restored.get_job("daily")
    assert job.args[0]["environment"] == "prod" and job.trigger.interval.total_seconds() == 43200
    restored.remove_job("daily")
    assert not restored.get_jobs()
    restored.shutdown()

    filename = str(directory / "huey.sqlite")
    huey = SqliteHuey("prototype", filename=filename)
    task = huey.task()(scheduled_request)
    task({"worktree": "demo", "environment": "dev"})
    reopened = SqliteHuey("prototype", filename=filename)
    assert len(reopened) == 1  # Pending dispatch survives a process restart.
    reopened.flush()

    store = Store(directory / "instance")
    projects = Projects(store)
    catalog = Catalog(store)
    engine = Engine(store, projects, catalog)
    source = directory / "input.csv"
    source.write_text("id,amount\n1,10\n2,20\n")
    bundle = {
        "flow": {
            "nodes": [
                {"id": "source", "template": "csv", "params": {"connection": "local", "file": str(source)}}
            ],
            "edges": [],
        },
        "templates": {
            "csv": '-- @kind source\n-- @param connection: connection = "local"\n-- @param file: file(connection)\n-- @output result\nSELECT * FROM read_csv({{ file }});'
        },
        "components": {},
        "documentation": {},
    }
    worktree = projects.create("Prototype", bundle)["id"]
    other = projects.branch(worktree, "prototype/isolated")["id"]
    entered, release = threading.Event(), threading.Event()
    original = catalog.prepare

    def hold(db, captured):
        entered.set()
        release.wait(5)
        original(db, captured)

    catalog.prepare = hold
    run = engine.launch(worktree, "dev", entry_point="ui")
    assert entered.wait(2)
    rejected = []
    for origin in ("api", "prototype_schedule", "prototype_webhook"):
        try:
            engine.launch(worktree, "prod", entry_point=origin)
        except Problem as error:
            assert error.status == 409
            rejected.append(origin)
    assert len(rejected) == 3
    second = engine.launch(other, "dev")
    engine.cancel(run["id"])
    release.set()
    assert wait(store, run["id"])["status"] == "canceled"
    assert wait(store, second["id"])["status"] == "success"
    assert engine.preview(other, "dev", "source")["count"] == 2
    assert not engine.active
    engine.close()
    restarted = Engine(store, projects, catalog)
    assert store.get("run", run["id"])["status"] == "canceled" and not restarted.active
    try:
        restarted.preview(other, "dev", "source")
        raise AssertionError("Datasets must not survive restart")
    except Problem as error:
        assert error.status == 404
    restarted.close()
    projects.stop()
    store.close()
    return {
        "versions": {
            name: importlib.metadata.version(name) for name in ("huey", "apscheduler", "sqlalchemy", "duckdb")
        },
        "apscheduler": {
            "dynamic_create_modify_reschedule_delete": True,
            "sqlite_schedule_restart": True,
            "started_paused_without_replay": True,
        },
        "huey": {
            "sqlite_queue_survives_restart": True,
            "pending_jobs_need_explicit_no_replay_policy": True,
            "task_queue_does_not_replace_worktree_admission": True,
        },
        "embedded": {
            "origins_rejected_while_busy": rejected,
            "another_worktree_admitted": True,
            "cancellation_keeps_admission_until_cleanup": True,
            "same_context_preview": True,
            "durable_history_after_restart": True,
            "no_dataset_or_job_replay": True,
        },
        "decision": "Embedded execution service for the MVP. APScheduler 3.x is the future scheduling adapter; no schedules or automatic retries are enabled.",
    }


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="duckpad-jobs-") as temporary:
        result = prototype(Path(temporary))
    output = Path("docs/validation/jobs.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
