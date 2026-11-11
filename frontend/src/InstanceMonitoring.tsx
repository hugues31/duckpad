import { useState, type ReactNode } from "react";
import { Info, RefreshCw } from "lucide-react";
import { api, withQuery } from "./api";
import { useLanguage, useT } from "./i18n";
import Select from "./Select";
import { useApiResource, useResource } from "./useApiResource";

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

function CardHeading({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <div className="monitoring-card-heading">
      <h3>{title}</h3>
      {children}
      <button
        type="button"
        className="icon monitoring-info"
        aria-label={hint}
        data-tooltip={hint}
      >
        <Info size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function InstanceMonitoring() {
  const t = useT();
  const language = useLanguage();
  const [refreshSeconds, setRefreshSeconds] = useState(5);
  const [level, setLevel] = useState("debug");
  const [query, setQuery] = useState("");
  const interval = refreshSeconds ? refreshSeconds * 1000 : undefined;
  const summary = useApiResource<Summary>("/monitoring", { interval });
  const logsPath = withQuery("/monitoring/logs", { level, q: query });
  // The current entries stay visible while other filters load.
  const logs = useResource<Logs>(
    "/monitoring/logs",
    (signal) => api<Logs>(logsPath, { signal }),
    { refresh: logsPath, interval, delay: query ? 250 : 0 },
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
        <div className="monitoring-refresh">
          <button
            className="button secondary small"
            disabled={summary.pending || logs.pending}
            onClick={() => {
              summary.reload();
              logs.reload();
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {t("monitoringRefresh")}
          </button>
          <Select
            aria-label={t("monitoringRefreshInterval")}
            title={t("monitoringRefreshInterval")}
            value={refreshSeconds}
            onChange={(event) => setRefreshSeconds(Number(event.target.value))}
          >
            <option value={0}>{t("monitoringRefreshManual")}</option>
            {[5, 10, 30, 60, 300].map((seconds) => (
              <option key={seconds} value={seconds}>
                {new Intl.NumberFormat(language, {
                  style: "unit",
                  unit: seconds < 60 ? "second" : "minute",
                  unitDisplay: "narrow",
                }).format(seconds < 60 ? seconds : seconds / 60)}
              </option>
            ))}
          </Select>
        </div>
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
            <CardHeading
              title={t("monitoringDisk")}
              hint={t("monitoringDiskHint")}
            />
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
          </section>
          <section className="settings-card" aria-label={t("monitoringMemory")}>
            <CardHeading
              title={t("monitoringMemory")}
              hint={t("monitoringMemoryHint")}
            />
            <strong className="monitoring-value">
              {bytes(data.resources.memory_bytes)}
            </strong>
            <p>
              {t("monitoringMemoryTotal").replace(
                "{total}",
                bytes(data.resources.memory_total_bytes),
              )}
            </p>
          </section>
          <section
            className="settings-card"
            aria-label={t("monitoringBackend")}
          >
            <CardHeading
              title={t("monitoringBackend")}
              hint={t("monitoringProcessHint")}
            />
            <strong className="monitoring-value">
              {bytes(data.process_memory_bytes)}
            </strong>
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
        <CardHeading title={t("monitoringLogs")} hint={t("monitoringLogsHint")}>
          <div
            className="monitoring-levels"
            role="group"
            aria-label={t("monitoringLogLevels")}
          >
            {["debug", "info", "warning", "error", "critical"].map((level) => (
              <LogLevel key={level} level={level} />
            ))}
          </div>
        </CardHeading>
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
                  <time dateTime={entry.timestamp}>
                    {time(entry.timestamp)}
                  </time>
                  <LogLevel level={entry.level} />
                  <span className="monitoring-logger" title={entry.logger}>
                    {entry.logger}
                  </span>
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
