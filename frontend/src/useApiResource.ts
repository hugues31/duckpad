import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { usePolling, type PollingOptions } from "./usePolling";

export interface ResourceOptions extends PollingOptions {
  /** Load again, keeping the current data meanwhile, whenever this value changes. */
  refresh?: string | number;
}

interface Settled<T> {
  key: string;
  request: string;
  data: T | null;
  error: string;
}

/**
 * Load a value identified by `key`, or nothing while it is null. Data and error
 * belong to the key: they reset when it changes, and stay in place while the
 * same key reloads, refreshes or polls. `load` must only depend on the key and
 * on the `refresh` option.
 */
export function useResource<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  { refresh, enabled = true, ...polling }: ResourceOptions = {},
) {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const request =
    key === null ? null : JSON.stringify([key, refresh ?? null, attempt]);
  // The request identifies what to load; a new `load` alone does not reload.
  const latestLoad = useRef(load);
  useLayoutEffect(() => {
    latestLoad.current = load;
  });
  usePolling(
    useCallback(
      async (signal: AbortSignal) => {
        const done = (data: T | null, error: string) => {
          if (!signal.aborted)
            setSettled({ key: key!, request: request!, data, error });
        };
        try {
          done(await latestLoad.current(signal), "");
        } catch (e) {
          done(null, (e as Error).message);
          throw e;
        }
      },
      [key, request],
    ),
    { ...polling, enabled: enabled && request !== null },
  );
  const current = settled?.key === key ? settled : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? "",
    /** True until the first answer of the current key, reload or refresh. */
    pending: enabled && request !== null && settled?.request !== request,
    reload: useCallback(() => setAttempt((value) => value + 1), []),
    /** Replace the loaded data locally, for instance with the answer of a save. */
    setData: useCallback(
      (change: T | null | ((current: T | null) => T | null)) =>
        setSettled(
          (old) =>
            old && {
              ...old,
              data:
                typeof change === "function"
                  ? (change as (current: T | null) => T | null)(old.data)
                  : change,
            },
        ),
      [],
    ),
  };
}

/** Load an API path with `useResource`; a null path loads nothing. */
export function useApiResource<T>(
  path: string | null,
  options?: ResourceOptions,
) {
  return useResource<T>(path, (signal) => api<T>(path!, { signal }), options);
}
