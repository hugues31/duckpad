import { useEffect, useRef } from "react";
import { Outlet, useNavigate } from "react-router";
import CodePanel from "../CodePanel";
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
  } = useWorktree();
  const flowView = useFlowView(id, environment);
  // Another session deleted the open branch: return to the project's main branch.
  const known = useRef<Worktree | null>(null);
  useEffect(() => {
    const tree = workspace.worktrees.find((w) => w.id === id);
    if (tree) {
      known.current = tree;
    } else if (known.current?.id === id) {
      const { branch, project: projectId } = known.current;
      const project = workspace.projects.find((p) => p.id === projectId);
      if (project) {
        known.current = null;
        notify(t("openBranchDeleted").replace("{name}", branch));
        void navigate(worktreeUrl(project.main, "flow", environment), {
          replace: true,
        });
      }
    }
  }, [id, workspace, environment, navigate, notify, t]);
  const assistantNode = flowView.selected
    ? [...flowView.path.map((p) => p.instance), flowView.selected].join("::")
    : "";
  useEffect(() => {
    setAssistantNode(assistantNode);
  }, [assistantNode, setAssistantNode]);
  if (!workspace.worktrees.some((w) => w.id === id) || (loadError && !snapshot))
    return <RouteError />;
  if (!snapshot) return <PageLoading />;
  return (
    <>
      <FlowToolbar />
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
