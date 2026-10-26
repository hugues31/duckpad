import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Connection,
  type NodeProps,
  type Node,
  type NodeChange,
  applyNodeChanges,
} from "@xyflow/react";
import {
  Database,
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
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import { useT, templateLabel } from "./i18n";
import { type Json, type FlowNode, type FlowEdge } from "./types";

export const nodeIcon = (key: string) =>
  key.includes("export")
    ? FileOutput
    : key === "join"
      ? GitMerge
      : key === "filter"
        ? Filter
        : key === "aggregate" || key.includes("metrics")
          ? Sigma
          : key.startsWith("load_")
            ? FileInput
            : key === "component"
              ? Boxes
              : Code2;
const statusIcon = (status: string) =>
  status === "valid" || status === "success"
    ? Check
    : status === "running" || status === "preparing"
      ? Loader2
      : status === "stale" || status === "failed" || status === "blocked"
        ? AlertCircle
        : Circle;

function PipelineNode({ data, selected }: NodeProps<Node<Json>>) {
  const t = useT();
  const Icon = nodeIcon(data.icon);
  const Status = statusIcon(data.status);
  const source = data.kind === "source";
  return (
    <div
      className={`pipeline-node ${source ? "source-node" : "round-node"} ${data.kind} ${selected ? "is-selected" : ""} status-${data.status}`}
    >
      <div className="node-shape">
        <Icon size={27} strokeWidth={1.6} />
        {data.status && (
          <span className={`node-status ${data.status}`}>
            <Status
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
          style={{ top: source ? 32 + i * 32 : 37 + i * 32 }}
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
          style={{ top: source ? 32 + i * 32 : 25 + i * 22 }}
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
export interface CanvasProps {
  readOnly?: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
  parsed: Record<string, Json>;
  components: Record<string, Json>;
  statuses: Json;
  prefix: string;
  viewKey: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMove: (nodes: FlowNode[]) => void;
  onConnect: (c: Connection) => void;
  onDelete: (nodes: string[], edges: string[]) => void;
  onAdd: (
    kind: string,
    id: string,
    position?: { x: number; y: number },
  ) => void;
  onOpen: (id: string) => void;
  onSelection: (ids: string[]) => void;
}
function CanvasInner(props: CanvasProps) {
  const t = useT();
  const { fitView, screenToFlowPosition } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const displayNodes = useMemo(
    () =>
      props.nodes.map((node) => {
        const definition = node.component
          ? props.components[node.component]
          : props.parsed[node.template || ""];
        const inputs = node.component
          ? Object.keys(definition?.inputs || {})
          : definition?.inputs || [];
        const outputs = node.component
          ? Object.keys(definition?.outputs || {})
          : definition?.outputs || [];
        const result = props.statuses.nodes?.[props.prefix + node.id];
        const nested = Object.entries(props.statuses.nodes || {})
          .filter(([id]) => id.startsWith(props.prefix + node.id + "::"))
          .map(([, v]) => v as Json);
        const states = [result, ...nested].filter(Boolean);
        const active = Object.entries(props.statuses.active?.nodes || {})
          .filter(
            ([id]) =>
              id === props.prefix + node.id ||
              id.startsWith(props.prefix + node.id + "::"),
          )
          .map(([, v]) => (v as Json).status);
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
                          (o: any) => o.status === "stale",
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
          type: "pipeline",
          position: node.position || { x: 0, y: 0 },
          selected: node.id === props.selected,
          data: {
            label:
              node.label ||
              definition?.name ||
              templateLabel(node.template || "sql", definition?.label, t),
            kind: node.component
              ? "component"
              : definition?.kind || "transform",
            inputs,
            outputs,
            status,
            icon: node.component ? "component" : node.template,
            subtitle:
              node.component || outputs.length > 1
                ? `${outputs.length} ${t("outputs")}`
                : Object.values(result?.outputs || {}).length === 1
                  ? `${(Object.values(result.outputs)[0] as Json).count.toLocaleString()} ${t("rows")}`
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
  const [nodes, setNodes] = useState<Node<Json>[]>(displayNodes);
  useEffect(
    () =>
      setNodes((previous) =>
        displayNodes.map((node) => ({
          ...node,
          selected:
            previous.find((old) => old.id === node.id)?.selected ??
            node.selected,
        })),
      ),
    [displayNodes],
  );
  useEffect(() => {
    const timeout = setTimeout(
      () => fitView({ padding: 0.12, maxZoom: 1 }),
      100,
    );
    return () => clearTimeout(timeout);
  }, [props.viewKey, width, height, fitView]);
  const selectionChanged = useCallback(
    ({ nodes }: { nodes: Node<Json>[] }) =>
      props.onSelection(nodes.map((n) => n.id)),
    [props.onSelection],
  );
  const edges = useMemo(
    () =>
      props.edges.map((e) => ({
        ...e,
        type: "smoothstep",
        animated: !!props.statuses.active,
        style: { stroke: "#a4b7c3", strokeWidth: 1.6 },
      })),
    [props.edges, !!props.statuses.active],
  );
  const changes = (changes: NodeChange<Node<Json>>[]) =>
    setNodes((current) => applyNodeChanges(changes, current));
  return (
    <ReactFlow
      nodesDraggable={!props.readOnly}
      nodesConnectable={!props.readOnly}
      edgesReconnectable={!props.readOnly}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={changes}
      onNodeClick={(_, node) => props.onSelect(node.id)}
      onPaneClick={() => props.onSelect(null)}
      onNodeDoubleClick={(_, node) => props.onOpen(node.id)}
      onConnect={props.readOnly ? undefined : props.onConnect}
      onNodeDragStop={(_, __, moved) =>
        props.onMove(
          moved.map((n) => ({
            ...props.nodes.find((x) => x.id === n.id)!,
            position: n.position,
          })),
        )
      }
      onDelete={({ nodes, edges }) =>
        !props.readOnly &&
        props.onDelete(
          nodes.map((n) => n.id),
          edges.map((e) => e.id),
        )
      }
      onSelectionChange={selectionChanged}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        if (props.readOnly) return;
        event.preventDefault();
        try {
          const value = JSON.parse(
            event.dataTransfer.getData("application/duckpad"),
          );
          props.onAdd(
            value.kind,
            value.id,
            screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          );
        } catch {}
      }}
      fitView
      ariaLabelConfig={{
        "controls.ariaLabel": t("canvasControls"),
        "controls.zoomIn.ariaLabel": t("zoomIn"),
        "controls.zoomOut.ariaLabel": t("zoomOut"),
        "controls.fitView.ariaLabel": t("fitView"),
        "minimap.ariaLabel": t("minimap"),
      }}
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.25}
      maxZoom={1.8}
      deleteKeyCode={props.readOnly ? null : ["Backspace", "Delete"]}
      selectionKeyCode="Shift"
      multiSelectionKeyCode="Shift"
      proOptions={{ hideAttribution: true }}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={22}
        size={1}
        color="var(--grid)"
      />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) =>
          n.data.kind === "source"
            ? "#a8d9ca"
            : n.data.kind === "component"
              ? "#bdc3f3"
              : "#c5d1dd"
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
  );
}
export default function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
