import { useState } from "react";
import type { Run } from "./types";
import { useApiResource } from "./useApiResource";

/** Follow the run launched here even when it finishes between status polls. */
export function useRunFailure(worktree: string, environment: string) {
  const [launched, trackRun] = useState<Run | null>(null);
  const current =
    launched?.worktree === worktree && launched.environment === environment
      ? launched
      : null;
  const outcome = useApiResource<Run>(
    current ? `/runs/${encodeURIComponent(current.id)}` : null,
    {
      interval: 1000,
      keepDataOnError: true,
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
      run?.status === "failed" && run.error && !Object.keys(run.nodes).length
        ? run
        : null,
  };
}
