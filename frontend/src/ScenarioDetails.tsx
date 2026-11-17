import { ChevronRight, Play, Square } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api, errorDetail, send, withQuery } from "./api";
import { RunDetails } from "./HistoryPanel";
import { useT } from "./i18n";
import { ConfirmModal, Modal, ModalForm } from "./modals";
import { worktreeUrl } from "./navigation";
import RunRequester from "./RunRequester";
import {
  activeScenario,
  conditionKeys,
  notifyKeys,
  runSeconds,
  scenarioWebhook,
  shortDuration,
  triggerKeys,
  type Destination,
  type Scenario,
  type ScenarioRun,
  zonedTime,
} from "./scenarioTypes";
import type { Environment, Json, Project, Run } from "./types";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import { useRunHistory } from "./useRunHistory";
import { VariableValueInput } from "./VariableFields";
import { formatVariableValue } from "./variables";

type Values = Record<string, Json>;

export function ScenarioDetails({
  scenario,
  project,
  destinations,
  onChanged,
  onEdit,
  onDelete,
}: {
  scenario: Scenario;
  project: Project;
  destinations: Destination[];
  onChanged: () => Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const action = useAsyncAction();
  const runs = useRunHistory<ScenarioRun>(
    withQuery(`/scenarios/${scenario.slug}/runs`, { limit: 20 }),
    2000,
  );
  const [launching, setLaunching] = useState(false);
  const [confirming, setConfirming] = useState<{
    values: Values;
    environments: Environment[];
  } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const busy = !!scenario.active_run || activeScenario(scenario.last_run);
  const canRun = project.role !== "reader";
  const admin = project.role === "admin";
  const launch = async (values: Values, confirmed = false) => {
    try {
      await api(
        `/scenarios/${scenario.slug}/runs`,
        send({ parameters: values, confirmed }),
      );
    } catch (error) {
      const environments = errorDetail(error).confirmation_required as
        Environment[] | undefined;
      if (!environments) throw error;
      setConfirming({ values, environments });
      return;
    }
    runs.reload();
    await onChanged();
  };
  const toggle = () =>
    action.run(async () => {
      await api(
        `/scenarios/${scenario.slug}`,
        send(
          {
            name: scenario.name,
            description: scenario.description,
            enabled: !scenario.enabled,
            steps: scenario.steps.map(({ job, run_if }) => ({ job, run_if })),
            parameters: scenario.parameters.map((item) => item.name),
            schedules: scenario.schedules.map(({ cron, timezone }) => ({
              cron,
              timezone,
            })),
            webhook: scenario.webhook,
            notifications: scenario.notifications,
            revision: scenario.revision,
          },
          "PATCH",
        ),
      );
      await onChanged();
    });
  const destinationName = (identity: string) =>
    destinations.find((item) => item.id === identity)?.name || identity;
  return (
    <section
      className="job-details scenario-details settings-card"
      aria-label={scenario.name}
    >
      <div className="page-heading">
        <div>
          <h2>
            {scenario.name}{" "}
            {!scenario.enabled && (
              <span className="badge neutral">{t("scenarioDisabled")}</span>
            )}
          </h2>
          {scenario.description && <p>{scenario.description}</p>}
        </div>
        <div className="row gap">
          {canRun &&
            (busy ? (
              <button
                className="button stop"
                disabled={
                  action.pending || scenario.last_run?.status === "canceling"
                }
                onClick={() =>
                  void action.run(async () => {
                    await api(
                      `/scenario-runs/${scenario.active_run || scenario.last_run!.id}/cancel`,
                      send({}),
                    );
                    runs.reload();
                    await onChanged();
                  })
                }
              >
                <Square size={14} />
                {t("stop")}
              </button>
            ) : (
              <button
                className="button primary"
                disabled={action.pending}
                onClick={() =>
                  scenario.parameters.length
                    ? setLaunching(true)
                    : void action.run(() => launch({}))
                }
              >
                <Play size={14} />
                {t("runScenario")}
              </button>
            ))}
        </div>
      </div>
      {action.error && (
        <p className="notice error" role="alert">
          {action.error}
        </p>
      )}
      {admin && (
        <div className="row gap">
          <button className="button secondary" onClick={onEdit}>
            {t("edit")}
          </button>
          <button
            className="button secondary"
            disabled={action.pending}
            onClick={() => void toggle()}
          >
            {t(scenario.enabled ? "disableScenario" : "enableScenario")}
          </button>
          <button
            className="button secondary danger"
            disabled={busy}
            onClick={onDelete}
          >
            {t("deleteScenario")}
          </button>
        </div>
      )}
      <dl className="scenario-overview">
        <dt>{t("scenarioSteps")}</dt>
        <dd>
          <ol className="scenario-steps">
            {scenario.steps.map((step, index) => (
              <li key={index}>
                <strong>{step.name ?? step.job}</strong>
                {step.environment && (
                  <span className="muted"> · {step.environment}</span>
                )}
                {index > 0 && (
                  <span className="badge neutral">
                    {t(conditionKeys[step.run_if])}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </dd>
        <dt>{t("scenarioTriggers")}</dt>
        <dd>
          <ul className="scenario-list">
            <li>{t("scenarioManual")}</li>
            {scenario.schedules.map((schedule, index) => (
              <li key={index}>
                <code>{schedule.cron}</code> · {schedule.timezone}
                {scenario.enabled && schedule.next && (
                  <span className="muted">
                    {" · "}
                    {t("nextOccurrence")}{" "}
                    {zonedTime(schedule.next, schedule.timezone)}
                  </span>
                )}
              </li>
            ))}
            {scenario.webhook && <li>{t("scenarioWebhook")}</li>}
          </ul>
          {!scenario.enabled &&
            (scenario.schedules.length > 0 || scenario.webhook) && (
              <small className="muted">{t("scenarioDisabledHint")}</small>
            )}
        </dd>
        {scenario.parameters.length > 0 && (
          <>
            <dt>{t("launchValues")}</dt>
            <dd>
              <ul className="scenario-list">
                {scenario.parameters.map((item) => (
                  <li key={item.name}>
                    <code>{item.name}</code>{" "}
                    <span className="muted">{item.type}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>{t("notifications")}</dt>
        <dd>
          {scenario.notifications.length ? (
            <ul className="scenario-list">
              {scenario.notifications.map((item, index) => (
                <li key={index}>
                  {destinationName(item.destination)}{" "}
                  <span className="muted">· {t(notifyKeys[item.on])}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted">{t("noNotifications")}</span>
          )}
        </dd>
      </dl>
      {scenario.webhook && (
        <details>
          <summary>{t("scenarioWebhookCall")}</summary>
          <p>{t("scenarioWebhookHint")}</p>
          <pre className="expression">
            {scenarioWebhook(scenario.slug, window.location.origin)}
          </pre>
        </details>
      )}
      <h3>{t("scenarioRuns")}</h3>
      {runs.error && <p className="notice error">{runs.error}</p>}
      {runs.data?.length === 0 && <p className="muted">{t("noHistory")}</p>}
      {runs.data?.map((run) => (
        <ScenarioRunRow key={run.id} run={run} onOpenRun={setRunId} />
      ))}
      {runs.hasMore && (
        <button
          className="button secondary"
          disabled={runs.loadingMore}
          onClick={() => void runs.loadMore()}
        >
          {t("loadMore")}
        </button>
      )}
      {launching && (
        <LaunchModal
          scenario={scenario}
          onClose={() => setLaunching(false)}
          onLaunch={launch}
        />
      )}
      {confirming && (
        <ConfirmModal
          title={t("runScenario")}
          confirmLabel={t("runScenario")}
          onClose={() => setConfirming(null)}
          onConfirm={() => launch(confirming.values, true)}
        >
          <p>{t("scenarioConfirmEnvironments")}</p>
          <ul className="scenario-list">
            {confirming.environments.map((environment) => (
              <li key={environment.id}>
                <strong>{environment.label}</strong>
              </li>
            ))}
          </ul>
        </ConfirmModal>
      )}
      {runId && <StepRunModal runId={runId} onClose={() => setRunId(null)} />}
    </section>
  );
}

function LaunchModal({
  scenario,
  onClose,
  onLaunch,
}: {
  scenario: Scenario;
  onClose: () => void;
  onLaunch: (values: Values) => Promise<void>;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, Json | undefined>>({});
  return (
    <ModalForm
      title={t("runScenario")}
      submitLabel={t("runScenario")}
      onClose={onClose}
      onSubmit={() =>
        onLaunch(
          Object.fromEntries(
            Object.entries(values).filter(([, value]) => value !== undefined),
          ) as Values,
        )
      }
    >
      <p className="muted">{t("launchValuesHint")}</p>
      {scenario.parameters.map((item) => (
        <label className="field" key={item.name}>
          <span>
            {item.name} <small>{item.type}</small>
          </span>
          <VariableValueInput
            type={item.type}
            label={item.name}
            placeholder={t("projectValue")}
            value={values[item.name]}
            onChange={(value) =>
              setValues((current) => ({ ...current, [item.name]: value }))
            }
          />
        </label>
      ))}
    </ModalForm>
  );
}

function StepRunModal({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const t = useT();
  const detail = useApiResource<Run>(`/runs/${runId}`, {
    interval: 2000,
    nextInterval: (value) =>
      ["preparing", "running", "canceling"].includes(value.status)
        ? 2000
        : false,
  });
  return (
    <Modal title={t("goToRun")} onClose={onClose} wide>
      <div className="modal-content">
        {detail.data ? (
          <>
            <p>
              <span className={`badge ${detail.data.status}`}>
                {t(detail.data.status)}
              </span>{" "}
              · <code>{detail.data.id}</code>
            </p>
            <RunDetails run={detail.data} onClose={onClose} />
          </>
        ) : detail.error ? (
          <p className="notice error" role="alert">
            {detail.error}
          </p>
        ) : (
          <p>{t("loading")}</p>
        )}
      </div>
    </Modal>
  );
}

function ScenarioRunRow({
  run,
  onOpenRun,
}: {
  run: ScenarioRun;
  onOpenRun: (id: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const values = Object.entries(run.parameters || {});
  const source = run.trigger.source;
  return (
    <div className={`scenario-run ${open ? "open" : ""}`}>
      <button
        className="history-row"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={14} aria-hidden="true" className="disclosure" />
        <span className={`badge ${run.status}`}>
          {t(scenarioStatusKey(run.status))}
        </span>
        <span className="grow">
          {new Date(run.started).toLocaleString()} · {t(triggerKeys[source])}
          {source === "schedule" && run.trigger.cron && (
            <>
              {" "}
              <code>{run.trigger.cron}</code>
            </>
          )}
          {run.requester && source !== "schedule" && (
            <>
              {" · "}
              <RunRequester requester={run.requester} />
            </>
          )}
        </span>
        {run.status !== "rejected" && run.status !== "missed" && (
          <span className="muted">{shortDuration(runSeconds(run))}</span>
        )}
      </button>
      {open && (
        <div className="scenario-run-details">
          {run.error && (
            <p
              className={`notice ${run.status === "rejected" || run.status === "missed" ? "warning" : "error"}`}
            >
              {run.status === "missed" && run.trigger.missed
                ? t("scenarioMissedOccurrences")
                    .replace("{count}", String(run.trigger.missed))
                    .replace(
                      "{time}",
                      new Date(run.trigger.occurrence!).toLocaleString(),
                    )
                : run.error}
            </p>
          )}
          {run.trigger.delivery && (
            <p className="muted">
              {t("webhookDelivery")}: <code>{run.trigger.delivery}</code>
            </p>
          )}
          {run.trigger.occurrence && run.status !== "missed" && (
            <p className="muted">
              {t("scheduledFor")}{" "}
              {new Date(run.trigger.occurrence).toLocaleString()} (
              {run.trigger.timezone})
            </p>
          )}
          {values.length > 0 && (
            <p>
              {t("launchValues")}:{" "}
              {values.map(([name, value], index) => (
                <span key={name}>
                  {index > 0 && ", "}
                  <code>{name}</code> = {formatVariableValue(value)}
                </span>
              ))}
            </p>
          )}
          {run.steps.length > 0 && (
            <ol className="scenario-step-runs">
              {run.steps.map((step, index) => (
                <li key={index}>
                  <div className="row gap">
                    <span className={`badge ${step.status}`}>
                      {t(scenarioStatusKey(step.status))}
                    </span>
                    <strong className="grow">{step.name}</strong>
                    {step.environment && (
                      <span className="muted">{step.environment}</span>
                    )}
                    {step.duration !== undefined && (
                      <span className="muted">
                        {shortDuration(step.duration)}
                      </span>
                    )}
                    {step.run && (
                      <button
                        className="button secondary small"
                        onClick={() => onOpenRun(step.run!)}
                      >
                        {t("runLog")}
                      </button>
                    )}
                    {step.run && step.worktree && (
                      <Link
                        className="button secondary small"
                        to={worktreeUrl(
                          step.worktree,
                          "flow",
                          step.environment,
                        )}
                      >
                        {t("openResults")}
                      </Link>
                    )}
                  </div>
                  {step.error && <p className="notice error">{step.error}</p>}
                </li>
              ))}
            </ol>
          )}
          {run.notifications?.length > 0 && (
            <ul className="scenario-list">
              {run.notifications.map((item, index) => (
                <li key={index}>
                  {t("notification")} {item.name}:{" "}
                  <span
                    className={`badge ${item.status === "sent" ? "success" : "failed"}`}
                  >
                    {t(
                      item.status === "sent"
                        ? "notificationSent"
                        : "notificationFailed",
                    )}
                  </span>
                  {item.error && <span className="muted"> {item.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function scenarioStatusKey(status: string) {
  const keys = {
    rejected: "triggerRejected",
    missed: "occurrenceMissed",
    skipped: "stepSkipped",
    refused: "stepRefused",
    pending: "pending",
  } as const;
  return (
    keys[status as keyof typeof keys] ??
    (status as
      | "running"
      | "canceling"
      | "success"
      | "failed"
      | "canceled"
      | "interrupted"
      | "partial_failure")
  );
}
