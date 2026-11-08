import { withQuery } from "./api";
import type { ResultsTarget } from "./results";
import type { PreviewPage } from "./types";
import { useApiResource } from "./useApiResource";
import { usePartitionQuery } from "./worktree";
export function useFilterMatchCount(
  worktree: string,
  environment: string,
  target: ResultsTarget,
  filter: string,
) {
  const partition = usePartitionQuery(target.node, target.port);
  return useApiResource<PreviewPage>(
    filter.trim()
      ? withQuery(
          `/worktrees/${worktree}/preview/${encodeURIComponent(target.node)}`,
          { environment, port: target.port, limit: 1, ...partition, filter },
        )
      : null,
    { delay: 400 },
  );
}
