import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, send, withQuery } from "./api";
import { useT } from "./i18n";
import { jobSlug } from "./jobs";
import type { Job } from "./jobTypes";
import { ModalForm } from "./modals";
import {
  conditionKeys,
  notifyKeys,
  type Destination,
  type NotifyOn,
  type Scenario,
  type ScenarioSchedule,
  type StepCondition,
  zonedTime,
} from "./scenarioTypes";
import Select from "./Select";
import type { Project } from "./types";
import { useApiResource, useResource } from "./useApiResource";

type Offered = Record<string, { type: string; description: string }>;

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const timeZones = (() => {
  try {
    return [
      "UTC",
      ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC"),
    ];
  } catch {
    return ["UTC"];
  }
})();

function useDebounced<T>(value: T, delay = 400) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return current;
}

export function ScenarioForm({
  project,
  scenario,
  jobs,
  destinations,
  onClose,
  onSaved,
}: {
  project: Project;
  scenario: Scenario | null;
  jobs: Job[];
  destinations: Destination[];
  onClose: () => void;
  onSaved: (scenario: Scenario) => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState(scenario?.name || "");
  const [slug, setSlug] = useState<string | null>(null);
  const [description, setDescription] = useState(scenario?.description || "");
  const [enabled, setEnabled] = useState(scenario?.enabled ?? true);
  const [steps, setSteps] = useState<{ job: string; run_if: StepCondition }[]>(
    scenario
      ? scenario.steps.map(({ job, run_if }) => ({ job, run_if }))
      : jobs.length
        ? [{ job: jobs[0].slug, run_if: "success" }]
        : [],
  );
  const [parameters, setParameters] = useState<string[]>(
    scenario?.parameters.map((item) => item.name) || [],
  );
  const [schedules, setSchedules] = useState<ScenarioSchedule[]>(
    scenario?.schedules.map(({ cron, timezone }) => ({ cron, timezone })) || [],
  );
  const [webhook, setWebhook] = useState(scenario?.webhook ?? false);
  const [notifications, setNotifications] = useState<
    { destination: string; on: NotifyOn }[]
  >(scenario?.notifications || []);
  const chosen = [...new Set(steps.map((step) => step.job))].sort();
  const offered = useResource<Offered>(
    chosen.length ? chosen.join("\n") : null,
    async (signal) => {
      const lists = await Promise.all(
        chosen.map((job) =>
          api<Offered>(`/jobs/${encodeURIComponent(job)}/variables`, {
            signal,
          }),
        ),
      );
      return Object.assign({}, ...lists);
    },
  );
  const variables = offered.data || {};
  const move = (index: number, offset: number) =>
    setSteps((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  return (
    <ModalForm
      title={t(scenario ? "editScenario" : "newScenario")}
      wide
      className="scenario-form"
      onClose={onClose}
      submitLabel={t(scenario ? "save" : "create")}
      disabled={!steps.length}
      onSubmit={async () => {
        const fields = {
          name,
          description,
          enabled,
          steps,
          parameters: parameters.filter((item) => item in variables),
          schedules,
          webhook,
          notifications,
        };
        const saved = await api<Scenario>(
          scenario
            ? `/scenarios/${scenario.slug}`
            : `/projects/${project.id}/scenarios`,
          send(
            scenario
              ? { ...fields, revision: scenario.revision }
              : { ...fields, slug: slug ?? jobSlug(name) },
            scenario ? "PATCH" : "POST",
          ),
        );
        await onSaved(saved);
      }}
    >
      <div className="settings-fields">
        <label className="field">
          <span>{t("name")}</span>
          <input
            required
            maxLength={120}
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {!scenario && (
          <label className="field">
            <span>{t("jobSlug")}</span>
            <input
              aria-describedby="scenario-slug-help"
              required
              maxLength={80}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={slug ?? jobSlug(name)}
              onChange={(event) => setSlug(event.target.value)}
            />
            <small className="muted" id="scenario-slug-help">
              {t("scenarioSlugHint")}
            </small>
          </label>
        )}
      </div>
      <label className="field">
        <span>{t("jobDescription")}</span>
        <textarea
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t("scenarioEnabled")}
      </label>
      <fieldset className="scenario-section">
        <legend>{t("scenarioSteps")}</legend>
        <p className="muted">{t("scenarioStepsHint")}</p>
        {!jobs.length && (
          <p className="notice warning">{t("scenarioNeedsJobs")}</p>
        )}
        <ol className="scenario-rows">
          {steps.map((step, index) => (
            <li key={index} className="scenario-row">
              <Select
                aria-label={t("stepJob").replace("{index}", String(index + 1))}
                value={step.job}
                onChange={(event) =>
                  setSteps((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, job: event.target.value } : item,
                    ),
                  )
                }
              >
                {jobs.map((job) => (
                  <option key={job.slug} value={job.slug}>
                    {job.name} · {job.environment}
                  </option>
                ))}
              </Select>
              {index === 0 ? (
                <span className="muted scenario-first">{t("stepFirst")}</span>
              ) : (
                <Select
                  aria-label={t("stepCondition").replace(
                    "{index}",
                    String(index + 1),
                  )}
                  value={step.run_if}
                  onChange={(event) =>
                    setSteps((current) =>
                      current.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              run_if: event.target.value as StepCondition,
                            }
                          : item,
                      ),
                    )
                  }
                >
                  {(Object.keys(conditionKeys) as StepCondition[]).map(
                    (condition) => (
                      <option key={condition} value={condition}>
                        {t(conditionKeys[condition])}
                      </option>
                    ),
                  )}
                </Select>
              )}
              <div className="row">
                <button
                  type="button"
                  className="icon"
                  aria-label={t("moveUp")}
                  title={t("moveUp")}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label={t("moveDown")}
                  title={t("moveDown")}
                  disabled={index === steps.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label={t("removeStep")}
                  title={t("removeStep")}
                  disabled={steps.length === 1}
                  onClick={() =>
                    setSteps((current) => current.filter((_, i) => i !== index))
                  }
                >
                  <X size={14} />
                </button>
              </div>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="button secondary small"
          disabled={!jobs.length || steps.length >= 20}
          onClick={() =>
            setSteps((current) => [
              ...current,
              { job: jobs[0].slug, run_if: "success" },
            ])
          }
        >
          <Plus size={14} />
          {t("addStep")}
        </button>
      </fieldset>
      <fieldset className="scenario-section">
        <legend>{t("launchValues")}</legend>
        <p className="muted">{t("launchValuesChoiceHint")}</p>
        {offered.error && <p className="notice error">{offered.error}</p>}
        {offered.data && !Object.keys(variables).length && (
          <p className="muted">{t("noLaunchValues")}</p>
        )}
        {Object.entries(variables).map(([variable, item]) => (
          <label className="check-row" key={variable}>
            <input
              type="checkbox"
              checked={parameters.includes(variable)}
              onChange={(event) =>
                setParameters((current) =>
                  event.target.checked
                    ? [...current, variable]
                    : current.filter((value) => value !== variable),
                )
              }
            />
            <code>{variable}</code> <span className="muted">{item.type}</span>
            {item.description && (
              <span className="muted"> · {item.description}</span>
            )}
          </label>
        ))}
      </fieldset>
      <fieldset className="scenario-section">
        <legend>{t("scenarioTriggers")}</legend>
        <p className="muted">{t("scenarioTriggersHint")}</p>
        {schedules.map((schedule, index) => (
          <ScheduleRow
            key={index}
            index={index}
            schedule={schedule}
            onChange={(value) =>
              setSchedules((current) =>
                current.map((item, i) => (i === index ? value : item)),
              )
            }
            onRemove={() =>
              setSchedules((current) => current.filter((_, i) => i !== index))
            }
          />
        ))}
        <button
          type="button"
          className="button secondary small"
          disabled={schedules.length >= 10}
          onClick={() =>
            setSchedules((current) => [
              ...current,
              { cron: "0 2 * * *", timezone: browserZone() },
            ])
          }
        >
          <Plus size={14} />
          {t("addSchedule")}
        </button>
        <label className="check-row">
          <input
            type="checkbox"
            checked={webhook}
            onChange={(event) => setWebhook(event.target.checked)}
          />
          {t("acceptWebhooks")}
        </label>
        <small className="muted">{t("acceptWebhooksHint")}</small>
      </fieldset>
      <fieldset className="scenario-section">
        <legend>{t("notifications")}</legend>
        {!destinations.length ? (
          <p className="muted">{t("noDestinations")}</p>
        ) : (
          <p className="muted">{t("scenarioNotificationsHint")}</p>
        )}
        {notifications.map((rule, index) => (
          <div className="scenario-row" key={index}>
            <Select
              aria-label={t("notificationDestination")}
              value={rule.destination}
              onChange={(event) =>
                setNotifications((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, destination: event.target.value }
                      : item,
                  ),
                )
              }
            >
              {!destinations.some((item) => item.id === rule.destination) && (
                <option value={rule.destination}>{rule.destination}</option>
              )}
              {destinations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ·{" "}
                  {t(
                    item.kind === "email"
                      ? "destinationEmail"
                      : "destinationWebhook",
                  )}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t("notificationRule")}
              value={rule.on}
              onChange={(event) =>
                setNotifications((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, on: event.target.value as NotifyOn }
                      : item,
                  ),
                )
              }
            >
              {(Object.keys(notifyKeys) as NotifyOn[]).map((on) => (
                <option key={on} value={on}>
                  {t(notifyKeys[on])}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className="icon"
              aria-label={t("removeNotification")}
              title={t("removeNotification")}
              onClick={() =>
                setNotifications((current) =>
                  current.filter((_, i) => i !== index),
                )
              }
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button secondary small"
          disabled={!destinations.length || notifications.length >= 10}
          onClick={() =>
            setNotifications((current) => [
              ...current,
              { destination: destinations[0].id, on: "failure" },
            ])
          }
        >
          <Plus size={14} />
          {t("addNotification")}
        </button>
      </fieldset>
    </ModalForm>
  );
}

function ScheduleRow({
  index,
  schedule,
  onChange,
  onRemove,
}: {
  index: number;
  schedule: ScenarioSchedule;
  onChange: (schedule: ScenarioSchedule) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const cron = useDebounced(schedule.cron.trim());
  const preview = useApiResource<{ next: string[] }>(
    cron
      ? withQuery("/schedule-preview", { cron, timezone: schedule.timezone })
      : null,
  );
  const zones = timeZones.includes(schedule.timezone)
    ? timeZones
    : [schedule.timezone, ...timeZones];
  return (
    <div className="scenario-schedule">
      <div className="scenario-row">
        <input
          aria-label={t("scheduleCron").replace("{index}", String(index + 1))}
          aria-describedby={`schedule-preview-${index}`}
          required
          maxLength={200}
          spellCheck={false}
          value={schedule.cron}
          onChange={(event) =>
            onChange({ ...schedule, cron: event.target.value })
          }
        />
        <Select
          aria-label={t("scheduleTimeZone")}
          value={schedule.timezone}
          onChange={(event) =>
            onChange({ ...schedule, timezone: event.target.value })
          }
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>
        <button
          type="button"
          className="icon"
          aria-label={t("removeSchedule")}
          title={t("removeSchedule")}
          onClick={onRemove}
        >
          <X size={14} />
        </button>
      </div>
      <small
        id={`schedule-preview-${index}`}
        className={preview.error ? "schedule-error" : "muted"}
      >
        {preview.error
          ? preview.error
          : preview.data
            ? `${t("nextOccurrences")} ${preview.data.next
                .map((item) => zonedTime(item, schedule.timezone))
                .join(" · ")}`
            : t("scheduleSyntax")}
      </small>
    </div>
  );
}
