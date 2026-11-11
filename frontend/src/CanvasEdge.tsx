import {
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { memo } from "react";
import { STEP_OFFSET } from "./canvasEdges";
import type { EdgeStyle } from "./types";

/** What the canvas draws of a link. */
type PipelineEdgeData = {
  style: EdgeStyle;
  /** The x of the vertical segment of a right-angled link, kept apart from other links. */
  lane?: number;
};

export type PipelineEdge = Edge<PipelineEdgeData, "pipeline">;

/** A curved or right-angled link between two sockets. */
export const PipelineEdge = memo(function PipelineEdge({
  data,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
  interactionWidth,
}: EdgeProps<PipelineEdge>) {
  const position = {
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  };
  const [path] =
    data?.style === "orthogonal"
      ? getSmoothStepPath({
          ...position,
          borderRadius: 10,
          offset: STEP_OFFSET,
          centerX: data.lane,
        })
      : getBezierPath(position);
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactionWidth}
    />
  );
});
PipelineEdge.displayName = "PipelineEdge";
