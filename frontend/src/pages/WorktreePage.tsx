import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router";
import CodePanel from "../CodePanel";
import { FlowToolbar, WorkspaceNotices } from "../FlowToolbar";
import { pathPrefix } from "../graph";
import { useT } from "../i18n";
import { usePageRoute, worktreeUrl } from "../navigation";
import { PythonPreparationNotice } from "../PythonEnvironmentStatus";
import { useShell, useWorkspace } from "../shell";
import type { Worktree } from "../types";
import { useFlowView } from "../useFlowView";
import { useWorktree } from "../worktree";
import { PageLoading, RouteError } from "./PageStates";

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
    runDiagnostics,
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
    ? pathPrefix(flowView.path) + flowView.selected
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
      <WorkspaceNotices
        snapshot={snapshot}
        runDiagnostics={runDiagnostics}
        active={statuses.active}
        onResolve={() =>
          openModal({
            kind: "conflict",
            worktree: id,
            conflict: snapshot.conflicts[0].id,
          })
        }
        onViewFiles={(diagnostic) =>
          diagnostic.node
            ? void navigate(
                worktreeUrl(id, "flow", environment, { node: diagnostic.node }),
              )
            : diagnostic.variable
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
        key={`code:${id}`}
        hidden={tab !== "code"}
        readOnly={!canEdit}
        snapshot={snapshot}
        onSave={saveFiles}
      />
      <Outlet key={id} context={flowView} />
      {snapshot.python_enabled && (
        <PythonPreparationNotice
          key={`python:${tree.project}`}
          project={tree.project}
          active={saving || starting || !!statuses.active}
        />
      )}
    </>
  );
}

/** WorktreePage keeps the code editor mounted on every tab, so its draft survives. */
export function CodePage() {
  return null;
}
