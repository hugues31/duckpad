import { identifier, nodeChoices } from "./graph";
import { nodeCode, nodeGraph, setNodeCode } from "./nodeCode";
import type { Bundle, FlowEdge, FlowNode } from "./types";

/** How far a paste shifts its nodes while they would cover existing ones. */
export const PASTE_OFFSET = 40;

/** Nodes copied from a graph, with the edges between them and their code. */
export interface CopiedNodes {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** The code of every node except component instances, by copied node ID. */
  code: Record<string, string>;
}

// The browser tab's clipboard: nodes can be pasted in another graph or branch.
let clipboard: CopiedNodes | null = null;

export const copiedNodes = () => clipboard;

/** Copy nodes of a graph, with the edges that connect them to each other. */
export function nodeCopies(
  bundle: Bundle,
  parent: string | undefined,
  ids: string[],
): CopiedNodes | null {
  const graph = nodeGraph(bundle, parent);
  const nodes = graph.nodes.filter((node) => ids.includes(node.id));
  if (!nodes.length) return null;
  return structuredClone({
    nodes,
    edges: graph.edges.filter(
      (edge) =>
        nodes.some((node) => node.id === edge.source) &&
        nodes.some((node) => node.id === edge.target),
    ),
    code: Object.fromEntries(
      nodes
        .filter((node) => !node.component)
        .map((node) => [node.id, nodeCode(bundle, node, parent)]),
    ),
  });
}

export function copyNodes(
  bundle: Bundle,
  parent: string | undefined,
  ids: string[],
) {
  const copied = nodeCopies(bundle, parent, ids);
  if (!copied) return null;
  clipboard = copied;
  return clipboard;
}

/**
 * The copied nodes a bundle can receive in one of the opened graphs: not the
 * components that are missing or would contain the opened components.
 */
export function pastableNodes(
  bundle: Bundle,
  copied: CopiedNodes,
  opened: string[],
) {
  const components = new Set(
    nodeChoices({}, bundle.components, opened).map((choice) => choice.id),
  );
  return copied.nodes.filter(
    (node) => !node.component || components.has(node.component),
  );
}

/**
 * Add copies of the pastable nodes to a graph of the bundle and return their
 * IDs. Copies get new IDs and are shifted until none covers an existing node.
 * Nodes whose template is missing keep their copied code.
 */
export function pasteNodes(
  bundle: Bundle,
  parent: string | undefined,
  copied: CopiedNodes,
  opened: string[],
  { detach = false }: { detach?: boolean } = {},
): string[] {
  const graph = nodeGraph(bundle, parent);
  const nodes = pastableNodes(bundle, copied, opened);
  const covers = (shift: number) =>
    nodes.some((node) =>
      graph.nodes.some(
        (other) =>
          Math.abs(other.position.x - node.position.x - shift) <
            PASTE_OFFSET / 2 &&
          Math.abs(other.position.y - node.position.y - shift) <
            PASTE_OFFSET / 2,
      ),
    );
  let shift = 0;
  while (covers(shift)) shift += PASTE_OFFSET;
  const ids = new Map(nodes.map((node) => [node.id, identifier()]));
  for (const node of nodes) {
    const copy: FlowNode = {
      ...structuredClone(node),
      id: ids.get(node.id)!,
      position: { x: node.position.x + shift, y: node.position.y + shift },
    };
    if (
      copy.template &&
      (detach || bundle.templates[copy.template] === undefined)
    ) {
      // Another branch or project lacks the template: the copy owns its code.
      copy.preset ||= copy.template;
      if (detach) copy.origin ||= copy.template;
      delete copy.template;
    }
    if (!copy.template && !copy.component)
      setNodeCode(bundle, copy, copied.code[node.id] ?? "", parent);
    graph.nodes.push(copy);
  }
  for (const edge of copied.edges) {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (source && target)
      graph.edges.push({ ...edge, id: identifier("edge"), source, target });
  }
  return [...ids.values()];
}
