import { CircleAlert, CircleCheck, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { seconds } from "./results";
import { useApiResource } from "./useApiResource";
import { useFollowScroll } from "./useFollowScroll";

const states = {
  unprepared: "pythonEnvironmentUnprepared",
  resolving: "pythonEnvironmentResolving",
  locked: "pythonEnvironmentLocked",
  installing: "pythonEnvironmentInstalling",
  ready: "pythonEnvironmentReady",
  error: "pythonEnvironmentError",
} as const;

const stages = {
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

interface PreparationStatus {
  state: keyof typeof states;
  stage?: keyof typeof stages;
  operation?: string;
  elapsed_seconds?: number;
  python: string;
  duckdb: string;
  error?: string | null;
  log?: string;
  log_truncated?: boolean;
}

/** The latest preparation, polled every second while it runs or while `active`. */
function usePreparation(project: string, active = false) {
  const [busy, setBusy] = useState(false);
  const resource = useApiResource<PreparationStatus>(
    `/projects/${project}/python/environment`,
    { interval: busy || active ? 1000 : 5000, refresh: Number(active) },
  );
  const preparing =
    resource.data?.state === "resolving" ||
    resource.data?.state === "installing";
  if (preparing !== busy) setBusy(preparing);
  return { ...resource, preparing };
}

/** Progress, error and live installer output, following the end of the log. */
function PreparationDetails({
  status,
  preparing,
  open,
  onToggle,
}: {
  status: PreparationStatus;
  preparing: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  const t = useT();
  const { log, followLog, restore } = useFollowScroll<HTMLPreElement>(
    open ?? true,
    40,
  );
  return (
    <>
      {preparing && <progress aria-label={t("pythonEnvironmentProgress")} />}
      {status.error && <pre className="notice error">{status.error}</pre>}
      {(preparing || status.log) && (
        <details
          open={open}
          onToggle={(event) => {
            restore();
            onToggle?.(event.currentTarget.open);
          }}
        >
          <summary>{t("pythonEnvironmentLogs")}</summary>
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
        </details>
      )}
    </>
  );
}

/** The project's latest preparation, with its log, in Python settings. */
export default function PythonEnvironmentStatus({
  project,
}: {
  project: string;
}) {
  const t = useT();
  const { data: status, error, preparing } = usePreparation(project);
  const label = status
    ? t(preparing && status.stage ? stages[status.stage] : states[status.state])
    : t("loading");
  return (
    <section
      className="settings-card python-preparation"
      aria-label={t("pythonEnvironments")}
    >
      <h2>{t("pythonEnvironments")}</h2>
      <p className="muted">{t("pythonEnvironmentHint")}</p>
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
  active,
}: {
  project: string;
  active: boolean;
}) {
  const t = useT();
  const { data: status, preparing } = usePreparation(project, active);
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
      ? stages[status.stage]
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
