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
}

/**
 * Run `task` until it changes or the component unmounts, aborting its signal
 * then: wrap it in `useCallback` so that its dependencies restart polling. Each
 * run starts after the previous one settles, so responses never overlap. A run
 * returning false, or failing with a final API error, stops polling; other
 * failures are retried.
 */
export function usePolling(
  task: (signal: AbortSignal) => Promise<boolean | void>,
  { interval, delay = 0, enabled = true }: PollingOptions,
) {
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const run = async () => {
      let next: boolean;
      try {
        next = (await task(controller.signal)) !== false;
      } catch (e) {
        next = !isFinal(e);
      }
      if (next && interval !== undefined && !controller.signal.aborted)
        timer = window.setTimeout(run, interval);
    };
    if (delay) timer = window.setTimeout(run, delay);
    else void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [task, enabled, interval, delay]);
}
