import { exposedSource } from "./graph";
import type { ComponentDefinition, FlowNode, Statuses } from "./types";

/** The row count of a node's primary output, through component boundaries. */
export function primaryOutputCount(
  node: FlowNode,
  id: string,
  ports: string[],
  components: Record<string, ComponentDefinition>,
  statuses: Statuses,
) {
  const port = ports.includes("result") ? "result" : ports[0];
  if (!port) return undefined;
  const source = exposedSource(components, node, id, port);
  return statuses.nodes[source.node]?.outputs[source.port]?.count;
}

export const showMinimap = (width: number, height: number) =>
  width >= 640 && height >= 420;

/** Retained states for a node and its nested component instances. */
export function nodeStates(statuses: Statuses, id: string) {
  const result = statuses.nodes?.[id];
  const nested = Object.entries(statuses.nodes || {})
    .filter(([key]) => key.startsWith(id + "::"))
    .map(([, v]) => v);
  const states = result ? [result, ...nested] : nested;

  return states;
}

/** Status precedence shared by canvas nodes and component summaries. */
export function nodeStatus(statuses: Statuses, id: string) {
  const states = nodeStates(statuses, id);
  const active = Object.entries(statuses.active?.nodes || {})
    .filter(([key]) => key === id || key.startsWith(id + "::"))
    .map(([, v]) => v.status as string);
  // A partitioned node whose keys failed has a failed status but no single error.
  return active.includes("running")
    ? "running"
    : active.includes("failed")
      ? "failed"
      : active.includes("blocked") ||
          states.some((s) => s.execution_status === "blocked")
        ? "blocked"
        : states.some((s) => s.execution_status === "canceled")
          ? "canceled"
          : states.some((s) => s.error || s.execution_status === "failed")
            ? "failed"
            : states.some((s) =>
                  Object.values(s.outputs || {}).some(
                    (o) => o.status === "stale",
                  ),
                )
              ? "stale"
              : states.some((s) => Object.keys(s.outputs || {}).length)
                ? "valid"
                : active.includes("success") ||
                    states.some((s) => s.execution_status === "success")
                  ? "success"
                  : "";
}
