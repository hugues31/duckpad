import {
  Handle,
  Position,
  useNodeId,
  useStore,
  useStoreApi,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { useT } from "./i18n";

export const PORT_GROUP_THRESHOLD = 5;

type Port = ComponentProps<typeof Handle>;
type PortsProps = {
  ports: Port[];
  type: "source" | "target";
  inset: number;
  preview?: boolean;
};

/** Keep every real handle mounted, so folding ports never changes saved links. */
export function CanvasPorts({ preview, ...props }: PortsProps) {
  if (props.ports.length >= PORT_GROUP_THRESHOLD) {
    return preview ? (
      <span
        className={`node-port-group node-port-preview ${props.type === "target" ? "in" : "out"}`}
        style={{ [props.type === "target" ? "left" : "right"]: props.inset }}
      >
        {props.ports.length}
      </span>
    ) : (
      <PortGroup {...props} />
    );
  }
  return props.ports.map((port) =>
    preview ? (
      <span
        key={port.id}
        className={`react-flow__handle react-flow__handle-${port.position} ${port.className || ""}`}
        style={port.style}
      >
        {port.children}
      </span>
    ) : (
      <Handle key={port.id} {...port} />
    ),
  );
}

function PortGroup({ ports, type, inset }: PortsProps) {
  const t = useT();
  const store = useStoreApi();
  const nodeId = useNodeId()!;
  const listId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const touch = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const connecting = useStore((state) => {
    const from =
      state.connection.fromHandle ?? state.connectionClickStartHandle;
    return from?.nodeId === nodeId && from?.type === type;
  });
  const connectable = useStore((state) => state.nodesConnectable);
  const expanded = !dismissed && (hovered || focused || connecting);
  const updateNodeInternals = useUpdateNodeInternals();
  const portIds = JSON.stringify(ports.map((port) => port.id));
  useEffect(() => {
    updateNodeInternals(nodeId);
  }, [nodeId, expanded, portIds, inset, updateNodeInternals]);
  const input = type === "target";
  const missing = ports.some((port) => port.className === "missing-input");
  const connected = ports.some((port) => port.className === "is-connected");
  const label = `${ports.length} ${t(input ? "inputs" : "outputs")}`;
  return (
    <div
      className={`node-port-group nodrag nopan ${input ? "in" : "out"} ${missing ? "missing-input" : connected ? "is-connected" : ""}`}
      data-expanded={expanded}
      style={{
        [input ? "left" : "right"]: inset,
        height: expanded ? ports.length * 28 + 32 : 40,
      }}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          clearTimeout(leaveTimer.current);
          setHovered(true);
          setDismissed(false);
        }
      }}
      onPointerLeave={() => {
        // Leave time to reach an adjacent link endpoint without folding under the pointer.
        leaveTimer.current = setTimeout(() => setHovered(false), 150);
      }}
      onPointerDownCapture={(event) => {
        touch.current = event.pointerType === "touch";
      }}
      onFocus={(event) => {
        // Dragging a socket also focuses it; only deliberate focus pins the list.
        setFocused(
          touch.current ||
            event.target.matches(".node-port-toggle, :focus-visible"),
        );
        setDismissed(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Port navigation must not move or delete the containing node.
        event.stopPropagation();
        if (event.key === "Escape") {
          store.getState().cancelConnection();
          store.setState({ connectionClickStartHandle: null });
          toggle.current?.focus();
          setDismissed(true);
        }
      }}
    >
      <button
        ref={toggle}
        type="button"
        className="node-port-toggle"
        aria-label={label}
        aria-expanded={expanded}
        aria-controls={listId}
        title={label}
        onClick={() => setDismissed(false)}
      >
        {ports.length}
      </button>
      <div id={listId}>
        {ports.map((port, index) => (
          <Handle
            {...port}
            key={port.id}
            type={type}
            position={input ? Position.Left : Position.Right}
            style={{
              top: expanded ? 44 + index * 28 : "50%",
              [input ? "left" : "right"]: "50%",
              width: expanded ? 16 : 30,
              height: expanded ? 16 : 40,
            }}
            className={`${port.className || ""} grouped-handle`}
            isConnectable={expanded && connectable}
            isConnectableStart={expanded && connectable}
            isConnectableEnd={expanded && connectable}
            aria-hidden={!expanded}
            aria-disabled={!connectable}
            tabIndex={expanded && connectable ? 0 : -1}
            role="button"
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                // React Flow's click-to-connect path also serves keyboard users.
                const bounds = event.currentTarget.getBoundingClientRect();
                event.currentTarget.dispatchEvent(
                  new MouseEvent("click", {
                    bubbles: true,
                    clientX: bounds.x + bounds.width / 2,
                    clientY: bounds.y + bounds.height / 2,
                  }),
                );
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
