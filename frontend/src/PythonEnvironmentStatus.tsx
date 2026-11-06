import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useT } from "./i18n";
import { useApiResource } from "./useApiResource";

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

interface PreparationStatus {
  state: keyof typeof states;
  stage?: keyof typeof stages;
  operation?: string;
  started_at?: number;
  elapsed_seconds?: number;
  python: string;
  duckdb: string;
  error?: string;
  log?: string;
  log_truncated?: boolean;
}

export default function PythonEnvironmentStatus({
  project,
  compact = false,
  active = false,
}: {
  project: string;
  compact?: boolean;
  active?: boolean;
}) {
  const t = useT();
  const [openedAt] = useState(() => Date.now() / 1000);
  const [dismissed, setDismissed] = useState<string>();
  const [observed, setObserved] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { data: status, error } = useApiResource<PreparationStatus>(
    `/projects/${project}/python/environment`,
    { interval: busy || active ? 1000 : 5000, refresh: Number(active) },
  );
  const preparing =
    status?.state === "resolving" || status?.state === "installing";
  if (preparing !== busy) setBusy(preparing);
  if (preparing && status?.operation !== observed)
    setObserved(status?.operation);
  const log = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (log.current && follow.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [status?.log]);
  // Keep the result visible until dismissed, without resurfacing old builds on every visit.
  if (
    compact &&
    (!status ||
      status.state === "unprepared" ||
      (!preparing &&
        (status.operation === dismissed ||
          (status.operation !== observed &&
            (status.started_at || 0) < openedAt))))
  )
    return null;
  const label = status
    ? t(preparing && status.stage ? stages[status.stage] : states[status.state])
    : t("loading");
  return (
    <section
      className={`settings-card python-preparation${compact ? " floating" : ""}`}
      aria-label={t("pythonEnvironments")}
    >
      <header>
        <h2>{t("pythonEnvironments")}</h2>
        {compact && !preparing && (
          <button
            className="icon-button"
            aria-label={t("close")}
            onClick={() => setDismissed(status?.operation)}
          >
            <X size={16} />
          </button>
        )}
      </header>
      {!compact && <p className="muted">{t("pythonEnvironmentHint")}</p>}
      <p role="status">{label}</p>
      {preparing && <progress aria-label={t("pythonEnvironmentProgress")} />}
      {status?.elapsed_seconds !== undefined && (
        <p className="muted">
          {t("pythonEnvironmentElapsed").replace(
            "{seconds}",
            String(Math.floor(status.elapsed_seconds)),
          )}
        </p>
      )}
      {status?.stage === "cached" && !preparing && (
        <p className="muted">{t("pythonEnvironmentCached")}</p>
      )}
      {!compact && status && (
        <p>
          Python {status.python} · DuckDB {status.duckdb}
        </p>
      )}
      {(error || status?.error) && (
        <pre className="notice error">{error || status?.error}</pre>
      )}
      {(preparing || status?.log) && (
        <details>
          <summary>{t("pythonEnvironmentLogs")}</summary>
          {status?.log_truncated && (
            <p className="muted">{t("pythonEnvironmentLogTail")}</p>
          )}
          <pre
            ref={log}
            role="log"
            aria-live="off"
            aria-label={t("pythonEnvironmentLogs")}
            onScroll={() => {
              const element = log.current;
              if (element)
                follow.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  40;
            }}
          >
            {status?.log || t("pythonEnvironmentLogWaiting")}
          </pre>
        </details>
      )}
    </section>
  );
}
