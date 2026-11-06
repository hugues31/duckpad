import { useState } from "react";
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

export default function PythonEnvironmentStatus({
  project,
}: {
  project: string;
}) {
  const t = useT();
  // Preparation steps change within seconds; settled states rarely do.
  const [busy, setBusy] = useState(false);
  const { data: status, error } = useApiResource<{
    state: keyof typeof states;
    python: string;
    duckdb: string;
    error?: string;
  }>(`/projects/${project}/python/environment`, {
    interval: busy ? 2000 : 15000,
  });
  const preparing =
    status?.state === "resolving" || status?.state === "installing";
  if (preparing !== busy) setBusy(preparing);
  return (
    <div className="settings-card">
      <h2>{t("pythonEnvironments")}</h2>
      <p className="muted">{t("pythonEnvironmentHint")}</p>
      {!error && (
        <p role="status">{status ? t(states[status.state]) : t("loading")}</p>
      )}
      {status && (
        <p>
          Python {status.python} · DuckDB {status.duckdb}
        </p>
      )}
      {(error || status?.error) && (
        <pre className="notice error">{error || status?.error}</pre>
      )}
    </div>
  );
}
