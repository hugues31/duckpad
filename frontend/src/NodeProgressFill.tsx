import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { overran, progressTimeline, type NodeProgress } from "./runEstimate";

/** The fill keeps its last part for the actual result, never an estimate. */
const FILL_LIMIT = 0.9;
const offset = (share: number) =>
  `translateX(${((share * FILL_LIMIT - 1) * 100).toFixed(2)}%)`;
const EMPTY = offset(0);

/** The current time, refreshed every second while `active`. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** How a node's shape shows its progress, for styles and tests. */
export function progressState(progress: NodeProgress | undefined, now: number) {
  if (progress?.phase !== "running") return progress?.phase ?? "idle";
  if (!progress.total) return "working";
  return overran(progress, now) ? "overrun" : "estimated";
}

/**
 * A left-to-right fill inside a running node's shape. With previous durations it
 * follows the expected share of work; otherwise, or once a node takes longer, a
 * sweep only shows activity. A successful node completes its fill, then fades.
 */
export function NodeProgressFill({
  progress,
  status,
  now,
}: {
  progress?: NodeProgress;
  status: string;
  now: number;
}) {
  const fill = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(false);
  const plan =
    progress?.phase === "running"
      ? JSON.stringify([progress.done, progress.total, progress.running])
      : "";
  const paused = !!progress?.paused;
  const outcome =
    status === "valid" || status === "success"
      ? "success"
      : status === "failed"
        ? "failed"
        : "";
  useLayoutEffect(() => {
    const element = fill.current;
    if (!element?.animate) return;
    const running = !!plan;
    const ended = wasRunning.current && !running;
    wasRunning.current = running;
    if (ended) {
      // The result arrived: a success completes the fill, then it fades.
      const end =
        outcome === "success" ? "translateX(0%)" : element.style.transform;
      const animation = element.animate(
        [
          { transform: end, opacity: 1, offset: 0.45 },
          { transform: end, opacity: 0 },
        ],
        { duration: outcome ? 900 : 500, easing: "ease-out" },
      );
      animation.onfinish = () => (element.style.transform = EMPTY);
      return () => animation.cancel();
    }
    if (!running) {
      element.style.transform = EMPTY;
      return;
    }
    const [done, total, nodes] = JSON.parse(plan) as [
      number,
      number | null,
      NodeProgress["running"],
    ];
    const timeline = progressTimeline(
      { phase: "running", done, total: total ?? undefined, running: nodes },
      Date.now(),
    );
    if (!timeline) {
      element.style.transform = EMPTY;
      return;
    }
    const frames = timeline.frames.map((frame) => ({
      offset: frame.offset,
      transform: offset(frame.share),
    }));
    element.style.transform = frames.at(-1)!.transform;
    if (timeline.duration <= 0) return;
    const animation = element.animate(frames, {
      duration: timeline.duration,
      easing: "linear",
    });
    if (paused) animation.pause();
    return () => {
      // The next plan starts from where this one is now.
      const current = getComputedStyle(element).transform;
      animation.cancel();
      if (current && current !== "none") element.style.transform = current;
    };
  }, [plan, paused, outcome]);
  return (
    <div
      className="node-progress"
      data-state={progressState(progress, now)}
      data-paused={paused || undefined}
      data-outcome={outcome || undefined}
      aria-hidden="true"
    >
      <div className="node-progress-fill" ref={fill} />
    </div>
  );
}
