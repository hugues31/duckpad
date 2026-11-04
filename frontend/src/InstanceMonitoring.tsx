import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { withQuery } from "./api";
import { useLanguage, useT } from "./i18n";
import { useApiResource } from "./useApiResource";

interface Summary {
  sampled_at: string;
  version: string;
  uptime_seconds: number;
  disk: { total_bytes: number; free_bytes: number; used_bytes: number } | null;
  process_memory_bytes: number | null;
  resources: {
    memory_bytes: number | null;
    memory_total_bytes: number | null;
  };
}

interface Logs {
  entries: {
    id: number;
    timestamp: string;
    level: string;
    logger: string;
    message: string;
    truncated: boolean;
  }[];
  matched: number;
  retained: number;
  capacity: number;
}

function LogLevel({ level }: { level: string }) {
  return (
    <span className={`monitoring-level monitoring-level-${level}`}>
      {level.toUpperCase()}
    </span>
  );
}

export default function InstanceMonitoring() {
  const t = useT();
  const language = useLanguage();
  const [automatic, setAutomatic] = useState(true);
  const [level, setLevel] = useState("debug");
  const [query, setQuery] = useState("");
  const interval = automatic ? 5000 : undefined;
  const summary = useApiResource<Summary>("/monitoring", { interval });
  const logs = useApiResource<Logs>(
    withQuery("/monitoring/logs", { level, q: query }),
    { interval, delay: query ? 250 : 0 },
  );
  const data = summary.data;
  const disk = data?.disk;
  const diskUsed = disk ? 100 * (1 - disk.free_bytes / disk.total_bytes) : null;
  const bytes = (value: number | null | undefined) => {
    if (value == null) return t("monitoringUnavailable");
    const unit = value >= 1024 ** 3 ? "GiB" : "MiB";
    const amount = value / 1024 ** (unit === "GiB" ? 3 : 2);
    return `${amount.toLocaleString(language, { maximumFractionDigits: 1 })} ${unit}`;
  };
  const time = (value: string) => new Date(value).toLocaleString(language);
  return (
    <section className="instance-monitoring" aria-label={t("monitoring")}>
      <header className="monitoring-heading">
        <h2>{t("monitoring")}</h2>
        <p className="muted">{t("monitoringDescription")}</p>
      </header>
      <div
        className="monitoring-toolbar"
        role="group"
        aria-label={t("monitoringRefreshControls")}
      >
        <label className="monitoring-auto">
          <input
            type="checkbox"
            checked={automatic}
            onChange={(event) => setAutomatic(event.target.checked)}
          />
          {t("monitoringAutoRefresh")}
        </label>
        <button
          className="button small"
          disabled={summary.pending || logs.pending}
          onClick={() => {
            summary.reload();
            logs.reload();
          }}
        >
          <RefreshCw size={16} aria-hidden="true" />
          {t("monitoringRefresh")}
        </button>
        {data && (
          <time
            className="muted monitoring-updated"
            dateTime={data.sampled_at}
            title={time(data.sampled_at)}
          >
            {t("monitoringUpdated").replace(
              "{time}",
              new Date(data.sampled_at).toLocaleTimeString(language),
            )}
          </time>
        )}
      </div>
      {summary.error && (
        <p className="notice error" role="alert">
          {summary.error}
        </p>
      )}
      {!data && summary.pending && <p role="status">{t("loading")}</p>}
      {data && (
        <div className="monitoring-metrics">
          <section className="settings-card" aria-label={t("monitoringDisk")}>
            <h3>{t("monitoringDisk")}</h3>
            <strong className="monitoring-value">
              {bytes(disk?.free_bytes)}
            </strong>
            <p>
              {t("monitoringDiskFree").replace(
                "{total}",
                bytes(disk?.total_bytes),
              )}
            </p>
            {diskUsed !== null && (
              <progress
                max={100}
                value={diskUsed}
                aria-label={t("monitoringDiskUsed")}
              />
            )}
            {diskUsed !== null && diskUsed >= 90 && (
              <p className="notice warning" role="status">
                {t("monitoringDiskLow")}
              </p>
            )}
            <p className="muted">{t("monitoringDiskHint")}</p>
          </section>
          <section className="settings-card" aria-label={t("monitoringMemory")}>
            <h3>{t("monitoringMemory")}</h3>
            <strong className="monitoring-value">
              {bytes(data.resources.memory_bytes)}
            </strong>
            <p>
              {t("monitoringMemoryTotal").replace(
                "{total}",
                bytes(data.resources.memory_total_bytes),
              )}
            </p>
            <p className="muted">{t("monitoringMemoryHint")}</p>
          </section>
          <section
            className="settings-card"
            aria-label={t("monitoringBackend")}
          >
            <h3>{t("monitoringBackend")}</h3>
            <strong className="monitoring-value">
              {bytes(data.process_memory_bytes)}
            </strong>
            <p className="muted">{t("monitoringProcessHint")}</p>
            <p>
              {t("monitoringUptime")
                .replace(
                  "{hours}",
                  String(Math.floor(data.uptime_seconds / 3600)),
                )
                .replace(
                  "{minutes}",
                  String(Math.floor(data.uptime_seconds / 60) % 60),
                )}
            </p>
            <p>Duckpad {data.version}</p>
          </section>
        </div>
      )}
      <section
        className="settings-card monitoring-logs"
        aria-label={t("monitoringLogs")}
      >
        <div className="monitoring-log-heading">
          <h3>{t("monitoringLogs")}</h3>
          <div
            className="monitoring-levels"
            role="group"
            aria-label={t("monitoringLogLevels")}
          >
            {["debug", "info", "warning", "error", "critical"].map((level) => (
              <LogLevel key={level} level={level} />
            ))}
          </div>
        </div>
        <p className="muted">{t("monitoringLogsHint")}</p>
        <div className="monitoring-filters">
          <label className="field">
            <span>{t("monitoringLogLevel")}</span>
            <select
              value={level}
              onChange={(event) => setLevel(event.target.value)}
            >
              <option value="debug">{t("all")}</option>
              <option value="info">{t("monitoringLogInfo")}</option>
              <option value="warning">{t("monitoringLogWarning")}</option>
              <option value="error">{t("monitoringLogError")}</option>
              <option value="critical">{t("monitoringLogCritical")}</option>
            </select>
          </label>
          <label className="field">
            <span>{t("monitoringLogSearch")}</span>
            <input
              type="search"
              maxLength={200}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        {logs.error && (
          <p className="notice error" role="alert">
            {logs.error}
          </p>
        )}
        {logs.pending && !logs.data && <p role="status">{t("loading")}</p>}
        {logs.data && (
          <>
            <p className="muted" role="status">
              {t("monitoringLogCount")
                .replace("{shown}", String(logs.data.entries.length))
                .replace("{matched}", String(logs.data.matched))
                .replace("{retained}", String(logs.data.retained))
                .replace("{capacity}", String(logs.data.capacity))}
            </p>
            {!logs.data.entries.length && <p>{t("monitoringLogsEmpty")}</p>}
            <ol
              className="monitoring-log-list"
              aria-label={t("monitoringLogs")}
            >
              {logs.data.entries.map((entry) => (
                <li key={entry.id}>
                  <div className="monitoring-log-meta">
                    <time dateTime={entry.timestamp}>
                      {time(entry.timestamp)}
                    </time>
                    <LogLevel level={entry.level} />
                    <span>{entry.logger}</span>
                  </div>
                  <pre>{entry.message}</pre>
                  {entry.truncated && (
                    <small className="muted">
                      {t("monitoringLogTruncated")}
                    </small>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
    </section>
  );
}
