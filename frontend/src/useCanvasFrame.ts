import {
  getNodesBounds,
  getViewportForBounds,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useState, type RefObject } from "react";
export function useCanvasFrame(
  safeAreaRef: RefObject<HTMLDivElement | null>,
  focus: { id: string; reveal?: boolean } | null,
  viewportTouchedRef: RefObject<boolean>,
) {
  const [frame, setFrame] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const { getNodes, getViewport, setViewport } = useReactFlow();
  const initialized = useNodesInitialized();
  useEffect(() => {
    const element = safeAreaRef.current!;
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
  }, [safeAreaRef]);
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
  useEffect(() => {
    if (!focus || !initialized || !frame.width || !frame.height) return;
    const target = getNodes().filter((node) => node.id === focus.id);
    if (!target.length) return;
    if (focus.reveal) {
      const bounds = getNodesBounds(target);
      const { x, y, zoom } = getViewport();
      const left = x + bounds.x * zoom;
      const top = y + bounds.y * zoom;
      const width = bounds.width * zoom;
      const height = bounds.height * zoom;
      if (
        left >= frame.x &&
        top >= frame.y &&
        left + width <= frame.x + frame.width &&
        top + height <= frame.y + frame.height
      )
        return;
      viewportTouchedRef.current = true;
      void setViewport({
        x: x + frame.x + (frame.width - width) / 2 - left,
        y: y + frame.y + (frame.height - height) / 2 - top,
        zoom,
      });
      return;
    }
    viewportTouchedRef.current = true;
    fitGraph(target);
  }, [
    focus,
    initialized,
    frame,
    getNodes,
    getViewport,
    setViewport,
    fitGraph,
    viewportTouchedRef,
  ]);

  return { frame, fitGraph };
}
