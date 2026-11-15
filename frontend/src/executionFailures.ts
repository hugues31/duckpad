import { nodeStates } from "./canvasResults";
import type { NodeResult, Statuses } from "./types";

/** Whether a node, or a node inside a component, was blocked rather than run. */
export const wasBlocked = (statuses: Statuses, fullNode: string) =>
  nodeStates(statuses, fullNode).some(
    (state) => state.execution_status === "blocked",
  );

/** Errors of a selected node or component, with shared root causes shown once. */
export function executionFailures(statuses: Statuses, fullNode: string) {
  const failures = new Map<string, { node: string; result: NodeResult }>();
  for (const [node, result] of Object.entries(statuses.nodes)) {
    if (
      (node !== fullNode && !node.startsWith(fullNode + "::")) ||
      !result.error ||
      !["failed", "blocked"].includes(result.execution_status || "")
    )
      continue;
    const causes = (result.error_causes || []).flatMap(
      (key) => statuses.causes?.[key] || [],
    );
    // A node that failed itself, or whose blockers did not record an error.
    for (const cause of causes.length ? causes : [{ ...result, node }])
      failures.set(`${cause.error_run}:${cause.node}`, {
        node: cause.node,
        result: cause,
      });
  }
  return [...failures.values()];
}
