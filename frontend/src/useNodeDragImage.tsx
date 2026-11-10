import { useReactFlow } from "@xyflow/react";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { PipelineNodeView, type PipelineNode } from "./CanvasNode";
import type { CanvasProps } from "./canvasTypes";
import { nodeInterface, type NodeKind } from "./graph";
import { nodeLabel, useT } from "./i18n";

export function useNodeDragImage({ parsed, components }: CanvasProps) {
  const t = useT();
  const { getZoom } = useReactFlow();
  const element = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<PipelineNode["data"] | null>(null);
  return {
    image: data && (
      <div
        ref={element}
        className="node-drag-image"
        // Native Chromium drag capture ignores the root element's transform.
        // Layout zoom is preserved in both the captured image and its hotspot.
        style={{ zoom: getZoom() }}
        aria-hidden="true"
      >
        <PipelineNodeView data={data} preview />
      </div>
    ),
    setDragImage(kind: NodeKind, id: string, transfer: DataTransfer) {
      const node = {
        id: "",
        params: {},
        position: { x: 0, y: 0 },
        ...(kind === "component" ? { component: id } : { template: id }),
      };
      const signature = nodeInterface(node, parsed, components);
      // The browser snapshots the element before dragstart returns.
      flushSync(() =>
        setData({
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
        }),
      );
      const image = element.current!;
      const bounds = image.getBoundingClientRect();
      const shape = image.querySelector(".node-shape")!.getBoundingClientRect();
      transfer.setDragImage(
        image,
        shape.x + shape.width / 2 - bounds.x,
        shape.y + shape.height / 2 - bounds.y,
      );
      // Keep the DOM only until the native drag image has been captured.
      requestAnimationFrame(() => setData(null));
    },
  };
}
