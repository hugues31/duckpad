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
