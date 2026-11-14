import { exposedSource, nodeInterface } from "./graph";
import { nodeLabel, templateLabel, type Translate } from "./i18n";
import { nodeIconKind } from "./nodeAppearance";
import { localDefinitions } from "./nodeCode";
import { displayNodeName } from "./nodeNames";
import { declaredTests } from "./ResultsTests";
import { outputKey } from "./results";
import { variableReference } from "./variables";
import type {
  ComponentDefinition,
  Dataset,
  ExecutionResult,
  FlowNode,
  Graph,
  Json,
  Snapshot,
  Statuses,
  TemplateKind,
  VariableSummary,
} from "./types";

export interface DocumentedColumn {
  name: string;
  type: string;
  description: string;
}

export interface DocumentedOutput {
  port: string;
  /** The retained result in the current environment, if the output has run. */
  dataset?: Dataset;
  description: string;
  columns: DocumentedColumn[];
  /** Names of the charts and shared views saved on the output. */
  charts: string[];
  views: string[];
}

export interface DocumentedTest {
  name: string;
  severity?: "warning" | "error";
  /** The latest outcome in the current environment; undefined before a run. */
  status?: ExecutionResult["status"];
  /** Failing rows counted by the latest execution. */
  observed?: number;
}

export interface DocumentedParameter {
  name: string;
  label: string;
  value: Json;
  /** The project variable bound to the parameter, shown instead of a value. */
  variable?: string;
  /** The connection chosen by the parameter, by its name. */
  connection?: string;
}

/** A node another one reads from or feeds. */
export interface DocumentedLink {
  id: string;
  label: string;
  /** The port of this node that the link uses, when it has several. */
  port?: string;
}

export interface DocumentedNode {
  /** The expanded ID, such as `report::summary`. */
  id: string;
  label: string;
  kind: TemplateKind | "component";
  /** What chooses the default icon: a template ID, "python" or "component". */
  icon: string;
  declaredIcon?: string;
  color?: string;
  /** The template or component the node instantiates, when its name differs. */
  definition?: string;
  language?: "sql" | "python";
  description: string;
  /** Whether the description was written for this node, not inherited. */
  documented: boolean;
  muted: boolean;
  /** The input ports the node declares, connected or not. */
  inputs: string[];
  parameters: DocumentedParameter[];
  reads: DocumentedLink[];
  feeds: DocumentedLink[];
  tests: DocumentedTest[];
  outputs: DocumentedOutput[];
  /** The nodes inside a component instance, in execution order. */
  steps: DocumentedNode[];
}

export interface DocumentedVariable extends VariableSummary {
  name: string;
}

export interface DocumentedConnection {
  id: string;
  name: string;
  family: Snapshot["connections"][number]["family"];
  capabilities: Snapshot["connections"][number]["capabilities"];
  usedBy: DocumentedLink[];
}

/** A node of the pipeline diagram, at its canvas position. */
export interface DiagramNode {
  id: string;
  label: string;
  kind: DocumentedNode["kind"];
  icon: string;
  declaredIcon?: string;
  color?: string;
  muted: boolean;
  x: number;
  y: number;
  inputs: string[];
  outputs: string[];
}

export interface DiagramEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

export interface ProjectDocumentation {
  name: string;
  description: string;
  sources: DocumentedNode[];
  transformations: DocumentedNode[];
  exports: DocumentedNode[];
  variables: DocumentedVariable[];
  connections: DocumentedConnection[];
  /** Every declared test with the node declaring it, components included. */
  tests: { node: DocumentedLink; test: DocumentedTest }[];
  diagram: { nodes: DiagramNode[]; edges: DiagramEdge[] };
  /** How much of the project its authors described. */
  coverage: {
    nodes: { documented: number; total: number };
    columns: { documented: number; total: number };
  };
}

/** The DOM ID of a node's section, also the target of links to it. */
export const nodeAnchor = (id: string) =>
  "doc-node-" + id.replaceAll("::", "--");

/**
 * Nodes in execution order: each after the nodes it reads. Nodes that could
 * run in any order keep their reading order on the canvas, left to right.
 */
function executionOrder(graph: Graph): FlowNode[] {
  const byReadingOrder = [...graph.nodes].sort(
    (a, b) =>
      (a.position?.x ?? 0) - (b.position?.x ?? 0) ||
      (a.position?.y ?? 0) - (b.position?.y ?? 0),
  );
  const ids = new Set(graph.nodes.map((node) => node.id));
  const waiting = new Map(byReadingOrder.map((node) => [node.id, 0]));
  const readers = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    waiting.set(edge.target, waiting.get(edge.target)! + 1);
    readers.set(edge.source, [
      ...(readers.get(edge.source) || []),
      edge.target,
    ]);
  }
  const ordered: FlowNode[] = [];
  const pending = [...byReadingOrder];
  while (pending.length) {
    // An invalid cycle still lists its nodes, in reading order.
    const index = Math.max(
      pending.findIndex((node) => !waiting.get(node.id)),
      0,
    );
    const [node] = pending.splice(index, 1);
    ordered.push(node);
    for (const reader of readers.get(node.id) || [])
      waiting.set(reader, waiting.get(reader)! - 1);
  }
  return ordered;
}

