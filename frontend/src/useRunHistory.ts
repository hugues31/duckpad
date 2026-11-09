import { useState } from "react";
import { api } from "./api";
import type { Run } from "./types";
import { useResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";

async function page(path: string, signal?: AbortSignal) {
  let next: string | null = null;
  const items = await api<Run[]>(path, { signal }, (response) => {
    next = response.headers.get("X-Next-Cursor");
  });
  return { items, next };
}

/** Poll only the newest summaries; older pages are fetched explicitly. */
export function useRunHistory(path: string, interval?: number) {
  const [older, setOlder] = useState<{
    path: string;
    items: Run[];
    next: string | null;
  } | null>(null);
  const first = useResource(
    path,
    async (signal) => {
      const result = await page(path, signal);
      if (!signal.aborted)
        setOlder((previous) =>
          previous?.path === path
            ? { ...previous, items: merge(result.items, previous.items) }
            : previous,
        );
      return result;
    },
    {
      interval,
      nextInterval: (value) =>
        value.items.some((run) =>
          ["preparing", "running", "canceling"].includes(run.status),
        )
          ? 2000
          : 10000,
    },
  );
  const more = useAsyncAction();
  const extra = older?.path === path ? older : null;
  const data = first.data ? merge(first.data.items, extra?.items || []) : null;
  const next = extra ? extra.next : first.data?.next;
  return {
    data,
    pending: first.pending,
    error: first.error || more.error,
    reload: first.reload,
    hasMore: !!next,
    loadingMore: more.pending,
    loadMore: () =>
      more.run(async () => {
        if (!next) return;
        const result = await page(
          `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(next)}`,
        );
        setOlder((previous) => ({
          path,
          items: merge(
            previous?.path === path ? previous.items : first.data!.items,
            result.items,
          ),
          next: result.next,
        }));
      }),
  };
}

function merge(latest: Run[], previous: Run[]) {
  const seen = new Set(latest.map((run) => run.id));
  return [...latest, ...previous.filter((run) => !seen.has(run.id))];
}
