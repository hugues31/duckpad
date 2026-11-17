"""Scenario and notification routes."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from .. import schemas
from ..notifications import NotificationSettings
from ..schedules import Schedule, iso
from ..types import Record
from .context import Context
from .deps import requester
from .security import instance_admin, job_role, project_role, scenario_role, scenario_run_role, signed_in


class DestinationTest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    destination: str = Field(min_length=1, max_length=40)


def router(ctx: Context) -> APIRouter:
    api = APIRouter()
    scenarios, notifications = ctx.scenarios, ctx.notifications

    @api.get(
        "/api/projects/{project}/scenarios",
        response_model=None,
        dependencies=[Depends(project_role("reader"))],
    )
    def list_scenarios(project: str) -> list[Record]:
        return scenarios.listing(project)

    @api.post(
        "/api/projects/{project}/scenarios",
        response_model=None,
        status_code=201,
        dependencies=[Depends(project_role("admin"))],
    )
    def create_scenario(project: str, data: schemas.NewScenario) -> Record:
        return scenarios.create(project, data)

    @api.get(
        "/api/scenarios/{scenario}", response_model=None, dependencies=[Depends(scenario_role("reader"))]
    )
    def get_scenario(scenario: str) -> Record:
        return scenarios.public(scenarios.get(scenario))

    @api.patch(
        "/api/scenarios/{scenario}", response_model=None, dependencies=[Depends(scenario_role("admin"))]
    )
    def update_scenario(scenario: str, data: schemas.ScenarioChanges) -> Record:
        return scenarios.update(scenario, data)

    @api.delete(
        "/api/scenarios/{scenario}", response_model=None, dependencies=[Depends(scenario_role("admin"))]
    )
    def delete_scenario(scenario: str) -> Record:
        scenarios.delete(scenario)
        return {"ok": True}

    @api.get(
        "/api/scenarios/{scenario}/runs",
        response_model=None,
        dependencies=[Depends(scenario_role("reader"))],
    )
    def scenario_runs(
        scenario: str,
        response: Response,
        limit: int = Query(20, ge=1, le=100),
        cursor: str | None = None,
    ) -> list[Record]:
        rows = ctx.services.store.scenario_runs(scenario, limit=limit + 1, cursor=cursor)
        if len(rows) > limit:
            response.headers["X-Next-Cursor"] = ctx.services.store.run_cursor(rows[limit - 1])
        return rows[:limit]

    @api.post(
        "/api/scenarios/{scenario}/runs",
        response_model=None,
        status_code=202,
        dependencies=[Depends(scenario_role("operator"))],
    )
    def launch_scenario(scenario: str, data: schemas.ScenarioLaunch, request: Request) -> Record:
        return scenarios.launch(
            scenario,
            trigger={"source": "manual"},
            requester=requester(request),
            values=data.parameters,
            confirmed=data.confirmed,
        )

    @api.post(
        "/api/scenario-runs/{scenario_run}/cancel",
        response_model=None,
        dependencies=[Depends(scenario_run_role("operator"))],
    )
    def cancel_scenario_run(scenario_run: str) -> Record:
        return scenarios.cancel(scenario_run)

    @api.get("/api/jobs/{slug}/variables", response_model=None, dependencies=[Depends(job_role("reader"))])
    def job_variables(slug: str) -> Record:
        return scenarios.job_variables(ctx.jobs.get(slug))

    @api.get("/api/schedule-preview", response_model=None, dependencies=[Depends(signed_in)])
    def schedule_preview(cron: str, timezone: str = "UTC") -> Record:
        schedule = Schedule.parse(cron, timezone)
        occurrences, current = [], datetime.now(UTC)
        for _ in range(3):
            following = schedule.next_after(current)
            if following is None:
                break
            occurrences.append(iso(following))
            current = following
        return {"next": occurrences}

    @api.get("/api/notification-destinations", response_model=None, dependencies=[Depends(signed_in)])
    def notification_destinations() -> list[Record]:
        return notifications.destinations()

    @api.get("/api/notification-settings", response_model=None, dependencies=[Depends(instance_admin)])
    def notification_settings() -> Record:
        return notifications.public()

    @api.put("/api/notification-settings", response_model=None, dependencies=[Depends(instance_admin)])
    def save_notification_settings(data: NotificationSettings) -> Record:
        return notifications.save(data)

    @api.post("/api/notification-settings/test", response_model=None, dependencies=[Depends(instance_admin)])
    def test_notification(data: DestinationTest) -> Record:
        return notifications.test(data.destination)

    return api
