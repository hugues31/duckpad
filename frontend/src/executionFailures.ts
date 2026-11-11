import type { NodeResult, Statuses } from "./types";

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
    const causes = result.error_causes?.length
      ? result.error_causes
      : [{ ...result, node }];
    for (const cause of causes)
      failures.set(`${cause.error_run}:${cause.node}`, {
        node: cause.node,
        result: cause,
      });
  }
  return [...failures.values()];
}
