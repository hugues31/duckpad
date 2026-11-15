import { useState } from "react";
import type { Run } from "./types";
import { useApiResource } from "./useApiResource";

/**
 * The run launched here once it failed as a whole: before any node ran, or
 * with no node carrying the error, so no result card can show it.
 */
export function useRunFailure(
  worktree: string,
  environment: string,
  /** The branch's active run, which the status poll already reads every second. */
  active: Run | null,
) {
  const [launched, trackRun] = useState<Run | null>(null);
  const current =
    launched?.worktree === worktree && launched.environment === environment
      ? launched
      : null;
  // Read the outcome once the run left the status poll, not on a second poll beside it.
  const ended = current && active?.id !== current.id;
  const outcome = useApiResource<Run>(
    ended ? `/runs/${encodeURIComponent(current.id)}` : null,
    {
      interval: 1000,
      keepDataOnError: true,
      // Statuses reset by a branch change can miss a run that is still active.
      nextInterval: (run) =>
        ["preparing", "running", "canceling"].includes(run.status)
          ? 1000
          : false,
    },
  );
  const run = outcome.data || current;
  return {
    trackRun,
    // Node failures already have their own cards in Results.
    runFailure:
      run?.status === "failed" &&
      run.error &&
      !Object.values(run.nodes).some((node) => node.error)
        ? run
        : null,
  };
}
