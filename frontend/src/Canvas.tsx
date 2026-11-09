import {
  applyNodeChanges,
  ControlButton,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type NodeChange,
} from "@xyflow/react";
import { Maximize, Sparkles, Workflow } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActionMenu } from "./ActionMenu";
import { PipelineNode } from "./CanvasNode";
import { showMinimap } from "./canvasResults";
import type { CanvasProps, FocusRequest } from "./canvasTypes";
import ConnectionPalette from "./ConnectionPalette";
import { DRAG_TYPE, type NodeConnection } from "./graph";
import { findNodePosition, layoutNodes } from "./graphLayout";
import { useT } from "./i18n";
import { SearchField } from "./Search";
import type { FlowEdge, FlowNode } from "./types";
import { useCanvasFrame } from "./useCanvasFrame";
import { useCanvasNodes } from "./useCanvasNodes";
import { useDoubleClickGuard } from "./useDoubleClickGuard";
const nodeTypes = { pipeline: PipelineNode };
function CanvasInner({ ref, ...props }: CanvasProps) {
  const t = useT();
  const [context, setContext] = useState<{
    id: string;
    position: { x: number; y: number };
    trigger: HTMLElement;
  } | null>(null);
  const { getNodes, screenToFlowPosition } = useReactFlow();
  const initialized = useNodesInitialized();
  const safeArea = useRef<HTMLDivElement>(null);
  const viewportTouched = useRef(false);
  useImperativeHandle(ref, () => ({
    newNodePosition: (graphNodes) => {
      const rendered = new Map(getNodes().map((node) => [node.id, node]));
      const area = safeArea.current?.getBoundingClientRect();
      const start = area && screenToFlowPosition({ x: area.left, y: area.top });
      const end =
        area && screenToFlowPosition({ x: area.right, y: area.bottom });
      return findNodePosition(
        graphNodes.map((node) => ({
          ...node,
          position: rendered.get(node.id)?.position ?? node.position,
          measured: rendered.get(node.id)?.measured,
        })),
        {
          selected: props.selected,
          visible:
            start && end
              ? {
                  ...start,
                  width: end.x - start.x,
                  height: end.y - start.y,
                }
              : undefined,
        },
      );
    },
  }));
  const lastFit = useRef("");
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<Omit<FocusRequest, "key"> | null>(
    props.focusRequest ?? null,
  );
  // Each new request from the page focuses its node once.
  const [handledRequest, setHandledRequest] = useState(props.focusRequest);
  if (props.focusRequest !== handledRequest) {
    setHandledRequest(props.focusRequest);
    if (props.focusRequest) setFocus(props.focusRequest);
  }
  const { frame, fitGraph } = useCanvasFrame(safeArea, focus, viewportTouched);
  const [pendingConnection, setPendingConnection] = useState<{
    endpoint: Omit<NodeConnection, "port">;
    position: { x: number; y: number };
    screen: { x: number; y: number };
  } | null>(null);
  const closeConnectionPalette = useCallback(
    () => setPendingConnection(null),
    [],
  );
  const flow = useRef<HTMLDivElement>(null);
  useDoubleClickGuard(flow, props.onOpen);
  const displayNodes = useCanvasNodes(props);
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
        ref={flow}
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
          // A warning badge opens the node's results on its log, a Failed badge on its error.
          const badge = event.shiftKey
            ? null
            : (event.target as Element).closest(
                ".warning-badge, .node-status.failed",
              );
          if (badge?.matches(".warning-badge")) props.onWarnings?.(node.id);
          else if (badge) props.onFailure?.(node.id);
        }}
        onPaneClick={() => {
          setFocus(null);
          props.onSelect(null);
        }}
        onNodeContextMenu={(event, node) => {
          // On a read-only branch, every action of this menu is disabled.
          if (props.readOnly) return;
          event.preventDefault();
          props.onSelect(node.id);
          setContext({
            id: node.id,
            position: { x: event.clientX, y: event.clientY },
            trigger: event.currentTarget as HTMLElement,
          });
        }}
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
          event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
            "Files",
          )
            ? "copy"
            : "move";
        }}
        onDrop={(event) => {
          if (props.readOnly) return;
          event.preventDefault();
          if (event.dataTransfer.files.length) {
            props.onFiles?.(
              Array.from(event.dataTransfer.files),
              screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            );
            return;
          }
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
          props.readOnly || pendingConnection || context
            ? null
            : ["Backspace", "Delete"]
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
        {showMinimap(frame.width, frame.height) && (
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
        )}
        {!nodes.length && (
          <div className="canvas-empty">
            <Sparkles size={30} />
            <h2>{t("noNodes")}</h2>
            <p>{t("noNodesHint")}</p>
          </div>
        )}
      </ReactFlow>
      {context && props.nodes.some((node) => node.id === context.id) && (
        <ActionMenu
          label={t("nodeActions")}
          items={props.actionsFor(context.id)}
          position={context.position}
          onClose={() => {
            setContext(null);
            context.trigger.focus();
          }}
        />
      )}
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
