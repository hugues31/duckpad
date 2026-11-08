import { useMemo } from "react";
import { withQuery } from "./api";
import type { InputColumns } from "./draftPreview";
import type { Snapshot, Statuses } from "./types";
import { useApiResource } from "./useApiResource";
import { usePartitionQuery } from "./worktree";

/** Columns of expanded inputs, including connections across component boundaries. */
export function useInputColumns(
  snapshot: Snapshot,
  fullNode: string,
  environment: string,
  statuses: Statuses,
) {
  const partition = usePartitionQuery(fullNode);
  // Keep the refresh key small; never serialize result rows or schemas on each keystroke.
  const refresh = useMemo(
    () =>
      JSON.stringify([
        snapshot.revision,
        statuses.active?.id,
        Object.entries(statuses.nodes).map(([id, node]) => [
          id,
          Object.values(node.outputs).map((output) => [
            output.id,
            output.status,
          ]),
        ]),
      ]),
    [snapshot.revision, statuses.active?.id, statuses.nodes],
  );
  const resource = useApiResource<InputColumns>(
    withQuery(
      `/worktrees/${snapshot.worktree.id}/input-columns/${encodeURIComponent(fullNode)}`,
      { environment, ...partition },
    ),
    { refresh },
  );
  const columns = useMemo(
    () =>
      Object.fromEntries(
        (resource.data?.inputs || []).map((input) => [
          input.input,
          input.columns || [],
        ]),
      ),
    [resource.data],
  );
  return { ...resource, columns };
}
