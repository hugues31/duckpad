import type { ComponentDefinition, FlowNode, Statuses } from "./types";

/** Follow the primary exposed port; summing component internals double-counts rows. */
export function primaryOutputCount(
  node: FlowNode,
  id: string,
  ports: string[],
  components: Record<string, ComponentDefinition>,
  statuses: Statuses,
) {
  let port = ports.includes("result") ? "result" : ports[0];
  if (!port) return undefined;
  let current = node;
  const seen = new Set<string>();
  while (current.component) {
    if (seen.has(current.component)) return undefined;
    seen.add(current.component);
    const definition = components[current.component];
    const output = definition?.outputs?.[port];
    const child =
      output && definition.nodes.find((item) => item.id === output.node);
    if (!output || !child) return undefined;
    id += `::${output.node}`;
    port = output.port;
    current = child;
  }
  return statuses.nodes[id]?.outputs[port]?.count;
}

export const showMinimap = (width: number, height: number) =>
  width >= 640 && height >= 420;
