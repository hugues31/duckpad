import { useEffect } from "react";
import { ApiError } from "./api";

/** Answers a retry cannot change: the session ended, access was revoked or the resource is gone. */
const FINAL_STATUSES = [401, 403, 404];

/** Whether polling should give up after this error instead of retrying. */
export const isFinal = (error: unknown) =>
  error instanceof ApiError && FINAL_STATUSES.includes(error.status);

export interface PollingOptions {
  /** Milliseconds between the end of a run and the start of the next; omit to run once. */
  interval?: number;
  /** Milliseconds to wait before the first run. */
  delay?: number;
  enabled?: boolean;
  /** Pause recurring requests while the tab is hidden. */
  pauseWhenHidden?: boolean;
}

/**
 * Run `task` until it changes or the component unmounts, aborting its signal
 * then: wrap it in `useCallback` so that its dependencies restart polling. Each
 * run starts after the previous one settles, so responses never overlap. A run
 * returning false, or failing with a final API error, stops polling; other
 * failures are retried.
 */
export function usePolling(
  task: (signal: AbortSignal) => Promise<boolean | void | number>,
  {
    interval,
    delay = 0,
    enabled = true,
    pauseWhenHidden = true,
  }: PollingOptions,
) {
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let pending = false;
    let stopped = false;
    const paused = () =>
      pauseWhenHidden && interval !== undefined && document.hidden;
    const run = async () => {
      if (paused() || pending || stopped || controller.signal.aborted) return;
      pending = true;
      let next: boolean | void | number;
      try {
        next = await task(controller.signal);
      } catch (e) {
        next = !isFinal(e);
      }
      pending = false;
      stopped = next === false || interval === undefined;
      if (!stopped && !paused() && !controller.signal.aborted)
        timer = window.setTimeout(
          run,
          typeof next === "number" ? next : interval,
        );
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!paused()) void run();
    };
    document.addEventListener("visibilitychange", visibility);
    if (delay) timer = window.setTimeout(run, delay);
    else void run();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      controller.abort();
      clearTimeout(timer);
    };
  }, [task, enabled, interval, delay, pauseWhenHidden]);
}
