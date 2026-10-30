import { AlertTriangle, GitCompareArrows } from "lucide-react";
import { useT } from "./i18n";
import type { Json } from "./types";
import { useApiResource } from "./useApiResource";

export default function GitSyncButton({
  worktree,
  commit,
  version,
  onClick,
}: {
  worktree: string;
  commit: string;
  version: number;
  onClick: () => void;
}) {
  const t = useT();
  const {
    data: state,
    error,
    reload,
  } = useApiResource<Json>(`/worktrees/${worktree}/git/remote`, {
    refresh: `${commit}:${version}`,
  });
  const status = state
    ? t("sync_" + state.state)
    : error
      ? `${t("sync_unavailable")}: ${error}`
      : t("loading");
  return (
    <button
      className="button secondary small git-status-button"
      aria-label={t("gitSynchronization")}
      title={`${t("gitSynchronization")} · ${status} · ${t("lastCheck")}: ${state?.checked ? new Date(state.checked).toLocaleString() : t("neverChecked")}`}
      onClick={() => {
        if (error) reload();
        onClick();
      }}
    >
      {error ? (
        <AlertTriangle size={15} aria-hidden="true" />
      ) : (
        <GitCompareArrows size={15} />
      )}
      <span>
        {state?.ahead !== null && state?.ahead !== undefined
          ? `${state.ahead} ↑ / ${state.behind} ↓`
          : t("gitSynchronization")}
      </span>
    </button>
  );
}
