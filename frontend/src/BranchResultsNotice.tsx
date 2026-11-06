import { countLabel, useT } from "./i18n";
import { useLoadedWorktree } from "./worktree";

/** Results are local to a worktree, so a new branch needs its first run. */
export default function BranchResultsNotice() {
  const t = useT();
  const { snapshot, statuses, canEdit, starting, run } = useLoadedWorktree();
  const count = snapshot.bundle?.flow.nodes.length || 0;
  if (
    snapshot.worktree.branch === "main" ||
    snapshot.worktree.read_only ||
    !count ||
    statuses.active ||
    Object.keys(statuses.nodes).length
  )
    return null;
  return (
    <div className="branch-results-notice" role="status">
      <span>
        {t("branchNoResults")} ·{" "}
        {countLabel(t, count, "branchOneNode", "branchNodeCount")}
      </span>
      <button
        className="button secondary small"
        disabled={!canEdit || starting}
        onClick={() => void run()}
      >
        {t("run")}
      </button>
    </div>
  );
}
