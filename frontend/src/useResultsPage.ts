import { useEffect, useState } from "react";
import { api, ApiError, withQuery } from "./api";
import type { FailingRows, ResultsTarget } from "./results";
import { sampleQuery, type Sample } from "./samples";
import type { Dataset, PreviewPage, Snapshot, TestRows } from "./types";
import { useResource } from "./useApiResource";
import { useStaleVariables } from "./VariableFields";
import { usePartitionQuery } from "./worktree";
export const PAGE_SIZE = 100;
export function useResultsPage(
  snapshot: Snapshot,
  environment: string,
  target: ResultsTarget,
  dataset: Dataset | undefined,
  failing: FailingRows | null,
  fullNode: string,
  sample: Sample,
) {
  const partition = usePartitionQuery(target.node, target.port);
  const worktree = snapshot.worktree.id;
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search, query]);
  const path = failing
    ? withQuery(
        `/worktrees/${worktree}/test-rows/${encodeURIComponent(fullNode)}/${encodeURIComponent(failing.test)}`,
        { environment, limit: PAGE_SIZE, offset, ...partition },
      )
    : withQuery(
        `/worktrees/${worktree}/preview/${encodeURIComponent(target.node)}`,
        {
          environment,
          ...partition,
          port: target.port,
          limit: PAGE_SIZE,
          offset,
          search: query || undefined,
          ...sampleQuery(sample),
        },
      );
  // The current page stays visible while another page, sample or search loads.
  const { data, error, pending } = useResource<PreviewPage | TestRows | null>(
    `${worktree}:${target.node}:${target.port}:${JSON.stringify(partition)}`,
    async (signal) => {
      try {
        return await api<PreviewPage | TestRows>(path, { signal });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && !failing) return null;
        throw e;
      }
    },
    { refresh: `${path}:${dataset?.id}:${dataset?.status}` },
  );
  const page = data && "status" in data ? data : null;
  const rows = data && "test" in data ? data : null;
  const staleVariables = useStaleVariables(snapshot, environment, page);
  const columns = (page || rows)?.columns || dataset?.columns || [];
  const total = (page || rows)?.filtered_count ?? 0;
  // A rerun can remove the current page. Wait for its response before resetting:
  // while loading, data still describes the previous page or result.
  if (!pending && data && offset > 0 && offset >= total) {
    setOffset(0);
  }
  return {
    partition,
    worktree,
    offset,
    setOffset,
    search,
    setSearch,
    query,
    data,
    error,
    pending,
    page,
    rows,
    staleVariables,
    columns,
    total,
  };
}
