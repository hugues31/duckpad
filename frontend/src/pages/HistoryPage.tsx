import HistoryPanel from "../HistoryPanel";
import { useShell } from "../shell";
import { useLoadedWorktree } from "../worktree";

export default function HistoryPage() {
  const { openModal } = useShell();
  const { id, canEdit } = useLoadedWorktree();
  return (
    <HistoryPanel
      readOnly={!canEdit}
      worktree={id}
      onDiff={(commit) =>
        openModal({ kind: "git", worktree: id, mode: "compare", commit })
      }
      onRevision={(revision) =>
        openModal({ kind: "newBranch", worktree: id, revision })
      }
      onCompare={() => openModal({ kind: "git", worktree: id })}
    />
  );
}
