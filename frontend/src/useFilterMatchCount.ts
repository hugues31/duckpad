import { withQuery } from "./api";
import type { ResultsTarget } from "./results";
import type { PreviewPage } from "./types";
import { useApiResource } from "./useApiResource";
import { usePartitionQuery } from "./worktree";
/** The number of rows matching a filter, counted on the whole dataset; typing
 * waits for a pause, but the applied filter is counted at once. */
export function useFilterMatchCount(
  worktree: string,
  environment: string,
  target: ResultsTarget,
  filter: string,
  applied = "",
) {
  const partition = usePartitionQuery(target.node, target.port);
  return useApiResource<PreviewPage>(
    filter.trim()
      ? withQuery(
          `/worktrees/${worktree}/preview/${encodeURIComponent(target.node)}`,
          { environment, port: target.port, limit: 1, ...partition, filter },
        )
      : null,
    { delay: filter === applied ? 0 : 400 },
  );
}
