import { useEffect, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import type { Json } from "./types";

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
  const [state, setState] = useState<Json | null>(null);
  useEffect(() => {
    let live = true;
    api<Json>(`/worktrees/${worktree}/git/remote`)
      .then((value) => {
        if (live) setState(value);
      })
      .catch(() => {
        if (live) setState(null);
      });
    return () => {
      live = false;
    };
  }, [worktree, commit, version]);
  return (
    <button
      className="button secondary small git-status-button"
      aria-label={t("gitSynchronization")}
      title={`${t("gitSynchronization")} · ${state ? t("sync_" + state.state) : t("loading")} · ${t("lastCheck")}: ${state?.checked ? new Date(state.checked).toLocaleString() : t("neverChecked")}`}
      onClick={onClick}
    >
      <GitCompareArrows size={15} />
      <span>
        {state?.ahead !== null && state?.ahead !== undefined
          ? `${state.ahead} ↑ / ${state.behind} ↓`
          : t("gitSynchronization")}
      </span>
    </button>
  );
}
