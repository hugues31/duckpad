import type { NodeRun, Run } from "./types";

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
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded} s`;
  const minutes = Math.ceil(rounded / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

/** What the active run does with a canvas node and the nodes nested in it. */
export interface NodeProgress {
  /** Waiting for its turn, executing, or finished successfully in this run. */
  phase: "queued" | "running" | "done";
  /** Earliest start of its nodes in this run, in epoch milliseconds. */
  started?: number;
  /**
   * Expected seconds of all its nodes, from their previous successful durations;
   * absent when one of the nodes still to finish has none.
   */
  total?: number;
  /** Expected seconds of its nodes that already finished. */
  done: number;
  /** Start (epoch milliseconds) and expected seconds of each executing node. */
  running: { started: number; estimate: number }[];
  /** The run is stopping, so its animations stand still. */
  paused?: boolean;
}

const ACTIVE_RUN = ["preparing", "running", "canceling"];

/** Progress of a canvas node in the active run, or undefined outside its scope. */
export function nodeProgress(
  run: Run | null | undefined,
  id: string,
): NodeProgress | undefined {
  if (!run || !ACTIVE_RUN.includes(run.status)) return undefined;
  const states = Object.entries(run.nodes || {})
    .filter(([key]) => key === id || key.startsWith(id + "::"))
    .map(([, state]) => state);
  if (!states.length) return undefined;
  const open = (state: NodeRun) =>
    state.status === "pending" || state.status === "running";
  const executing = states.filter((state) => state.status === "running");
  if (!states.some(open))
    return states.every((state) => state.status === "success")
      ? { phase: "done", done: 0, running: [] }
      : undefined;
  // Partition summaries are not the timing of one execution.
  const weight = (state: NodeRun) =>
    state.partitioned
      ? undefined
      : positive(state.estimated_duration)
        ? state.estimated_duration
        : state.status === "success" && positive(state.duration)
          ? state.duration
          : open(state)
            ? undefined
            : 0;
  const weights = states.map(weight);
  const known = weights.every((value) => value !== undefined);
  // A component started with its first node, even one that already finished.
  const starts = states
    .map((state) => Date.parse(state.started ?? ""))
    .filter(Number.isFinite);
  return {
    phase: executing.length ? "running" : "queued",
    started: starts.length ? Math.min(...starts) : undefined,
    total: known ? weights.reduce((sum, value) => sum + value, 0) : undefined,
    done: known
      ? states.reduce(
          (sum, state, index) => (open(state) ? sum : sum + weights[index]),
          0,
        )
      : 0,
    running: known
      ? executing.map((state) => ({
          started: Date.parse(state.started ?? "") || 0,
          estimate: weight(state)!,
        }))
      : [],
    paused: run.status === "canceling" || undefined,
  };
}

/** The share of a node's expected work done at `time`, from 0 to 1. */
function completedShare(progress: NodeProgress, time: number) {
  const elapsed = progress.running.reduce(
    (sum, node) =>
      sum + Math.min(node.estimate, Math.max(0, (time - node.started) / 1000)),
    0,
  );
  return Math.min(1, (progress.done + elapsed) / progress.total!);
}

/**
 * The expected share of work over time, as animation keyframes from `now` until
 * every executing node reaches its previous duration; null without an estimate.
 */
export function progressTimeline(progress: NodeProgress, now: number) {
  if (progress.phase !== "running" || !progress.total) return null;
  const ends = [
    ...new Set(
      progress.running
        .map((node) => node.started + node.estimate * 1000)
        .filter((end) => end > now),
    ),
  ].sort((a, b) => a - b);
  const last = ends.at(-1);
  const start = { offset: 0, share: completedShare(progress, now) };
  if (last === undefined) return { duration: 0, frames: [start] };
  const duration = last - now;
  return {
    duration,
    frames: [
      start,
      ...ends.map((end) => ({
        offset: (end - now) / duration,
        share: completedShare(progress, end),
      })),
    ],
  };
}

/** Whether every executing node has run longer than its previous duration. */
export const overran = (progress: NodeProgress, now: number) =>
  progress.phase === "running" &&
  !!progress.total &&
  progress.running.length > 0 &&
  progress.running.every((node) => now >= node.started + node.estimate * 1000);

/** A whole-second duration that ticks, such as "8 s", "1 min 5 s" or "1 h 2 min". */
export function elapsedDuration(value: number): string {
  const total = Math.max(0, Math.floor(value));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60)
    return total % 60 ? `${minutes} min ${total % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
