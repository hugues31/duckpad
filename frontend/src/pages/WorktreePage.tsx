import { Outlet } from "react-router";
import CodePanel from "../CodePanel";
import { FlowToolbar, WorkspaceNotices } from "../FlowToolbar";
import { usePageRoute } from "../navigation";
import { useShell, useWorkspace } from "../shell";
import { useWorktree } from "../worktree";
import { useFlowView } from "./FlowPage";
import { PageLoading, RouteError } from "./PageStates";

/** The toolbar, notices and code editor shared by the tabs of a working branch. */
export default function WorktreePage() {
  const { openModal, openWorktree } = useShell();
  const workspace = useWorkspace();
  const { tab = "flow" } = usePageRoute();
  const { id, environment, snapshot, statuses, loadError, canEdit, saveFiles } =
    useWorktree();
  const flowView = useFlowView(id, environment);
  if (!workspace.worktrees.some((w) => w.id === id) || (loadError && !snapshot))
    return <RouteError />;
  if (!snapshot) return <PageLoading />;
  return (
    <>
      <FlowToolbar tab={tab} />
      <WorkspaceNotices
        snapshot={snapshot}
        active={statuses.active}
        onResolve={() =>
          openModal({
            kind: "conflict",
            worktree: id,
            conflict: snapshot.conflicts[0].id,
          })
        }
        onViewFiles={() => openWorktree(id, "code")}
      />
      <CodePanel
        key={id}
        hidden={tab !== "code"}
        readOnly={!canEdit}
        snapshot={snapshot}
        onSave={saveFiles}
      />
      <Outlet key={id} context={flowView} />
    </>
  );
}

/** WorktreePage keeps the code editor mounted on every tab, so its draft survives. */
export function CodePage() {
  return null;
}
