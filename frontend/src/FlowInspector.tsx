import type { ActionItem } from "./ActionMenu";
import Inspector from "./Inspector";
import NodeCodePanel, { type CodeReveal } from "./NodeCodePanel";
import { connectInput, graphAt, type PathPart } from "./graph";
import { nodeLabel, useT } from "./i18n";
import type { Cell } from "./lineageGraph";
import { nodeEntity } from "./nodeCode";
import type { ResultsTab } from "./results";
import type { Bundle, FlowNode, Graph, Snapshot } from "./types";
import { FlowLocation } from "./useFlowView";
import { declarations } from "./variables";

export default function FlowInspector({
  panels,
  busy,
  node,
  definition,
  codeShown,
  inspected,
  snapshot,
  parent,
  fullNode,
  signature,
  environment,
  canEdit,
  statuses,
  preview,
  codeReveal,
  sample,
  setSample,
  requestPreview,
  updateDraft,
  view,
  setCodeReveal,
  graph,
  local,
  connections,
  fromInspector,
  save,
  path,
  safe,
  updateGraph,
  removeNodes,
  run,
  openComponent,
  editCode,
  actionsFor,
  openModal,
  showResults,
}: {
  panels: {
    open: Record<"palette" | "inspector" | "preview", boolean>;
    set: (
      change: Partial<Record<"palette" | "inspector" | "preview", boolean>>,
    ) => void;
  };
  busy: boolean;
  node: FlowNode | undefined;
  definition:
    | import("./types").ParsedTemplate
    | import("./types").ComponentDefinition
    | undefined;
  codeShown: boolean;
  inspected: string;
  snapshot: Snapshot;
  parent: string | undefined;
  fullNode: string;
  signature: import("./graph").NodeInterface | undefined;
  environment: string;
  canEdit: boolean;
  statuses: import("./types").Statuses;
  preview: import("./draftPreview").PreviewState | null;
  codeReveal: CodeReveal | null;
  sample: 100 | 1000 | 10000 | null;
  setSample: import("react").Dispatch<
    import("react").SetStateAction<100 | 1000 | 10000 | null>
  >;
  requestPreview: (
    code?: string,
    rows?: import("./draftPreview").SampleSize,
  ) => Promise<void>;
  updateDraft: (code: string | null) => void;
  view: {
    change: (update: Partial<FlowLocation>) => void;
    worktree: string;
    environment: string;
    path: PathPart[];
    selected: string | null;
    revealed: string;
    cell: Cell | null;
    code: boolean;
  };
  setCodeReveal: import("react").Dispatch<
    import("react").SetStateAction<CodeReveal | null>
  >;
  graph: Graph;
  local: Record<string, import("./types").ParsedTemplate>;
  connections: {
    id: string;
    name: string;
    family: import("./types").ConnectorFamily | null;
    capabilities: ("read" | "write")[];
  }[];
  fromInspector: <T>(key: string, saving: Promise<T>) => Promise<T>;
  save: (base: Snapshot, change: (bundle: Bundle) => void) => Promise<Snapshot>;
  path: PathPart[];
  safe: (action: () => Promise<unknown>) => void;
  updateGraph: (change: (graph: Graph) => void) => Promise<void>;
  removeNodes: (ids: string[], edges?: string[]) => Promise<void>;
  run: (
    node?: string,
    options?: import("./partitions").PartitionLaunchOptions,
  ) => Promise<void>;
  openComponent: (id: string) => void;
  editCode: (line?: number, target?: string) => void;
  actionsFor: (target: FlowNode) => ActionItem[];
  openModal: (modal: import("./ModalHost").ModalState) => void;
  showResults: (tab: ResultsTab) => void;
}) {
  const t = useT();
  const worktree = snapshot.worktree.id;
  return (
    <div
      className="inspector-layer"
      id="node-inspector"
      hidden={!panels.open.inspector}
      inert={busy}
    >
      {node && definition && signature && codeShown ? (
        <NodeCodePanel
          key={inspected}
          snapshot={snapshot}
          node={node}
          parent={parent}
          fullNode={fullNode}
          label={nodeLabel(node, signature!, t)}
          environment={environment}
          readOnly={!canEdit}
          statuses={statuses}
          preview={
            preview?.node === fullNode && preview.environment === environment
              ? preview
              : null
          }
          reveal={codeReveal}
          sample={sample}
          onSample={(size) => {
            setSample(size);
            // A shown preview follows the sample size.
            if (preview?.node === fullNode && !preview.missing?.length)
              void requestPreview(undefined, size);
          }}
          onPreview={(code) => void requestPreview(code)}
          onDraft={updateDraft}
          onClose={() => {
            view.change({ code: false });
            setCodeReveal(null);
          }}
        />
      ) : node && definition && signature ? (
        <Inspector
          readOnly={!canEdit}
          key={inspected}
          node={node}
          parent={parent}
          signature={signature}
          snapshot={snapshot}
          graphNodes={graph.nodes}
          local={local}
          graphEdges={graph.edges}
          fullNode={fullNode}
          environment={environment}
          connections={connections}
          statuses={statuses}
          onSave={(updated, base, variables) =>
            fromInspector(
              inspected,
              save(base, (value) => {
                const target = graphAt(value, path);
                target.nodes = target.nodes.map((n) =>
                  n.id === updated.id ? updated : n,
                );
                if (!Object.keys(variables).length) return;
                // A malformed file is never overwritten with new declarations.
                const current = declarations(value);
                if (!current) throw new Error(t("invalidVariablesFile"));
                value.variables = { ...current, ...variables };
              }),
            )
          }
          onSaveDocumentation={(change, base) =>
            fromInspector(
              inspected,
              save(base, (value) => change(value.documentation)),
            )
          }
          onInput={(port, source) =>
            safe(() =>
              updateGraph((g) => {
                if (!source) {
                  g.edges = g.edges.filter(
                    (e) => !(e.target === node.id && e.targetHandle === port),
                  );
                  return;
                }
                const [id, handle] = source.split(":");
                connectInput(g, {
                  source: id,
                  sourceHandle: handle,
                  target: node.id,
                  targetHandle: port,
                });
              }),
            )
          }
          onDelete={() => safe(() => removeNodes([node.id]))}
          onRun={() => run(fullNode)}
          onOpen={() => openComponent(node.id)}
          onEditTemplate={() => editCode()}
          actions={() =>
            actionsFor(node).filter(
              (action) => !["edit", "remove"].includes(action.id),
            )
          }
          onHistory={() =>
            openModal({
              kind: "git",
              worktree,
              mode: "compare",
              entity: nodeEntity(node.id, parent),
            })
          }
          onResults={showResults}
          onClose={() => panels.set({ inspector: false })}
        />
      ) : null}
    </div>
  );
}
