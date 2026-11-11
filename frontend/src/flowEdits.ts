import {
  connectInput,
  graphAt,
  type NodeConnection,
  type NodeKind,
  type PathPart,
} from "./graph";
import {
  detachNode,
  freshNodeCode,
  nodeCodePath,
  setNodeCode,
} from "./nodeCode";
import type { Bundle, FlowEdge, FlowNode, Json, ParsedTemplate } from "./types";

export type RemovalMode = "disconnect" | "reconnect";

/** A Filter node's code when the project has no `filter` template to copy. */
const FILTER_SQL =
  "-- @label Filter\n-- @input source\n-- @param condition: expression(source)\n-- @output result\nSELECT * FROM {{ source }} WHERE {{ condition }};\n";

export function addFlowNode(
  value: Bundle,
  path: PathPart[],
  created: FlowNode,
  kind: NodeKind,
  linked: boolean,
  connection?: NodeConnection,
) {
  const parent = path.at(-1)?.definition;
  const g = graphAt(value, path);
  if (kind === "template" && !linked) {
    detachNode(value, created, parent);
    freshNodeCode(value, created, parent);
  }
  g.nodes.push(created);
  if (connection)
    connectInput(
      g,
      connection.handleType === "source"
        ? {
            source: connection.nodeId,
            sourceHandle: connection.handleId,
            target: created.id,
            targetHandle: connection.port,
          }
        : {
            source: created.id,
            sourceHandle: connection.port,
            target: connection.nodeId,
            targetHandle: connection.handleId,
          },
    );
  return created.id;
}

export function dropFlowFiles(
  value: Bundle,
  path: PathPart[],
  uploads: {
    id: string;
    name: string;
    template: string;
    path: string;
    code: string;
    settings: Record<string, Json>;
  }[],
  position: FlowNode["position"],
) {
  const parent = path.at(-1)?.definition;
  let selected = "";
  const graph = graphAt(value, path);
  uploads.forEach((upload, index) => {
    const created: FlowNode = {
      id: upload.id,
      label: upload.name,
      preset: upload.template,
      params: { file: upload.path, ...upload.settings },
      position: {
        x: position.x + (index % 3) * 260,
        y: position.y + Math.floor(index / 3) * 160,
      },
    };
    setNodeCode(value, created, upload.code, parent);
    graph.nodes.push(created);
    selected ||= created.id;
  });
  return selected;
}

export function removeFlowNodes(
  value: Bundle,
  path: PathPart[],
  ids: string[],
  edges: string[] = [],
  reconnected: FlowEdge[] = [],
) {
  const parent = path.at(-1)?.definition;
  const g = graphAt(value, path);
  g.nodes
    .filter((node) => ids.includes(node.id))
    .forEach(
      (node) =>
        delete value.node_sql?.[nodeCodePath(node.id, parent, node.language)],
    );
  g.nodes = g.nodes.filter((n) => !ids.includes(n.id));
  g.edges = g.edges.filter(
    (e) =>
      !edges.includes(e.id) &&
      !ids.includes(e.source) &&
      !ids.includes(e.target),
  );
  g.edges.push(...reconnected);
}

export function addFlowFilter(
  value: Bundle,
  path: PathPart[],
  created: FlowNode,
  node: FlowNode,
  port: string,
  reusable: boolean | undefined,
  filter: ParsedTemplate | undefined,
) {
  const parent = path.at(-1)?.definition;
  const g = graphAt(value, path);
  if (reusable) {
    created.template = "filter";
    detachNode(value, created, parent);
    freshNodeCode(value, created, parent);
  } else {
    created.preset = "filter";
    setNodeCode(value, created, FILTER_SQL, parent);
  }
  g.nodes.push(created);
  connectInput(g, {
    source: node.id,
    sourceHandle: port,
    target: created.id,
    targetHandle: reusable ? filter!.inputs![0] : "source",
  });
  return created.id;
}
