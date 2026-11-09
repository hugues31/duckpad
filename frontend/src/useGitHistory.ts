import { useEffect, useRef, useState } from "react";
import { api, withQuery } from "./api";
import type { HistoryPage } from "./gitTypes";
import { useResource } from "./useApiResource";

/** Load history pages against a frozen head, aborting when the view changes. */
export function useGitHistory(
  path: string,
  {
    entity,
    refresh,
    limit = 100,
    delay = 0,
  }: {
    entity?: string;
    refresh?: string | number;
    limit?: number;
    delay?: number;
  } = {},
) {
  const [attempt, setAttempt] = useState(0);
  const url = withQuery(path, { entity: entity || undefined, limit });
  const request = JSON.stringify([url, refresh, attempt]);
  const first = useResource<HistoryPage>(
    path,
    (signal) => api(url, { signal }),
    {
      refresh: request,
      delay,
      keepDataOnError: true,
    },
  );
  const controller = useRef<AbortController | null>(null);
  const [more, setMore] = useState<{
    request: string;
    pending: boolean;
    error: string;
  } | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [request],
  );
  const current = more?.request === request ? more : null;
  const loadMore = async () => {
    const from = first.data;
    if (!from || from.next === null || first.pending || controller.current)
      return;
    const pending = new AbortController();
    controller.current = pending;
    setMore({ request, pending: true, error: "" });
    try {
      const page = await api<HistoryPage>(
        withQuery(path, {
          entity: entity || undefined,
          limit,
          ref: from.head,
          offset: from.next,
        }),
        { signal: pending.signal },
      );
      if (!pending.signal.aborted) {
        first.setData((value) =>
          value === from
            ? { ...page, items: [...from.items, ...page.items] }
            : value,
        );
        setMore({ request, pending: false, error: "" });
      }
    } catch (error) {
      if (!pending.signal.aborted)
        setMore({ request, pending: false, error: (error as Error).message });
    } finally {
      if (controller.current === pending) controller.current = null;
    }
  };
  const reload = () => setAttempt((value) => value + 1);
  return {
    data: first.data,
    pending: first.pending,
    error: first.error || current?.error || "",
    reload,
    loadingMore: !!current?.pending,
    loadMore,
    retry: current?.error ? loadMore : reload,
  };
}
