import type { DebugRequest } from "./AskAssistant";
import type { AssistantContext } from "./assistantTypes";
import type { usePageRoute } from "./navigation";
import type { useWorktree } from "./worktree";
export function assistantContext(
  route: ReturnType<typeof usePageRoute>,
  worktree: Pick<
    ReturnType<typeof useWorktree>,
    "id" | "snapshot" | "assistantNode" | "assistantFile"
  >,
  environment: string,
  debug: (DebugRequest & { worktree: string }) | null,
): AssistantContext {
  return {
    page: route.area,
    ...(route.tab ? { tab: route.tab } : {}),
    section: route.section || "",
    project: worktree.snapshot?.worktree.project || route.projectId || null,
    worktree: worktree.id,
    branch: worktree.snapshot?.worktree.branch || "",
    node: route.tab === "flow" ? worktree.assistantNode : "",
    file: route.tab === "code" ? worktree.assistantFile : "",
    environment,
    ...(debug?.worktree === worktree.id
      ? {
          run: debug.run,
          node: debug.node || "",
          environment: debug.environment,
        }
      : {}),
  };
}
