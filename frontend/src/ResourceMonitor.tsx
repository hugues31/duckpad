import { useCallback, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { usePolling } from "./usePolling";

interface Counters {
  sampled_at: number;
  cpu_seconds: number | null;
  cpu_total_seconds: number | null;
  memory_bytes: number | null;
  memory_total_bytes: number | null;
}
interface Sample {
  at: number;
  cpu: number | null;
  memory: number | null;
  memoryBytes: number | null;
  memoryTotalBytes: number | null;
}
const interval = 2000;
const historyWindow = 120_000;
const format = (value: number | null, unit: string) =>
  value === null ? "—" : `${value.toFixed(1)} ${unit}`;
const percent = (value: number) => Math.min(100, Math.max(0, value));
const formatMemory = (bytes: number | null) =>
  bytes === null
    ? "—"
    : bytes >= 1024 ** 3
      ? format(bytes / 1024 ** 3, "GiB")
      : format(bytes / 1024 ** 2, "MiB");

function Chart({
  samples,
  metric,
  label,
}: {
  samples: Sample[];
  metric: "cpu" | "memory";
  label: string;
}) {
  const t = useT();
  const end = samples.at(-1)?.at ?? 0;
  const commands: string[] = [];
  // Time of the previous point, or null after a missing value.
  let previousAt: number | null = null;
  for (const sample of samples) {
    const value = sample[metric];
    if (value === null) {
      previousAt = null;
      continue;
    }
    const x = 4 + 312 * (1 - (end - sample.at) / historyWindow);
    const y = 74 - (value / 100) * 56;
    const command =
      previousAt !== null && sample.at - previousAt < interval * 3 ? "L" : "M";
    previousAt = sample.at;
    commands.push(`${command}${x.toFixed(1)},${y.toFixed(1)} l0,0`);
  }
  const path = commands.join(" ");
  return (
    <div className={`resource-chart resource-${metric}`}>
      <div className="resource-chart-heading">
        <strong>{label}</strong>
        <span>{format(samples.at(-1)?.[metric] ?? null, "%")}</span>
      </div>
      <svg
        viewBox="0 0 320 80"
        role="img"
        aria-label={`${label} · ${t("resourceHistory")}`}
      >
        <path className="resource-grid" d="M4,18 H316 M4,74 H316" />
        <text x="4" y="12">
          100 %
        </text>
        <path className="resource-line" d={path} />
      </svg>
    </div>
  );
}

export default function ResourceMonitor() {
  const t = useT();
  const [samples, setSamples] = useState<Sample[]>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const previous = useRef<Counters | null>(null);
  usePolling(
    useCallback(async (signal: AbortSignal) => {
      let sample: Sample = {
        at: Date.now(),
        cpu: null,
        memory: null,
        memoryBytes: null,
        memoryTotalBytes: null,
      };
      try {
        const current = await api<Counters>("/resources", {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        if (signal.aborted) return;
        const before = previous.current;
        sample = {
          at: Date.now(),
          cpu:
            before &&
            before.cpu_seconds !== null &&
            current.cpu_seconds !== null &&
            before.cpu_total_seconds !== null &&
            current.cpu_total_seconds !== null &&
            current.sampled_at > before.sampled_at &&
            current.cpu_total_seconds > before.cpu_total_seconds &&
            current.cpu_seconds >= before.cpu_seconds
              ? percent(
                  (100 * (current.cpu_seconds - before.cpu_seconds)) /
                    (current.cpu_total_seconds - before.cpu_total_seconds),
                )
              : null,
          memory:
            current.memory_bytes !== null &&
            current.memory_total_bytes &&
            current.memory_total_bytes > 0
              ? percent(
                  (100 * current.memory_bytes) / current.memory_total_bytes,
                )
              : null,
          memoryBytes: current.memory_bytes,
          memoryTotalBytes: current.memory_total_bytes,
        };
        previous.current = current;
        setFailed(false);
      } catch {
        if (signal.aborted) return;
        previous.current = null;
        setFailed(true);
      }
      setSamples((history) =>
        [
          ...history.filter((item) => sample.at - item.at < historyWindow),
          sample,
        ].slice(-61),
      );
    }, []),
    { interval },
  );
  const latest = samples.at(-1);
  return (
    <div className="resource-monitor">
      <button
        className="resource-trigger"
        popoverTarget="resource-history"
        title={t("resourceMonitor")}
        aria-label={t("resourceMonitor")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="resource-history"
      >
        {(["cpu", "memory"] as const).map((metric) => (
          <span className={`resource-meter resource-${metric}`} key={metric}>
            <span
              className="resource-meter-fill"
              aria-hidden="true"
              style={{ width: `${latest?.[metric] ?? 0}%` }}
            />
            <span>{metric === "cpu" ? "CPU" : "RAM"}</span>
            <b>{format(latest?.[metric] ?? null, "%")}</b>
          </span>
        ))}
      </button>
      <section
        id="resource-history"
        className="resource-popover"
        popover="auto"
        role="dialog"
        aria-label={t("resourceMonitor")}
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        <header>
          <strong>{t("resourceMonitor")}</strong>
          <button
            className="icon"
            title={t("close")}
            popoverTarget="resource-history"
            popoverTargetAction="hide"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <p className="resource-description">{t("resourceScope")}</p>
        {failed && <p role="status">{t("resourceUnavailable")}</p>}
        {!samples.length && <p role="status">{t("loading")}</p>}
        <Chart samples={samples} metric="cpu" label="CPU" />
        <Chart samples={samples} metric="memory" label="RAM" />
        <div className="resource-time">
          <span>{t("resourcePast")}</span>
          <span>{t("resourceNow")}</span>
        </div>
        <p className="resource-memory-detail">
          <span>{t("resourceMemoryAmount")}</span>
          <strong>
            {formatMemory(latest?.memoryBytes ?? null)} /{" "}
            {formatMemory(latest?.memoryTotalBytes ?? null)}
          </strong>
        </p>
        <p className="resource-description">{t("resourceHint")}</p>
        {!failed && latest?.memory === null && (
          <p role="status">{t("resourceMemoryUnavailable")}</p>
        )}
      </section>
    </div>
  );
}
