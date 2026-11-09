import { CircleAlert, CircleCheck, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { seconds } from "./results";
import type { PreparationStatus, Run } from "./types";
import { useApiResource } from "./useApiResource";
import { useFollowScroll } from "./useFollowScroll";

const states = {
  unprepared: "pythonEnvironmentUnprepared",
  resolving: "pythonEnvironmentResolving",
  locked: "pythonEnvironmentLocked",
  installing: "pythonEnvironmentInstalling",
  ready: "pythonEnvironmentReady",
  error: "pythonEnvironmentError",
  canceled: "canceled",
} as const;

export const preparationStages = {
  waiting: "pythonEnvironmentWaiting",
  runtime: "pythonEnvironmentRuntime",
  resolving: "pythonEnvironmentResolving",
  installing: "pythonEnvironmentInstalling",
  sdk: "pythonEnvironmentSdk",
  cached: "pythonEnvironmentCached",
} as const;

/** The workspace notice names the outcome briefly; settings explain it. */
const outcomes = {
  locked: "pythonEnvironmentResolved",
  ready: "pythonEnvironmentPrepared",
  error: "pythonEnvironmentError",
} as const;

/** The latest preparation, polled every second while it runs or while `active`. */
function usePreparation(project: string, worktree?: string, active = false) {
  const [busy, setBusy] = useState(false);
  const resource = useApiResource<PreparationStatus>(
    `/projects/${project}/python/environment${worktree ? `?worktree=${encodeURIComponent(worktree)}` : ""}`,
    { interval: busy || active ? 1000 : 5000, refresh: Number(active) },
  );
  const preparing =
    resource.data?.state === "resolving" ||
    resource.data?.state === "installing";
  if (preparing !== busy) setBusy(preparing);
  return { ...resource, preparing };
}

/**
 * Progress, error and live installer output, following the end of the log.
 * The log has its own toggle unless it already sits in a collapsed run step.
 */
function PreparationDetails({
  status,
  preparing,
  open,
  onToggle,
  collapsible = true,
}: {
  status: PreparationStatus;
  preparing: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  collapsible?: boolean;
}) {
  const t = useT();
  const { log, followLog, restore } = useFollowScroll<HTMLPreElement>(
    open ?? true,
    40,
  );
  const output = (
    <>
      {status.log_truncated && (
        <p className="muted">{t("pythonEnvironmentLogTail")}</p>
      )}
      <pre
        ref={log}
        role="log"
        aria-label={t("pythonEnvironmentLogs")}
        onScroll={followLog}
      >
        {status.log || t("pythonEnvironmentLogWaiting")}
      </pre>
    </>
  );
  return (
    <>
      {preparing && <progress aria-label={t("pythonEnvironmentProgress")} />}
      {status.error && <pre className="notice error">{status.error}</pre>}
      {(preparing || status.log) &&
        (collapsible ? (
          <details
            open={open}
            onToggle={(event) => {
              restore();
              onToggle?.(event.currentTarget.open);
            }}
          >
            <summary>{t("pythonEnvironmentLogs")}</summary>
            {output}
          </details>
        ) : (
          output
        ))}
    </>
  );
}

/** The selected branch's latest preparation, with its log, in Python settings. */
export default function PythonEnvironmentStatus({
  project,
  worktree,
  branch,
}: {
  project: string;
  worktree?: string;
  branch?: string;
}) {
  const t = useT();
  const { data: status, error, preparing } = usePreparation(project, worktree);
  const label = status
    ? t(
        preparing && status.stage
          ? preparationStages[status.stage]
          : states[status.state],
      )
    : t("loading");
  return (
    <section
      className="settings-card python-preparation"
      aria-label={t("pythonEnvironments")}
    >
      <h2>{t("pythonEnvironments")}</h2>
      {branch && (
        <p className="muted">
          {t("pythonEnvironmentHint").replace("{branch}", branch)}
        </p>
      )}
      {error ? (
        <pre className="notice error">{error}</pre>
      ) : (
        <p role="status">{label}</p>
      )}
      {status && (
        <>
          <p>
            Python {status.python} · DuckDB {status.duckdb}
            {status.elapsed_seconds !== undefined &&
              ` · ${t("pythonEnvironmentDuration").replace(
                "{duration}",
                seconds(status.elapsed_seconds),
              )}`}
          </p>
          {status.stage === "cached" && !preparing && (
            <p className="muted">{t("pythonEnvironmentCached")}</p>
          )}
          <PreparationDetails status={status} preparing={preparing} />
        </>
      )}
    </section>
  );
}

/**
 * A floating notice while the workspace waits for a preparation, then its
 * outcome. Successes close by themselves unless the log is open; failures stay
 * until closed. Results from before the page opened, and cache hits, stay in
 * Python settings.
 */
export function PythonPreparationNotice({
  project,
  worktree,
  active,
}: {
  project: string;
  worktree: string;
  active: boolean;
}) {
  const t = useT();
  const { data: status, preparing } = usePreparation(project, worktree, active);
  const [hidden, setHidden] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(false);
  const operation = status?.operation ?? "";
  if (status && !loaded) {
    setLoaded(true);
    if (!preparing) setHidden(operation);
  }
  const visible =
    !!status &&
    status.state !== "unprepared" &&
    operation !== hidden &&
    (preparing || status.stage !== "cached");
  const succeeded = visible && !preparing && status.state !== "error";
  useEffect(() => {
    if (!succeeded || reading) return;
    const timer = setTimeout(() => setHidden(operation), 5000);
    return () => clearTimeout(timer);
  }, [succeeded, reading, operation]);
  if (!visible) return null;
  const failed = status.state === "error";
  const label =
    preparing && status.stage
      ? preparationStages[status.stage]
      : outcomes[status.state as keyof typeof outcomes] || states[status.state];
  return (
    <section
      className={`python-preparation floating${failed ? " failed" : ""}`}
      aria-label={t("pythonEnvironment")}
    >
      <header>
        {preparing ? (
          <Loader2 className="spin" size={16} aria-hidden="true" />
        ) : failed ? (
          <CircleAlert size={16} aria-hidden="true" />
        ) : (
          <CircleCheck size={16} aria-hidden="true" />
        )}
        <p role="status">
          <strong>{t("pythonEnvironment")}</strong>
          <span>{t(label)}</span>
        </p>
        {status.elapsed_seconds !== undefined && (
          <span className="muted">{seconds(status.elapsed_seconds)}</span>
        )}
        {!preparing && (
          <button
            className="icon"
            aria-label={t("close")}
            title={t("close")}
            onClick={() => setHidden(operation)}
          >
            <X size={16} />
          </button>
        )}
      </header>
      <PreparationDetails
        status={status}
        preparing={preparing}
        open={reading}
        onToggle={setReading}
      />
    </section>
  );
}

/** Outcomes of settled operations, in run status terms. */
const badges = {
  locked: "success",
  ready: "success",
  error: "failed",
  canceled: "canceled",
} as const;

/** The run's resolver and installer operations, as a step beside its nodes. */
export function RunPreparation({ run }: { run: Run }) {
  const t = useT();
  const operations = run.preparation;
  if (!operations?.length) return null;
  const active = ["preparing", "canceling"].includes(run.status);
  const last = operations[operations.length - 1].state;
  // While the run prepares, and after an interrupted operation, the run's status speaks for it.
  const badge =
    !active && last in badges
      ? badges[last as keyof typeof badges]
      : run.status;
  const elapsed = operations.reduce(
    (total, status) => total + (status.elapsed_seconds || 0),
    0,
  );
  return (
    <details className="run-step python-preparation">
      <summary>
        <span className={`badge ${badge}`}>{t(badge)}</span>
        <strong>{t("pythonEnvironment")}</strong>
        {!active && <span className="muted">{seconds(elapsed)}</span>}
      </summary>
      {operations.map((status, index) => {
        const preparing =
          active && ["resolving", "installing"].includes(status.state);
        return (
          <div key={status.operation || index}>
            <p role="status">
              {t(
                preparing && status.stage
                  ? preparationStages[status.stage]
                  : states[status.state],
              )}
              {!preparing &&
                operations.length > 1 &&
                status.elapsed_seconds !== undefined &&
                ` · ${seconds(status.elapsed_seconds)}`}
            </p>
            <PreparationDetails
              status={status}
              preparing={preparing}
              collapsible={false}
            />
          </div>
        );
      })}
    </details>
  );
}
