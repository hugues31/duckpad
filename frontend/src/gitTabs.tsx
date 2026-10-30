import { useCallback, useRef } from "react";
import type { Branch, RemoteStatus } from "./gitTypes";
import { useT } from "./i18n";
import { useAsyncAction } from "./useAsyncAction";

/** Branches and origin state shared by the tabs of the Git workspace. */
export interface Repository {
  branches: Branch[];
  remote: RemoteStatus | null;
  loading: boolean;
  failure: { message: string; retry: () => void } | null;
  reload: () => Promise<void>;
}

/** Track the actions of one Git tab; Retry replays the action that failed. */
export function useTabAction() {
  const { pending, error, run } = useAsyncAction();
  const last = useRef<(() => Promise<unknown>) | null>(null);
  const start = useCallback(
    (action: () => Promise<unknown>) => {
      last.current = action;
      return run(action);
    },
    [run],
  );
  const retry = useCallback(() => {
    if (last.current) void run(last.current);
  }, [run]);
  return { pending, error, run: start, retry };
}

/** The failure and progress of one tab, which never hide another tab's content. */
export function TabStatus({
  error,
  pending = false,
  onRetry,
  action,
}: {
  error?: string;
  pending?: boolean;
  onRetry?: () => void;
  action?: React.ReactNode;
}) {
  const t = useT();
  return (
    <>
      {error && (
        <div role="alert" className="notice error">
          {error}{" "}
          {action ??
            (onRetry && (
              <button
                type="button"
                className="button secondary small"
                onClick={onRetry}
              >
                {t("retry")}
              </button>
            ))}
        </div>
      )}
      {pending && (
        <p role="status" className="muted">
          {t("working")}
        </p>
      )}
    </>
  );
}
