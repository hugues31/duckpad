import { useReactFlow } from "@xyflow/react";
import { Ban } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  NODE_SHAPE_CENTER,
  PipelineNodeView,
  type PipelineNode,
} from "./CanvasNode";
import type { CanvasProps } from "./canvasTypes";
import { nodeInterface, type NodeKind } from "./graph";
import { nodeLabel, useT } from "./i18n";

// A browser drag image is a snapshot that cannot change during the drag.
// The page draws the preview instead, so it can show where drops are refused.
const transparent = new Image();
transparent.src =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Preview a palette item as its node, at the canvas zoom, under the pointer. */
export function useNodeDragPreview({ parsed, components }: CanvasProps) {
  const t = useT();
  const { getZoom } = useReactFlow();
  const element = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{
    node: Parameters<typeof nodeInterface>[0];
    data: PipelineNode["data"];
    zoom: number;
  } | null>(null);
  return {
    node: preview?.node,
    preview:
      preview &&
      createPortal(
        <div
          ref={element}
          className="node-drag-preview"
          hidden
          aria-hidden="true"
        >
          <div
            style={{
              left: -NODE_SHAPE_CENTER.x,
              top: -NODE_SHAPE_CENTER.y,
              transformOrigin: `${NODE_SHAPE_CENTER.x}px ${NODE_SHAPE_CENTER.y}px`,
              scale: preview.zoom,
            }}
          >
            <PipelineNodeView data={preview.data} preview />
          </div>
          <Ban size={22} />
        </div>,
        document.body,
      ),
    previewDrag(kind: NodeKind, id: string, transfer: DataTransfer) {
      const node = {
        id: "",
        params: {},
        position: { x: 0, y: 0 },
        ...(kind === "component" ? { component: id } : { template: id }),
      };
      const signature = nodeInterface(node, parsed, components);
      transfer.setDragImage(transparent, 0, 0);
      setPreview({
        node,
        zoom: getZoom(),
        data: {
          fullNode: "",
          label: nodeLabel(node, signature, t),
          kind: signature.kind,
          icon: kind === "component" ? "component" : id,
          inputs: signature.inputs,
          missingInputs: signature.inputs,
          outputs: signature.outputs,
          connectedOutputs: [],
          status: "",
          warnings: 0,
        },
      });
      const drag = new AbortController();
      const follow = (event: DragEvent) => {
        const image = element.current;
        if (!image) return;
        image.hidden = false;
        image.style.translate = `${event.clientX}px ${event.clientY}px`;
        // Drop zones accept the drag by canceling dragover. Blink fires none
        // on the event that enters an element, so dragenter keeps the state.
        if (event.type === "dragover")
          image.classList.toggle("refused", !event.defaultPrevented);
      };
      const leave = (event: DragEvent) => {
        // No event reports the pointer outside the window.
        if (!event.relatedTarget && element.current)
          element.current.hidden = true;
      };
      const end = () => {
        drag.abort();
        setPreview(null);
      };
      const options = { signal: drag.signal };
      document.addEventListener("dragenter", follow, options);
      document.addEventListener("dragover", follow, options);
      document.addEventListener("dragleave", leave, options);
      document.addEventListener("drop", end, options);
      document.addEventListener("dragend", end, options);
    },
  };
}
