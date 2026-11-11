import { useEffect, useEffectEvent, type RefObject } from "react";
export function useDoubleClickGuard(
  flow: RefObject<HTMLElement | null>,
  onOpen: (id: string) => void,
) {
  const openNode = useEffectEvent((id: string) => onOpen(id));
  useEffect(() => {
    // A double-click acts on the node its first click hit. Selecting that node
    // opens panels that can refit the graph, so the second click may land on
    // the pane, another node or a panel: there, it must neither act nor zoom.
    let first: string | null = null;
    const click = (event: MouseEvent) => {
      const element =
        event.target instanceof Element
          ? event.target.closest(".react-flow__node")
          : null;
      const node =
        element && flow.current?.contains(element)
          ? element.getAttribute("data-id")
          : null;
      if (event.detail <= 1) first = node;
      else if (first && node !== first) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const doubleClick = (event: MouseEvent) => {
      if (!first) return;
      event.preventDefault();
      event.stopPropagation();
      openNode(first);
    };
    // Capture on the window to run before React and the pane's zoom handler.
    window.addEventListener("click", click, true);
    window.addEventListener("dblclick", doubleClick, true);
    return () => {
      window.removeEventListener("click", click, true);
      window.removeEventListener("dblclick", doubleClick, true);
    };
  }, [flow]);
}
