import { nodeInterface } from "./graph";
import { localDefinitions } from "./nodeCode";
import type { FlowEdge, Snapshot } from "./types";

/** Plan a bypass without guessing between ports or replacing another input's source. */
export function planNodeReconnection(
  snapshot: Snapshot,
  ids: string[],
  parent?: string,
): { edges: FlowEdge[]; connections: string } | null {
  if (ids.length !== 1) return null;
  const bundle = snapshot.bundle;
  const node = bundle?.flow.nodes.find((item) => item.id === ids[0]);
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
    !definition ||
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
  const remaining = bundle.flow.edges.filter(
    (edge) => edge.source !== node.id && edge.target !== node.id,
  );
  const destinations = new Set<string>();
  for (const edge of outgoing) {
    const destination = JSON.stringify([edge.target, edge.targetHandle]);
    if (
      edge.sourceHandle !== definition.outputs[0] ||
      !signature(edge.target)?.inputs.includes(edge.targetHandle) ||
      destinations.has(destination) ||
      remaining.some(
        (other) =>
          other.target === edge.target &&
          other.targetHandle === edge.targetHandle,
      )
    )
      return null;
    destinations.add(destination);
    // A path back to the upstream source would close a cycle (including a self-link).
    const seen = new Set<string>();
    const pending = [edge.target];
    while (pending.length) {
      const id = pending.pop()!;
      if (id === input.source || id === node.id) return null;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(
        ...remaining
          .filter((other) => other.source === id)
          .map((other) => other.target),
      );
    }
  }
  return {
    // Keep each consumer's port and link identity, so undo tracks the same links.
    edges: outgoing.map((edge) => ({
      ...edge,
      source: input.source,
      sourceHandle: input.sourceHandle,
    })),
    connections: JSON.stringify(
      [...incoming, ...outgoing].sort((a, b) => a.id.localeCompare(b.id)),
    ),
  };
}
