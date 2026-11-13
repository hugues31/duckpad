import type { PreviewState, SampleSize } from "./draftPreview";
import {
  connectInput,
  graphAt,
  type NodeInterface,
  type NodeChoice,
  type PathPart,
} from "./graph";
import { nodeLabel, useT } from "./i18n";
import Inspector from "./Inspector";
import PaletteDetails from "./PaletteDetails";
import type { ModalState } from "./ModalHost";
import NodeCodePanel, { type CodeReveal } from "./NodeCodePanel";
import type { NodeAction } from "./nodeActions";
import { withAppearance } from "./appearanceCode";
import { nodeCode, nodeEntity, setNodeCode } from "./nodeCode";
import type { PartitionLaunchOptions } from "./partitions";
import type { ResultsTab } from "./results";
import type {
  Bundle,
  ComponentDefinition,
  FlowNode,
  Graph,
  ParsedTemplate,
  Snapshot,
  Statuses,
} from "./types";
import type { FlowView } from "./useFlowView";
import { declarations } from "./variables";
import type { PanelVisibility } from "./WorkspacePanels";

export default function FlowInspector({
  paletteChoice,
  paletteFocus,
  onClosePalette,
  onAddPalette,
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
  run,
  actionsFor,
  openModal,
  showResults,
}: {
  paletteChoice: NodeChoice | undefined;
  paletteFocus: boolean;
  onClosePalette: () => void;
  onAddPalette: (() => void) | undefined;
  panels: PanelVisibility;
  busy: boolean;
  node: FlowNode | undefined;
  definition: ParsedTemplate | ComponentDefinition | undefined;
  codeShown: boolean;
  inspected: string;
  snapshot: Snapshot;
  parent: string | undefined;
  fullNode: string;
  signature: NodeInterface | undefined;
  environment: string;
  canEdit: boolean;
  statuses: Statuses;
  preview: PreviewState | null;
  codeReveal: CodeReveal | null;
  sample: SampleSize;
  setSample: (size: SampleSize) => void;
  requestPreview: (code?: string, rows?: SampleSize) => Promise<void>;
  updateDraft: (code: string | null) => void;
  view: FlowView;
  setCodeReveal: (reveal: CodeReveal | null) => void;
  graph: Graph;
  local: Record<string, ParsedTemplate>;
  connections: Snapshot["connections"];
  fromInspector: <T>(key: string, saving: Promise<T>) => Promise<T>;
  save: (base: Snapshot, change: (bundle: Bundle) => void) => Promise<Snapshot>;
  path: PathPart[];
  safe: (action: () => Promise<unknown>) => void;
  updateGraph: (change: (graph: Graph) => void) => Promise<void>;
  run: (node?: string, options?: PartitionLaunchOptions) => Promise<void>;
  actionsFor: (target: FlowNode) => NodeAction[];
  openModal: (modal: ModalState) => void;
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
      {paletteChoice ? (
        <PaletteDetails
          key={`${paletteChoice.kind}:${paletteChoice.id}`}
          choice={paletteChoice}
          focus={paletteFocus}
          onClose={onClosePalette}
          onAdd={onAddPalette}
        />
      ) : node && definition && signature && codeShown ? (
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
          onAppearance={(appearance, base) =>
            fromInspector(
              inspected,
              save(base, (value) => {
                // A node removed meanwhile has no code left to style.
                if (!graphAt(value, path).nodes.some((n) => n.id === node.id))
                  return;
                setNodeCode(
                  value,
                  node,
                  withAppearance(
                    nodeCode(value, node, parent) ?? "",
                    node.language,
                    appearance,
                  ),
                  parent,
                );
              }),
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
          onRun={() => run(fullNode)}
          actions={actionsFor(node)}
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
