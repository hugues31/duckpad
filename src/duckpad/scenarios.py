"""Scenarios: ordered Job steps launched manually, on a schedule or by a webhook.

A Job defines what runs: a reviewed version, an environment and a scope. A scenario defines
when Jobs run and in which order, which values a launch can set, and who hears about the
outcome. A scenario run executes its steps one after the other, each as an ordinary Job run in
that Job's execution context, then sends the notifications its outcome calls for.

Admission follows Jobs: a scenario whose run or one of whose Jobs is active refuses a launch,
without queuing, retrying or replaying it. Refused automatic triggers and schedule occurrences
missed while Duckpad was stopped are recorded in the history, so they stay visible.
"""

import copy
import logging
import threading
import time
from contextlib import suppress
from datetime import UTC, datetime, timedelta

from . import variables
from .bundle import files_to_bundle
from .execution.journal import UNFINISHED_RUN_STATUSES
from .schedules import Schedule, iso, parse_instant
from .schemas import JobLaunch
from .util import Problem, now, uid
from .value_types import check_value

logger = logging.getLogger("duckpad.execution")

ACTIVE = ("running", "canceling")
# Outcomes a "failure" notification covers; a cancellation is someone's decision.
FAILURES = ("failed", "interrupted", "rejected", "missed")
# An occurrence found later than this, after a restart or a stalled scheduler, is missed.
MISSED_AFTER = timedelta(minutes=2)
TICK = 10
POLL = 0.5
SCHEDULER = {"id": "schedule", "username": "schedule", "token_name": None, "service": True}


def notify_on(rule, outcome):
    if rule == "always":
        return True
    return outcome == "success" if rule == "success" else outcome in FAILURES


