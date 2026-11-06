import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router";
import CodePanel from "../CodePanel";
import PythonEnvironmentStatus from "../PythonEnvironmentStatus";
import { FlowToolbar, WorkspaceNotices } from "../FlowToolbar";
import { usePageRoute, worktreeUrl } from "../navigation";
import { useT } from "../i18n";
import { useShell, useWorkspace } from "../shell";
import { useWorktree } from "../worktree";
import { useFlowView } from "./FlowPage";
import { PageLoading, RouteError } from "./PageStates";
import type { Worktree } from "../types";

/** The toolbar, notices and code editor shared by the tabs of a working branch. */
export default function WorktreePage() {
  const t = useT();
  const { openModal, openWorktree, notify } = useShell();
  const navigate = useNavigate();
  const workspace = useWorkspace();
  const { tab = "flow" } = usePageRoute();
  const {
    id,
    environment,
    snapshot,
    statuses,
    loadError,
    canEdit,
    saveFiles,
    setAssistantNode,
    saving,
    starting,
  } = useWorktree();
  const flowView = useFlowView(id, environment);
  // Another session deleted the open branch: return to the project's main branch.
  const tree = workspace.worktrees.find((w) => w.id === id);
  const [opened, setOpened] = useState<Worktree | null>(null);
  if (tree && tree.id !== opened?.id) setOpened(tree);
  const deleted = !tree && opened?.id === id ? opened : null;
  const fallback =
    deleted && workspace.projects.find((p) => p.id === deleted.project)?.main;
  useEffect(() => {
    if (!deleted || !fallback) return;
    notify(t("openBranchDeleted").replace("{name}", deleted.branch));
    void navigate(worktreeUrl(fallback, tab, environment), { replace: true });
  }, [deleted, fallback, tab, environment, navigate, notify, t]);
  const assistantNode = flowView.selected
    ? [...flowView.path.map((p) => p.instance), flowView.selected].join("::")
    : "";
  useEffect(() => {
    setAssistantNode(assistantNode);
  }, [assistantNode, setAssistantNode]);
  if (fallback) return <PageLoading />;
  if (!tree || (loadError && !snapshot)) return <RouteError />;
  if (!snapshot) return <PageLoading />;
  return (
    <>
      <FlowToolbar />
      {snapshot.python_enabled && (
        <PythonEnvironmentStatus
          key={tree.project}
          project={tree.project}
          compact
          active={saving || starting}
        />
      )}
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
        onViewFiles={(diagnostic) =>
          diagnostic.variable
            ? void navigate(
                worktreeUrl(id, "variables", environment, {
                  variable: diagnostic.variable,
                }),
              )
            : openWorktree(id, "code")
        }
      />
      <CodePanel
        selectedNode={assistantNode}
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
