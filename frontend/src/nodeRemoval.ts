import { nodeInterface } from "./graph";
import { localDefinitions } from "./nodeCode";
import type { FlowEdge, Snapshot } from "./types";

/**
 * The links that bypass a removed node, or null when a bypass would have to
 * guess between ports or replace another input's source.
 */
export function planNodeReconnection(
  snapshot: Snapshot,
  id: string,
  parent?: string,
): FlowEdge[] | null {
  const bundle = snapshot.bundle;
  const node = bundle?.flow.nodes.find((item) => item.id === id);
  if (parent || !bundle || !node || node.component) return null;
  const local = localDefinitions(snapshot);
  const signature = (id: string) => {
    const item = bundle.flow.nodes.find((item) => item.id === id);
    return (
      item &&
      nodeInterface(item, snapshot.parsed_templates, bundle.components, local)
    );
  };
  const definition = local[node.id];
  if (
    definition.error ||
    definition.writes_external ||
    definition.inputs?.length !== 1 ||
    definition.outputs?.length !== 1
  )
    return null;
  const incoming = bundle.flow.edges.filter((edge) => edge.target === node.id);
  const outgoing = bundle.flow.edges.filter((edge) => edge.source === node.id);
  if (incoming.length !== 1 || !outgoing.length) return null;
  const input = incoming[0];
  if (
    input.source === node.id ||
    input.targetHandle !== definition.inputs[0] ||
    !signature(input.source)?.outputs.includes(input.sourceHandle)
  )
    return null;
  const destinations = new Set<string>();
  for (const edge of outgoing) {
    const destination = JSON.stringify([edge.target, edge.targetHandle]);
    if (
      // Bypassing a loop back to the source would link it to itself.
      edge.target === input.source ||
      edge.sourceHandle !== definition.outputs[0] ||
      !signature(edge.target)?.inputs.includes(edge.targetHandle) ||
      destinations.has(destination) ||
      bundle.flow.edges.some(
        (other) =>
          other.source !== node.id &&
          other.target === edge.target &&
          other.targetHandle === edge.targetHandle,
      )
    )
      return null;
    destinations.add(destination);
  }
  // Keep each consumer's port and link identity, so undo tracks the same links.
  return outgoing.map((edge) => ({
    ...edge,
    source: input.source,
    sourceHandle: input.sourceHandle,
  }));
}