/** The names saved for an output in views.json or charts.json. */
function savedNames(file: unknown, key: string): string[] {
  if (!file || typeof file !== "object" || Array.isArray(file)) return [];
  const entries = (file as Record<string, unknown>)[key];
  return Array.isArray(entries)
    ? entries.flatMap((entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as { name?: unknown }).name === "string"
          ? [(entry as { name: string }).name]
          : [],
      )
    : [];
}

const isSet = (value: Json | undefined): value is Json =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(typeof value === "object" && !Object.keys(value).length);

/**
 * A read-only description of the project, from its authored files and the
 * results retained in the current environment.
 */
export function projectDocumentation(
  snapshot: Snapshot,
  statuses: Statuses,
  t: Translate,
): ProjectDocumentation | null {
  const bundle = snapshot.bundle;
  if (!bundle) return null;
  const docs = bundle.documentation;
  const connections = new Map(
    snapshot.connections.map((connection) => [connection.id, connection]),
  );
  const usedConnections = new Map<string, DocumentedLink[]>();

  /**
   * Describe the nodes of the flow or of one component instance. `overrides`
   * holds the values the instance gives to the parameters it exposes.
   */
  function describe(
    graph: Graph,
    prefix: string,
    parent: string | undefined,
    opened: string[],
    overrides: Map<string, Json>,
  ): DocumentedNode[] {
    const local = localDefinitions(snapshot, parent);
    const labels = new Map<string, string>();
    const signatures = new Map(
      graph.nodes.map((node) => [
        node.id,
        nodeInterface(
          node,
          snapshot.parsed_templates,
          bundle!.components,
          local,
        ),
      ]),
    );
    const label = (node: FlowNode) => {
      if (!labels.has(node.id))
        labels.set(
          node.id,
          displayNodeName(
            snapshot.node_names?.[prefix + node.id]?.slice(-1),
            nodeLabel(node, signatures.get(node.id)!, t),
            t,
          ),
        );
      return labels.get(node.id)!;
    };
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const link = (id: string, port: string, ports: string[]) => {
      const node = nodes.get(id);
      return node
        ? [
            {
              id: prefix + id,
              label: label(node),
              ...(ports.length > 1 ? { port } : {}),
            },
          ]
        : [];
    };
    return executionOrder(graph).map((node) => {
      const id = prefix + node.id;
      const signature = signatures.get(node.id)!;
      const definition = signature.definition;
      const name = label(node);
      const definitionName =
        signature.kind === "component"
          ? signature.definition?.name || node.component
          : templateLabel(
              node.preset || node.template || node.origin || "sql",
              signature.definition?.label,
              t,
            );
      const values = { ...node.params };
      for (const parameter of signature.parameters) {
        const override = overrides.get(node.id + "\0" + parameter.name);
        if (override !== undefined) values[parameter.name] = override;
      }
      const parameters = signature.parameters.flatMap((parameter) => {
        const value = values[parameter.name];
        if (!isSet(value)) return [];
        const connection =
          parameter.type === "connection" && typeof value === "string"
            ? connections.get(value)
            : undefined;
        if (connection) {
          const users = usedConnections.get(connection.id) || [];
          if (!users.some((user) => user.id === id))
            usedConnections.set(connection.id, [...users, { id, label: name }]);
        }
        return [
          {
            name: parameter.name,
            label: parameter.label || parameter.name.replaceAll("_", " "),
            value,
            ...(variableReference(value)
              ? { variable: variableReference(value)! }
              : {}),
            ...(connection ? { connection: connection.name } : {}),
          },
        ];
      });
      const results = statuses.nodes[id]?.results;
      const blocks =
        signature.kind === "component"
          ? []
          : signature.definition?.blocks || [];
      const component: ComponentDefinition | undefined =
        signature.kind === "component" ? signature.definition : undefined;
      return {
        id,
        label: name,
        kind: signature.kind,
        icon: nodeIconKind(node),
        ...(signature.kind === "component"
          ? {}
          : {
              declaredIcon: signature.definition?.icon,
              color: signature.definition?.color,
              language: signature.definition?.language || node.language,
            }),
        ...(definitionName && definitionName !== name
          ? { definition: definitionName }
          : {}),
        description: docs.nodes?.[id] || definition?.description || "",
        documented: !!docs.nodes?.[id],
        muted: !!node.muted,
        inputs: signature.inputs,
        parameters,
        reads: signature.inputs.flatMap((port) => {
          const edge = graph.edges.find(
            (edge) => edge.target === node.id && edge.targetHandle === port,
          );
          return edge
            ? link(
                edge.source,
                edge.sourceHandle,
                signatures.get(edge.source)?.outputs || [],
              )
            : [];
        }),
        feeds: graph.edges
          .filter((edge) => edge.source === node.id)
          .flatMap((edge) => link(edge.target, edge.sourceHandle, []))
          .filter(
            (target, index, all) =>
              all.findIndex((other) => other.id === target.id) === index,
          ),
        tests: declaredTests(signature, results).map((test) => {
          const outcome = results?.find(
            (item) => item.origin.kind === "test" && item.origin.name === test,
          );
          return {
            name: test,
            severity: blocks.find((block) => block.test_name === test)
              ?.test_severity,
            status: outcome?.status,
            ...(typeof outcome?.observed === "number"
              ? { observed: outcome.observed }
              : {}),
          };
        }),
        outputs: signature.outputs.map((port) => {
          const source = exposedSource(bundle!.components, node, id, port);
          const dataset = statuses.nodes[source.node]?.outputs[source.port];
          const key = outputKey({ node: id, port });
          const descriptions = docs.columns?.[key] || {};
          return {
            port,
            dataset,
            description: docs.datasets?.[key] || "",
            columns: (
              dataset?.columns ||
              Object.keys(descriptions).map((name) => ({ name, type: "" }))
            ).map((column) => ({
              ...column,
              description: descriptions[column.name] || "",
            })),
            charts: savedNames(bundle!.charts, outputKey(source)),
            views: savedNames(bundle!.views, outputKey(source)),
          };
        }),
        steps:
          component && node.component && !opened.includes(node.component)
            ? describe(
                component,
                id + "::",
                node.component,
                [...opened, node.component],
                new Map(
                  Object.entries(component.parameters || {}).flatMap(
                    ([parameter, exposed]) => {
                      const value = values[parameter] ?? exposed.default;
                      return value === undefined
                        ? []
                        : (exposed.targets || []).map(
                            (target) =>
                              [target.node + "\0" + target.param, value] as [
                                string,
                                Json,
                              ],
                          );
                    },
                  ),
                ),
              )
            : [],
      };
    });
  }

  const nodes = describe(bundle.flow, "", undefined, [], new Map());
  const flat = (list: DocumentedNode[], path = ""): DocumentedNode[] =>
    list.flatMap((node) => [
      path ? { ...node, label: path + node.label } : node,
      ...flat(node.steps, path + node.label + " / "),
    ]);
  const everyNode = flat(nodes);
  const columns = nodes.flatMap((node) =>
    node.outputs.flatMap((output) => output.columns),
  );
  const placed = new Map(bundle.flow.nodes.map((node) => [node.id, node]));
  return {
    name: bundle.flow.name,
    description: bundle.flow.description || "",
    sources: nodes.filter((node) => node.kind === "source"),
    transformations: nodes.filter(
      (node) => node.kind === "transform" || node.kind === "component",
    ),
    exports: nodes.filter((node) => node.kind === "export"),
    variables: Object.entries(snapshot.variables?.declarations || {}).map(
      ([name, variable]) => ({ name, ...variable }),
    ),
    connections: snapshot.connections.map((connection) => ({
      ...connection,
      usedBy: usedConnections.get(connection.id) || [],
    })),
    tests: everyNode.flatMap((node) =>
      node.tests.map((test) => ({
        node: { id: node.id, label: node.label },
        test,
      })),
    ),
    diagram: {
      nodes: nodes.map((node) => ({
        id: node.id,
        label: node.label,
        kind: node.kind,
        icon: node.icon,
        declaredIcon: node.declaredIcon,
        color: node.color,
        muted: node.muted,
        x: placed.get(node.id)?.position?.x ?? 0,
        y: placed.get(node.id)?.position?.y ?? 0,
        inputs: node.inputs,
        outputs: node.outputs.map((output) => output.port),
      })),
      edges: bundle.flow.edges
        .filter((edge) => placed.has(edge.source) && placed.has(edge.target))
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          sourcePort: edge.sourceHandle,
          target: edge.target,
          targetPort: edge.targetHandle,
        })),
    },
    coverage: {
      nodes: {
        documented: nodes.filter((node) => node.documented).length,
        total: nodes.length,
      },
      columns: {
        documented: columns.filter((column) => column.description).length,
        total: columns.length,
      },
    },
  };
}