class Scenarios:
    def __init__(self, services, jobs, notifications):
        self.store, self.engine, self.projects = services.store, services.engine, services.projects
        self.catalog = services.catalog
        self.jobs, self.notifications = jobs, notifications
        self.lock = threading.RLock()
        # Scenario slug -> {"id": scenario run, "cancel": Event}.
        self.active = {}
        self.threads = []
        self.closing = False
        self.stopping = threading.Event()
        self.scheduler = None
        self.recover()

    # Definitions

    def get(self, slug):
        scenario = self.store.get("scenario", slug)
        if not scenario:
            raise Problem("Scenario not found", 404, {"code": "scenario_not_found"})
        return scenario

    def job_variables(self, job):
        """Ordinary variables of a Job's current version, which a launch can set."""
        files = self.projects.revision_files(self.jobs.path(job["project"]), self.jobs.current_commit(job))
        declared, _ = variables.inspect_declarations(files_to_bundle(files))
        return {
            name: {"type": item["type"], "description": item["description"]}
            for name, item in declared.items()
            if "from" not in item
        }

    def definition(self, project, data):
        steps, offered = [], {}
        for index, step in enumerate(data.steps, 1):
            job = self.store.get("job", step.job)
            if not job or job["project"] != project:
                raise Problem(f"Step {index}: choose a Job of this project", 422)
            steps.append({"job": step.job, "run_if": step.run_if})
            for name, item in self.job_variables(job).items():
                offered.setdefault(name, set()).add(item["type"])
        parameters = []
        for name in dict.fromkeys(data.parameters):
            types = offered.get(name)
            if not types:
                raise Problem(f"{name} is not a variable of the versions these Jobs run", 422)
            if len(types) > 1:
                raise Problem(f"{name} has different types in the versions these Jobs run", 422)
            parameters.append({"name": name, "type": types.pop()})
        schedules = []
        for index, item in enumerate(data.schedules, 1):
            try:
                schedule = Schedule.parse(item.cron, item.timezone)
            except Problem as error:
                raise Problem(f"Schedule {index}: {error}", 422) from error
            schedules.append({"cron": schedule.expression, "timezone": item.timezone})
        known = {item["id"] for item in self.notifications.destinations()}
        notifications = []
        for item in data.notifications:
            if item.destination not in known:
                raise Problem("Choose a notification destination configured on this instance", 422)
            notifications.append({"destination": item.destination, "on": item.on})
        return {
            "name": data.name,
            "description": data.description,
            "enabled": data.enabled,
            "steps": steps,
            "parameters": parameters,
            "schedules": self.planned(schedules),
            "webhook": data.webhook,
            "notifications": notifications,
            "revision": uid(),
        }

    @staticmethod
    def planned(schedules, after=None):
        """Schedules with their next occurrence, counted from `after` (now by default)."""
        after = after or datetime.now(UTC)
        result = []
        for item in schedules:
            occurrence = Schedule.parse(item["cron"], item["timezone"]).next_after(after)
            result.append({**item, "next": iso(occurrence) if occurrence else None})
        return result

    def create(self, project, data):
        with self.lock:
            if self.store.get("scenario", data.slug):
                raise Problem("A scenario with this slug already exists", 409)
            scenario = {"id": data.slug, "project": project, **self.definition(project, data)}
            self.store.put("scenario", data.slug, scenario)
            return self.public(scenario)

    def update(self, slug, data):
        with self.lock:
            scenario = self.get(slug)
            if scenario["revision"] != data.revision:
                raise Problem("This scenario changed; reload before saving", 409)
            scenario.update(self.definition(scenario["project"], data))
            self.store.put("scenario", slug, scenario)
            return self.public(scenario)

    def delete(self, slug):
        with self.lock:
            self.get(slug)
            if slug in self.active:
                raise Problem("Stop the active run before deleting this scenario", 409)
            self.store.delete("scenario", slug)

    def public(self, scenario):
        steps = []
        for step in scenario["steps"]:
            job = self.store.get("job", step["job"])
            steps.append(
                {
                    **step,
                    "name": job["name"] if job else None,
                    "environment": job["environment"] if job else None,
                }
            )
        runs = self.store.scenario_runs(scenario["id"], limit=1)
        token = self.active.get(scenario["id"])
        return {
            **scenario,
            "slug": scenario["id"],
            "steps": steps,
            "last_run": runs[0] if runs else None,
            "active_run": token["id"] if token else None,
        }

    def listing(self, project):
        return [self.public(scenario) for scenario in self.store.scenarios(project)]

    # Admission

    def values(self, scenario, values):
        declared = {item["name"]: item["type"] for item in scenario["parameters"]}
        for name, value in values.items():
            if name not in declared:
                raise Problem(
                    f"{name} is not a launch value of this scenario", 422, {"code": "invalid_request"}
                )
            if message := check_value(declared[name], value):
                raise Problem(f"Launch value {name}: {message}", 422, {"code": "invalid_request"})
        return copy.deepcopy(values)

    def busy(self, scenario):
        token = self.active.get(scenario["id"])
        if token:
            return Problem(
                "This scenario is already running", 409, {"code": "scenario_busy", "run": token["id"]}
            )
        for step in scenario["steps"]:
            job = self.store.get("job", step["job"])
            if not job:
                continue
            try:
                self.jobs.idle(job)
            except Problem as error:
                return Problem(
                    f"The Job {job['name']} is already running", 409, {"code": "job_busy", **error.detail}
                )
        return None

    def confirm(self, scenario):
        """A person launching steps in protected environments confirms them first."""
        protected = {}
        for step in scenario["steps"]:
            job = self.store.get("job", step["job"])
            if job:
                with_settings = self.catalog.environment(job["environment"])
                if with_settings["confirm_before_run"]:
                    protected[job["environment"]] = with_settings
        if protected:
            raise Problem(
                "Confirm these environments before running",
                409,
                {"confirmation_required": list(protected.values())},
            )

    def launch(self, slug, *, trigger, requester, values=None, confirmed=False, delivery=None):
        """Admit a run and start its steps in a thread; return it with `duplicate` for a replayed delivery."""
        automatic = trigger["source"] in ("schedule", "webhook")
        with self.lock:
            if self.closing:
                raise Problem("The execution service is shutting down", 503)
            scenario = self.get(slug)
            if delivery is not None and (previous := self.store.scenario_delivery(slug, delivery)):
                return {**previous, "duplicate": True}
            if automatic and not scenario["enabled"]:
                refusal = Problem("This scenario is disabled", 409, {"code": "scenario_disabled"})
            elif trigger["source"] == "webhook" and not scenario["webhook"]:
                refusal = Problem("This scenario does not accept webhooks", 409, {"code": "webhook_disabled"})
            else:
                values = self.values(scenario, values or {})
                refusal = self.busy(scenario)
            if refusal:
                if automatic:
                    self.reject(scenario, trigger, requester, values or {}, refusal)
                raise refusal
            if not automatic and not confirmed:
                self.confirm(scenario)
            run = self.record(scenario, trigger, requester, values, delivery)
            token = {"id": run["id"], "cancel": threading.Event()}
            self.active[slug] = token
            self.store.put("scenario_run", run["id"], run)
            thread = threading.Thread(
                target=self.execute, args=(scenario, run, token), name=run["id"], daemon=True
            )
            self.threads = [t for t in self.threads if t.is_alive()] + [thread]
            thread.start()
        self.store.prune_scenario_runs(slug)
        return run

    def record(self, scenario, trigger, requester, values, delivery=None, status="running"):
        steps = []
        for step in scenario["steps"]:
            job = self.store.get("job", step["job"])
            steps.append(
                {
                    "job": step["job"],
                    "name": job["name"] if job else step["job"],
                    "run_if": step["run_if"],
                    "status": "pending",
                }
            )
        return {
            "id": uid("scn_"),
            "scenario": scenario["id"],
            "status": status,
            "started": now(),
            "finished": None,
            "delivery": delivery,
            "name": scenario["name"],
            "project": scenario["project"],
            "trigger": trigger,
            "requester": copy.deepcopy(requester),
            "parameters": values,
            "steps": steps,
            "notify": copy.deepcopy(scenario["notifications"]),
            "notifications": [],
        }

    def reject(self, scenario, trigger, requester, values, error):
        """Record a refused automatic trigger; its sender is not around to read the response."""
        run = self.record(scenario, trigger, requester, values, status="rejected")
        run.update(finished=run["started"], error=str(error), detail=error.detail, steps=[])
        logger.info(
            "Scenario trigger refused: scenario=%s source=%s code=%s",
            scenario["id"],
            trigger["source"],
            (error.detail or {}).get("code"),
        )
        self.store.put("scenario_run", run["id"], run)
        self.store.prune_scenario_runs(scenario["id"])
        self.notify_later(run)
        return run

    def cancel(self, run_id):
        run = self.store.get("scenario_run", run_id)
        if not run:
            raise Problem("Scenario run not found", 404)
        with self.lock:
            token = self.active.get(run["scenario"])
            if not token or token["id"] != run_id:
                return run
            token["cancel"].set()
            run = self.store.get("scenario_run", run_id)
            if run["status"] == "running":
                run["status"] = "canceling"
                self.store.put("scenario_run", run_id, run)
        return run

    # Execution

    def save(self, run):
        with self.lock:
            stored = self.store.get("scenario_run", run["id"])
            # A cancellation request written meanwhile stays visible until the outcome.
            if stored and stored["status"] == "canceling" and run["status"] == "running":
                run["status"] = "canceling"
            self.store.put("scenario_run", run["id"], run)

    def execute(self, scenario, run, token):
        failed = False
        try:
            for step in run["steps"]:
                if token["cancel"].is_set() or self.closing:
                    step["status"] = "skipped"
                    continue
                condition = step["run_if"]
                if (condition == "success" and failed) or (condition == "failure" and not failed):
                    step["status"] = "skipped"
                    self.save(run)
                    continue
                self.run_step(scenario, run, step, token)
                failed = failed or step["status"] != "success"
            if self.closing:
                outcome = "interrupted"
            elif token["cancel"].is_set():
                outcome = "canceled"
            else:
                outcome = "failed" if failed else "success"
        except Exception as error:
            logger.exception("Scenario run %s failed", run["id"])
            run["error"] = str(error)
            outcome = "failed"
        finished = now()
        run.update(status=outcome, finished=finished)
        for step in run["steps"]:
            if step["status"] in ("pending", "running"):
                step["status"] = "interrupted" if outcome == "interrupted" else "skipped"
        with self.lock:
            self.store.put("scenario_run", run["id"], run)
            if self.active.get(scenario["id"]) is token:
                del self.active[scenario["id"]]
        if outcome != "interrupted":
            self.notify(run)

    def run_step(self, scenario, run, step, token):
        step.update(status="running", started=now())
        self.save(run)
        started = time.monotonic()
        job = self.store.get("job", step["job"])
        try:
            if not job:
                raise Problem("This Job was deleted", 404)
            accepted = self.job_variables(job)
            values = {name: value for name, value in run["parameters"].items() if name in accepted}
            launched = self.jobs.launch(
                step["job"],
                JobLaunch(entry_point="api"),
                run["requester"],
                external_trigger={"source": "scenario", "reference": f"{scenario['id']}/{run['id']}"},
                launch_values=values,
                scenario={"slug": scenario["id"], "name": scenario["name"], "run": run["id"]},
            )
        except Problem as error:
            step.update(
                status="refused", error=str(error), finished=now(), duration=time.monotonic() - started
            )
            self.save(run)
            return
        step.update(run=launched["id"], worktree=launched["worktree"], environment=launched["environment"])
        self.save(run)
        requested = False
        while True:
            status = self.store.run_status(launched["id"])
            if status not in UNFINISHED_RUN_STATUSES:
                break
            if self.closing:
                status = "interrupted"
                break
            if token["cancel"].is_set() and not requested:
                requested = True
                self.engine.cancel(launched["id"])
            time.sleep(POLL)
        final = self.store.get("run", launched["id"]) or {}
        step.update(
            status=status or "interrupted",
            finished=final.get("finished") or now(),
            duration=final.get("duration", time.monotonic() - started),
        )
        # The run error, or the first node error, explains a failed step in the history.
        errors = [final.get("error"), *(node.get("error") for node in final.get("nodes", {}).values())]
        if error := next((item for item in errors if item), None):
            step["error"] = error
        self.save(run)

    # Notifications

    @staticmethod
    def message(run):
        outcome = run["status"].replace("_", " ")
        lines = [
            f"Scenario {run['name']} ({run['scenario']}): {outcome}",
            f"Trigger: {run['trigger']['source']}",
            f"Started: {run['started']}",
        ]
        if run.get("finished"):
            lines.append(f"Finished: {run['finished']}")
        lines.extend(f"Step {step['name']}: {step['status']}" for step in run["steps"])
        if run.get("error"):
            lines.append(f"Error: {run['error']}")
        text = "\n".join(lines)
        payload = {
            "event": "scenario.finished",
            "text": text,
            "scenario": {"slug": run["scenario"], "name": run["name"], "project": run["project"]},
            "run": {
                key: copy.deepcopy(run.get(key))
                for key in ("id", "status", "trigger", "started", "finished", "parameters", "error")
            },
            "steps": [
                {key: step.get(key) for key in ("job", "name", "status", "run", "error")}
                for step in run["steps"]
            ],
        }
        return {"subject": f"[Duckpad] {run['name']}: {outcome}", "text": text, "payload": payload}

    def notify(self, run):
        """Deliver the matching notifications once; failures are recorded, never retried."""
        rules = [rule for rule in run.get("notify", []) if notify_on(rule["on"], run["status"])]
        if not rules:
            return
        message = self.message(run)
        deliveries = [self.notifications.send(rule["destination"], message) for rule in rules]
        with self.lock:
            stored = self.store.get("scenario_run", run["id"])
            if stored:
                stored["notifications"] = deliveries
                self.store.put("scenario_run", run["id"], stored)

    def notify_later(self, run):
        if any(notify_on(rule["on"], run["status"]) for rule in run.get("notify", [])):
            thread = threading.Thread(target=self.notify, args=(run,), daemon=True)
            with self.lock:
                self.threads = [t for t in self.threads if t.is_alive()] + [thread]
            thread.start()

    # Schedules

    def missed(self, scenario, entry, occurrences):
        trigger = {
            "source": "schedule",
            "cron": entry["cron"],
            "timezone": entry["timezone"],
            "occurrence": iso(occurrences[0]),
            "missed": len(occurrences),
        }
        run = self.record(scenario, trigger, SCHEDULER, {}, status="missed")
        run.update(
            finished=run["started"],
            error="Duckpad was not running at the scheduled time; the occurrence was skipped",
            steps=[],
        )
        self.store.put("scenario_run", run["id"], run)
        self.store.prune_scenario_runs(scenario["id"])
        self.notify_later(run)

    def tick(self, instant=None):
        """Launch due occurrences and record missed ones; the next occurrence is saved first."""
        instant = instant or datetime.now(UTC)
        for scenario in self.store.scenarios():
            due = []
            with self.lock:
                scenario = self.store.get("scenario", scenario["id"])
                if not scenario or not scenario["enabled"]:
                    continue
                for entry in scenario["schedules"]:
                    if not entry.get("next") or parse_instant(entry["next"]) > instant:
                        continue
                    schedule = Schedule.parse(entry["cron"], entry["timezone"])
                    occurrences = schedule.between(
                        parse_instant(entry["next"]), instant + timedelta(seconds=1)
                    )
                    following = schedule.next_after(instant)
                    due.append((dict(entry), occurrences))
                    entry["next"] = iso(following) if following else None
                if not due:
                    continue
                self.store.put("scenario", scenario["id"], scenario)
            for entry, occurrences in due:
                late = [item for item in occurrences if instant - item > MISSED_AFTER]
                current = occurrences[len(late) :]
                if current:
                    # Several occurrences due at once can only run once.
                    late.extend(current[:-1])
                if late:
                    self.missed(scenario, entry, late)
                if current:
                    trigger = {
                        "source": "schedule",
                        "cron": entry["cron"],
                        "timezone": entry["timezone"],
                        "occurrence": iso(current[-1]),
                    }
                    # Launch records its refusals.
                    with suppress(Problem):
                        self.launch(scenario["id"], trigger=trigger, requester=SCHEDULER)

    def start(self):
        self.scheduler = threading.Thread(target=self.schedule, name="scenario-scheduler", daemon=True)
        self.scheduler.start()

    def schedule(self):
        while not self.stopping.wait(TICK):
            try:
                self.tick()
            except Exception:
                logger.exception("Scenario scheduler failed")

    # Lifecycle

    def recover(self):
        """Close scenario runs left active by a stopped instance; nothing is replayed."""
        for run in self.store.scenario_runs_with_statuses(ACTIVE):
            for step in run["steps"]:
                if step["status"] == "running":
                    status = self.store.run_status(step["run"]) if step.get("run") else None
                    step["status"] = (
                        status if status and status not in UNFINISHED_RUN_STATUSES else "interrupted"
                    )
                elif step["status"] == "pending":
                    step["status"] = "skipped"
            run.update(
                status="interrupted",
                finished=now(),
                error="Duckpad stopped during this run; the remaining steps were not run",
            )
            self.store.put("scenario_run", run["id"], run)
            self.notify_later(run)

    def close(self):
        with self.lock:
            self.closing = True
            threads = list(self.threads)
        self.stopping.set()
        if self.scheduler:
            self.scheduler.join()
        for thread in threads:
            thread.join(timeout=TICK)
