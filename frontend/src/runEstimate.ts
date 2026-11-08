import type { Run } from "./types";

const positive = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const elapsed = (started: string | undefined, now: number) => {
  const start = Date.parse(started ?? "");
  return Number.isFinite(start) ? Math.max(0, (now - start) / 1000) : 0;
};

/** Approximate seconds remaining, or null until there is enough timing data. */
export function remainingSeconds(run: Run, now: number): number | null {
  if (run.status !== "running") return null;
  const nodes = Object.values(run.nodes);
  const partitions = run.partitions;
  // The key count is unknown while partition values are being calculated.
  if (nodes.some((node) => node.partitioned) && !partitions) return null;
  if (partitions) {
    if (partitions.phase === "values") return null;
    // not_started also includes queued/active keys while the run is in progress.
    const settled = partitions.completed + partitions.failed;
    const remaining = partitions.selected - settled;
    if (remaining > 0) {
      // Wall-clock throughput accounts for parallel keys without summing their durations.
      const seconds = elapsed(partitions.started, now);
      return settled > 0 && seconds > 0
        ? (seconds / settled) * remaining
        : null;
    }
  }
  const ordinary = nodes.filter((node) => !node.partitioned);
  const completed = ordinary
    .filter((node) => node.status === "success")
    .map((node) => node.duration)
    .filter(positive);
  const samples = completed.length
    ? completed
    : ordinary.map((node) => node.estimated_duration).filter(positive);
  const average = samples.length
    ? samples.reduce((sum, value) => sum + value, 0) / samples.length
    : undefined;
  let remaining = 0;
  for (const node of ordinary) {
    if (node.status !== "pending" && node.status !== "running") continue;
    const estimate = positive(node.estimated_duration)
      ? node.estimated_duration
      : average;
    if (!positive(estimate)) return null;
    remaining +=
      node.status === "running"
        ? Math.max(0, estimate - elapsed(node.started, now))
        : estimate;
  }
  // An overrun or finalization must never promise zero seconds before completion.
  return remaining > 0 ? remaining : null;
}

/** Compact, deliberately rounded precision for an approximate duration. */
export function remainingDuration(seconds: number): string {
  if (seconds < 1) return "<1 s";
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded} s`;
  const minutes = Math.ceil(rounded / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}
