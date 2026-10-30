import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Controls,
  ControlButton,
  Handle,
  MiniMap,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
  getNodesBounds,
  getViewportForBounds,
  type Connection,
  type NodeProps,
  type Node,
  type NodeChange,
  applyNodeChanges,
} from "@xyflow/react";
import {
  FileInput,
  GitMerge,
  Filter,
  Sigma,
  FileOutput,
  Code2,
  Boxes,
  Check,
  AlertCircle,
  Loader2,
  Circle,
  Sparkles,
  Maximize,
  Workflow,
  type LucideProps,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import { useT, templateLabel } from "./i18n";
import { DRAG_TYPE, nodeInterface, type NodeConnection } from "./graph";
import ConnectionPalette from "./ConnectionPalette";
import { layoutNodes } from "./graphLayout";
import { SearchField } from "./Search";
import type { NodeKind } from "./NodePalette";
import type {
  ComponentDefinition,
  FlowEdge,
  FlowNode,
  ParsedTemplate,
  Statuses,
  TemplateKind,
} from "./types";

/** The icon of a template, from its ID, or of any component. */
export function NodeIcon({ kind, ...props }: LucideProps & { kind: string }) {
  if (kind.includes("export")) return <FileOutput {...props} />;
  if (kind === "join") return <GitMerge {...props} />;
  if (kind === "filter") return <Filter {...props} />;
  if (kind === "aggregate" || kind.includes("metrics"))
    return <Sigma {...props} />;
  if (kind.startsWith("load_")) return <FileInput {...props} />;
  if (kind === "component") return <Boxes {...props} />;
  return <Code2 {...props} />;
}
function StatusIcon({ status, ...props }: LucideProps & { status: string }) {
  if (status === "valid" || status === "success") return <Check {...props} />;
  if (status === "running" || status === "preparing")
    return <Loader2 {...props} />;
  if (status === "stale" || status === "failed" || status === "blocked")
    return <AlertCircle {...props} />;
  return <Circle {...props} />;
}

/** What the canvas shows of a node. */
type PipelineData = {
  label: string;
  kind: TemplateKind | "component";
  inputs: string[];
  outputs: string[];
  /** The run or result state shown on the node, if any. */
  status: string;
  /** The template ID, or "component". */
  icon: string;
  subtitle?: string;
};
type PipelineNode = Node<PipelineData, "pipeline">;

function PipelineNode({ data, selected }: NodeProps<PipelineNode>) {
  const t = useT();
  const source = data.kind === "source";
  const portPosition = (index: number, count: number) => {
    const spacing = Math.min(24, 72 / Math.max(1, count - 1));
    const top = 48 + (index - (count - 1) / 2) * spacing;
    const inset = source ? 27 : 75 - Math.sqrt(48 ** 2 - (top - 48) ** 2);
    return { top, inset };
  };
  return (
    <div
      className={`pipeline-node ${source ? "source-node" : "round-node"} ${data.kind} ${selected ? "is-selected" : ""}`}
    >
      <div className="node-shape">
        <NodeIcon kind={data.icon} size={27} strokeWidth={1.6} />
        {data.status && (
          <span className={`node-status ${data.status}`}>
            <StatusIcon
              status={data.status}
              size={12}
              className={data.status === "running" ? "spin" : ""}
            />
          </span>
        )}
      </div>
      <div className="node-title" title={data.label}>
        {data.label}
      </div>
      <div className="node-subtitle">{data.subtitle || t(data.kind)}</div>
      {data.inputs.map((port: string, i: number) => (
        <Handle
          key={"in" + port}
          type="target"
          position={Position.Left}
          id={port}
          style={{
            top: portPosition(i, data.inputs.length).top,
            left: portPosition(i, data.inputs.length).inset,
          }}
          title={port}
          aria-label={`${t("inputs")}: ${port}`}
        >
          <span className="handle-label in">{port}</span>
        </Handle>
      ))}
      {data.outputs.map((port: string, i: number) => (
        <Handle
          key={"out" + port}
          type="source"
          position={Position.Right}
          id={port}
          style={{
            top: portPosition(i, data.outputs.length).top,
            right: portPosition(i, data.outputs.length).inset,
          }}
          title={port}
          aria-label={`${t("output")}: ${port}`}
        >
          <span className="handle-label out">{port}</span>
        </Handle>
      ))}
    </div>
  );
}
const nodeTypes = { pipeline: PipelineNode };
interface CanvasProps {
  readOnly?: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
  parsed: Record<string, ParsedTemplate>;
  components: Record<string, ComponentDefinition>;
  excludedComponents: string[];
  statuses: Statuses;
  prefix: string;
  viewKey: string;
  selected: string | null;
  focusRequest?: { id: string; key: string } | null;
  onSelect: (id: string | null) => void;
  onMove: (nodes: FlowNode[]) => Promise<void>;
  onConnect: (edge: Omit<FlowEdge, "id">) => void;
  /** Resolve once the deletion is saved; reject if it failed. */
  onDelete: (nodes: string[], edges: string[]) => Promise<void>;
  onAdd: (
    kind: NodeKind,
    id: string,
    position?: { x: number; y: number },
    connection?: NodeConnection,
  ) => void;
  onOpen: (id: string) => void;
  onSelection: (ids: string[]) => void;
}
function CanvasInner(props: CanvasProps) {
  const t = useT();
  const { getNodes, setViewport, screenToFlowPosition } = useReactFlow();
  const initialized = useNodesInitialized();
  const safeArea = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const viewportTouched = useRef(false);
  const lastFit = useRef("");
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<{ id: string } | null>(
    props.focusRequest ? { id: props.focusRequest.id } : null,
  );
  // Each new request from the page focuses its node once.
  const [handledRequest, setHandledRequest] = useState(props.focusRequest);
  if (props.focusRequest !== handledRequest) {
    setHandledRequest(props.focusRequest);
    if (props.focusRequest) setFocus({ id: props.focusRequest.id });
  }
  const [pendingConnection, setPendingConnection] = useState<{
    endpoint: Omit<NodeConnection, "port">;
    position: { x: number; y: number };
    screen: { x: number; y: number };
  } | null>(null);
  const closeConnectionPalette = useCallback(
    () => setPendingConnection(null),
    [],
  );
  useEffect(() => {
    const element = safeArea.current!;
    const measure = () => {
      const next = {
        x: element.offsetLeft,
        y: element.offsetTop,
        width: element.clientWidth,
        height: element.clientHeight,
      };
      setFrame((previous) =>
        Object.keys(next).every(
          (key) =>
            previous[key as keyof typeof next] ===
            next[key as keyof typeof next],
        )
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  const fitGraph = useCallback(
    (graphNodes = getNodes()) => {
      if (!initialized || !frame.width || !frame.height) return;
      // Frame the unobscured area while keeping the graph surface behind every panel.
      const viewport = getViewportForBounds(
        getNodesBounds(graphNodes),
        frame.width,
        frame.height,
        0.1,
        1,
        0.12,
      );
      void setViewport({
        ...viewport,
        x: viewport.x + frame.x,
        y: viewport.y + frame.y,
      });
    },
    [initialized, frame, getNodes, setViewport],
  );
  const displayNodes = useMemo(
    () =>
      props.nodes.map((node) => {
        const signature = nodeInterface(node, props.parsed, props.components);
        const { kind, inputs, outputs } = signature;
        const result = props.statuses.nodes?.[props.prefix + node.id];
        const nested = Object.entries(props.statuses.nodes || {})
          .filter(([id]) => id.startsWith(props.prefix + node.id + "::"))
          .map(([, v]) => v);
        const states = result ? [result, ...nested] : nested;
        const active = Object.entries(props.statuses.active?.nodes || {})
          .filter(
            ([id]) =>
              id === props.prefix + node.id ||
              id.startsWith(props.prefix + node.id + "::"),
          )
          .map(([, v]) => v.status as string);
        const status = active.includes("running")
          ? "running"
          : active.includes("failed")
            ? "failed"
            : active.includes("blocked") ||
                states.some((s) => s.execution_status === "blocked")
              ? "blocked"
              : states.some((s) => s.execution_status === "canceled")
                ? "canceled"
                : states.some((s) => s.error)
                  ? "failed"
                  : states.some((s) =>
                        Object.values(s.outputs || {}).some(
                          (o) => o.status === "stale",
                        ),
                      )
                    ? "stale"
                    : states.some((s) => Object.keys(s.outputs || {}).length)
                      ? "valid"
                      : active.includes("success")
                        ? "success"
                        : "";
        return {
          id: node.id,
          type: "pipeline" as const,
          position: node.position || { x: 0, y: 0 },
          selected: node.id === props.selected,
          data: {
            label:
              node.label ||
              (signature.kind === "component"
                ? signature.definition?.name
                : undefined) ||
              templateLabel(
                node.template || "sql",
                signature.kind === "component"
                  ? undefined
                  : signature.definition?.label,
                t,
              ),
            kind,
            inputs,
            outputs,
            status,
            icon: node.component ? "component" : node.template || "",
            subtitle:
              node.component || outputs.length > 1
                ? `${outputs.length} ${t("outputs")}`
                : Object.values(result?.outputs || {}).length === 1
                  ? `${Object.values(result!.outputs)[0].count.toLocaleString()} ${t("rows")}`
                  : undefined,
          },
        };
      }),
    [
      props.nodes,
      props.parsed,
      props.components,
      props.statuses,
      props.prefix,
      props.selected,
      t,
    ],
  );
  const [nodes, setNodes] = useState<PipelineNode[]>(displayNodes);
  const matches = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/);
    if (!query.trim()) return [];
    return displayNodes.filter((node, index) => {
      const source = props.nodes[index];
      const text = [
        node.id,
        node.data.label,
        t(node.data.kind),
        source.template,
        source.component,
      ]
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [query, displayNodes, props.nodes, t]);
  useEffect(() => {
    if (!focus || !initialized || !frame.width || !frame.height) return;
    const target = getNodes().filter((node) => node.id === focus.id);
    if (!target.length) return;
    viewportTouched.current = true;
    fitGraph(target);
  }, [focus, initialized, frame, getNodes, fitGraph]);
  if (pendingConnection) {
    // Close the palette once its endpoint is gone or the graph became read-only.
    const { nodeId, handleId, handleType } = pendingConnection.endpoint;
    const origin = displayNodes.find((node) => node.id === nodeId);
    const ports = origin?.data[handleType === "source" ? "outputs" : "inputs"];
    if (props.readOnly || !ports?.includes(handleId))
      setPendingConnection(null);
  }
  const [pendingMoves, setPendingMoves] = useState(
    new Map<string, { position: FlowNode["position"] }>(),
  );
  const previousSelected = useRef(props.selected);
  // React Flow removes deleted nodes locally before the save; a failed save
  // leaves the snapshot unchanged, so restore the nodes explicitly.
  const [restore, setRestore] = useState(0);
  useEffect(() => {
    const selectionChanged = previousSelected.current !== props.selected;
    previousSelected.current = props.selected;
    setNodes((previous) =>
      displayNodes.map((node) => {
        const old = previous.find((item) => item.id === node.id);
        return {
          ...old,
          ...node,
          position: old?.dragging
            ? old.position
            : (pendingMoves.get(node.id)?.position ?? node.position),
          selected: selectionChanged
            ? node.selected
            : (old?.selected ?? node.selected),
        };
      }),
    );
  }, [displayNodes, props.selected, pendingMoves, restore]);
  useEffect(() => {
    if (!initialized || !frame.width || !frame.height) return;
    const layout = [
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      props.nodes.length,
    ].join(":");
    if (lastFit.current === layout) return;
    lastFit.current = layout;
    // Polls and node measurements must never undo a user's pan or zoom.
    if (!viewportTouched.current) fitGraph();
  }, [initialized, frame, props.nodes.length, fitGraph]);
  const { onSelection } = props;
  const selectionChanged = useCallback(
    ({ nodes }: { nodes: PipelineNode[] }) =>
      onSelection(nodes.map((n) => n.id)),
    [onSelection],
  );
  const running = !!props.statuses.active;
  const edges = useMemo(
    () =>
      props.edges.map((e) => {
        const connected = nodes.some(
          (n) => n.selected && (n.id === e.source || n.id === e.target),
        );
        const highlighted = connected || running;
        return {
          ...e,
          type: "smoothstep",
          animated: highlighted,
          className: connected ? "node-connected" : undefined,
          markerEnd: highlighted
            ? {
                type: MarkerType.ArrowClosed,
                color: "var(--accent)",
                width: 14,
                height: 14,
              }
            : undefined,
          style: {
            stroke: highlighted ? "var(--accent)" : "var(--edge)",
            strokeWidth: highlighted ? 2.3 : 1.8,
          },
        };
      }),
    [props.edges, nodes, running],
  );
  const changes = (changes: NodeChange<PipelineNode>[]) =>
    setNodes((current) => applyNodeChanges(changes, current));
  const persistPositions = async (moved: FlowNode[]) => {
    const pending = new Map(
      moved.map((node) => [node.id, { position: node.position }]),
    );
    // Keep local positions through both the write and its snapshot refresh.
    setPendingMoves((current) => new Map([...current, ...pending]));
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        position: pending.get(node.id)?.position ?? node.position,
      })),
    );
    try {
      await props.onMove(moved);
    } catch {
      // The workspace reports the error and refreshes the saved graph.
    } finally {
      setPendingMoves((current) => {
        const next = new Map(current);
        for (const [id, move] of pending) {
          // An earlier save must not discard a more recent local move.
          if (next.get(id) === move) next.delete(id);
        }
        return next;
      });
    }
  };
  const arrangeGraph = () => {
    if (props.readOnly || !initialized || !nodes.length) return;
    const arranged = layoutNodes(getNodes(), props.edges);
    const positions = new Map(arranged.map((node) => [node.id, node.position]));
    void persistPositions(
      props.nodes.map((node) => ({
        ...node,
        position: positions.get(node.id)!,
      })),
    );
    viewportTouched.current = false;
    fitGraph(arranged);
  };
  return (
    <>
      <div className="canvas-safe-area" ref={safeArea} aria-hidden="true" />
      <div
        className="canvas-search"
        style={{
          left: frame.x,
          top: frame.y,
          width: Math.min(300, Math.max(0, frame.width)),
        }}
      >
        <SearchField
          label={t("searchNodes")}
          shortcut="f"
          query={query}
          onQuery={setQuery}
          options={matches.map((node) => ({
            key: node.id,
            label: node.data.label,
            detail: `${t(node.data.kind)} · ${node.id}`,
          }))}
          onSelect={(index) => {
            const id = matches[index].id;
            props.onSelect(id);
            setNodes((nodes) =>
              nodes.map((node) => ({ ...node, selected: node.id === id })),
            );
            setFocus({ id });
          }}
        />
      </div>
      <ReactFlow
        nodesDraggable={!props.readOnly}
        nodesConnectable={!props.readOnly}
        edgesReconnectable={!props.readOnly}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={changes}
        onMoveStart={(event) => {
          if (event) {
            viewportTouched.current = true;
            setFocus(null);
            closeConnectionPalette();
          }
        }}
        onNodeDragStart={() => {
          viewportTouched.current = true;
        }}
        onNodeClick={(event, node) => {
          setFocus(null);
          if (!event.shiftKey) props.onSelect(node.id);
        }}
        onPaneClick={() => {
          setFocus(null);
          props.onSelect(null);
        }}
        onNodeDoubleClick={(_, node) => props.onOpen(node.id)}
        onConnect={
          props.readOnly
            ? undefined
            : (connection: Connection) =>
                props.onConnect(connection as Omit<FlowEdge, "id">)
        }
        onConnectStart={closeConnectionPalette}
        onConnectEnd={(event, connection) => {
          if (
            props.readOnly ||
            connection.isValid ||
            !connection.fromNode ||
            !connection.fromHandle?.id
          )
            return;
          const pointer =
            "changedTouches" in event ? event.changedTouches[0] : event;
          if (!pointer) return;
          const screen = { x: pointer.clientX, y: pointer.clientY };
          // Touch events retain the starting handle as their target.
          const target = document.elementFromPoint(screen.x, screen.y);
          if (!target?.classList.contains("react-flow__pane")) return;
          viewportTouched.current = true;
          setPendingConnection({
            endpoint: {
              nodeId: connection.fromNode.id,
              handleId: connection.fromHandle.id,
              handleType: connection.fromHandle.type,
            },
            position: screenToFlowPosition(screen),
            screen,
          });
        }}
        onNodeDragStop={(_, __, moved) =>
          void persistPositions(
            moved.map((n) => ({
              ...props.nodes.find((x) => x.id === n.id)!,
              position: n.position,
            })),
          )
        }
        onDelete={({ nodes, edges }) => {
          if (props.readOnly) return;
          props
            .onDelete(
              nodes.map((n) => n.id),
              edges.map((e) => e.id),
            )
            .catch(() => setRestore((value) => value + 1));
        }}
        onSelectionChange={selectionChanged}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          if (props.readOnly) return;
          event.preventDefault();
          try {
            const value = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
            props.onAdd(
              value.kind,
              value.id,
              screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            );
          } catch {
            // Ignore drops that are not palette items.
          }
        }}
        ariaLabelConfig={{
          "controls.ariaLabel": t("canvasControls"),
          "controls.zoomIn.ariaLabel": t("zoomIn"),
          "controls.zoomOut.ariaLabel": t("zoomOut"),
          "controls.fitView.ariaLabel": t("fitView"),
          "minimap.ariaLabel": t("minimap"),
        }}
        minZoom={0.1}
        maxZoom={1.8}
        connectionRadius={28}
        deleteKeyCode={
          props.readOnly || pendingConnection ? null : ["Backspace", "Delete"]
        }
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Shift"
        proOptions={{ hideAttribution: true }}
      >
        <Panel position="bottom-left" className="canvas-control-groups">
          <Controls
            showInteractive={false}
            showFitView={false}
            onZoomIn={() => {
              viewportTouched.current = true;
            }}
            onZoomOut={() => {
              viewportTouched.current = true;
            }}
          >
            <ControlButton
              onClick={() => {
                viewportTouched.current = false;
                fitGraph();
              }}
              title={t("fitView")}
              aria-label={t("fitView")}
            >
              <Maximize />
            </ControlButton>
          </Controls>
          <div
            className="canvas-layout-controls"
            role="group"
            aria-label={t("autoLayout")}
          >
            <ControlButton
              onClick={arrangeGraph}
              disabled={props.readOnly || !initialized || !nodes.length}
              title={t("autoLayout")}
              aria-label={t("autoLayout")}
            >
              <Workflow style={{ fill: "none" }} />
            </ControlButton>
          </div>
        </Panel>
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) =>
            n.data.kind === "source"
              ? "#4a8aff"
              : n.data.kind === "component"
                ? "#9d91df"
                : "#a4a4ac"
          }
          maskColor="var(--minimap-mask)"
        />
        {!nodes.length && (
          <div className="canvas-empty">
            <Sparkles size={30} />
            <h2>{t("noNodes")}</h2>
            <p>{t("noNodesHint")}</p>
          </div>
        )}
      </ReactFlow>
      {pendingConnection && !props.readOnly && (
        <ConnectionPalette
          parsed={props.parsed}
          components={props.components}
          excludedComponents={props.excludedComponents}
          handleType={pendingConnection.endpoint.handleType}
          screen={pendingConnection.screen}
          onClose={closeConnectionPalette}
          onChoose={(kind, id, port) => {
            props.onAdd(kind, id, pendingConnection.position, {
              ...pendingConnection.endpoint,
              port,
            });
            closeConnectionPalette();
          }}
        />
      )}
    </>
  );
}
export default function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider key={props.viewKey}>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
