import { useEffect, useState } from "react";
import { api } from "./api";
import { useT } from "./i18n";

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
  const [status, setStatus] = useState<{
    state: keyof typeof states;
    python: string;
    duckdb: string;
    error?: string;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await api<NonNullable<typeof status>>(
          `/projects/${project}/python/environment`,
        );
        if (!stopped) {
          setStatus(result);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      }
      if (!stopped) timer = setTimeout(read, 2000);
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [project]);
  return (
    <div className="settings-card">
      <h2>{t("pythonEnvironments")}</h2>
      <p className="muted">{t("pythonEnvironmentHint")}</p>
      <p role="status">{status ? t(states[status.state]) : t("loading")}</p>
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
