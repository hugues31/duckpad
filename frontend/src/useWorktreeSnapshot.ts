import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, withQuery } from "./api";
import type { Json, Snapshot, Statuses } from "./types";
import { usePolling } from "./usePolling";

const POLL_INTERVAL = 1000;
const EMPTY_STATUSES: Statuses = { nodes: {}, active: null };

/** Keep the previous object when nothing changed, so dependents do not refetch. */
const unchanged = (old: Snapshot | null, value: Snapshot) =>
  old?.worktree.id === value.worktree.id &&
  old?.revision === value.revision &&
  old?.role === value.role &&
  JSON.stringify(old.connections) === JSON.stringify(value.connections) &&
  JSON.stringify(old.conflicts) === JSON.stringify(value.conflicts);

/**
 * The saved state of a working branch and the result statuses of an
 * environment, polled together every second while `enabled`.
 */
export function useWorktreeSnapshot(
  worktree: string,
  environment: string,
  {
    enabled,
    onUnavailable,
  }: {
    enabled: boolean;
    /** Called when the branch is denied or gone, for instance after access was revoked. */
    onUnavailable: () => Promise<unknown>;
  },
) {
  const [state, setState] = useState<Snapshot | null>(null);
  const [statuses, setStatuses] = useState<Statuses>(EMPTY_STATUSES);
  const [loadError, setLoadError] = useState("");
  // Another branch, or polling enabled again, starts from an empty state.
  const [source, setSource] = useState({ worktree, enabled });
  if (source.worktree !== worktree || source.enabled !== enabled) {
    setSource({ worktree, enabled });
    setLoadError("");
    setState(null);
    setStatuses(EMPTY_STATUSES);
  }
  const current = useRef(worktree);
  // Incremented after every change, so reads started before it are discarded.
  const epoch = useRef(0);
  const unavailable = useRef(onUnavailable);
  useLayoutEffect(() => {
    current.current = worktree;
    unavailable.current = onUnavailable;
  });

  const load = useCallback(async (id: string, signal?: AbortSignal) => {
    const started = epoch.current;
    try {
      const value = await api<Snapshot>(`/worktrees/${id}`, { signal });
      if (id !== current.current || started !== epoch.current) return;
      setLoadError("");
      setState((old) => (unchanged(old, value) ? old : value));
    } catch (e) {
      if (id === current.current && !signal?.aborted)
        setLoadError((e as Error).message);
      throw e;
    }
  }, []);

  usePolling(
    useCallback(
      async (signal: AbortSignal) => {
        try {
          const [status] = await Promise.all([
            // Statuses need an environment; the snapshot is read without one.
            environment
              ? api<Statuses>(
                  withQuery(`/worktrees/${worktree}/status`, { environment }),
                  { signal },
                )
              : null,
            load(worktree, signal).catch(async (e) => {
              // Only a denied snapshot means project access was revoked. A status
              // request can return 404 while a deleted environment is refreshing.
              if (
                !signal.aborted &&
                e instanceof ApiError &&
                [403, 404].includes(e.status)
              ) {
                setState(null);
                setStatuses(EMPTY_STATUSES);
                await unavailable.current();
              }
              throw e;
            }),
          ]);
          if (status && !signal.aborted)
            setStatuses((old) =>
              JSON.stringify(old) === JSON.stringify(status) ? old : status,
            );
        } catch {
          // Keep polling: temporary failures pass, and revoked access can be restored.
        }
      },
      [worktree, environment, load],
    ),
    { interval: POLL_INTERVAL, enabled: enabled && !!worktree },
  );

  return {
    snapshot: state?.worktree.id === worktree ? state : null,
    statuses,
    /** Why the latest read of the snapshot failed; cleared by the next success. */
    loadError,
    /** Reload the snapshot after a change, ignoring reads started before it. */
    refresh: useCallback(
      async (id = current.current) => {
        epoch.current++;
        await load(id);
      },
      [load],
    ),
    /** Show a run started or cancelled on the given branch as its active run. */
    setActive: useCallback((id: string, run: Json) => {
      if (id === current.current)
        setStatuses((old) => ({ ...old, active: run }));
    }, []),
  };
}
