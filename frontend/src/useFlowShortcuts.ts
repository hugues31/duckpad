import { useEffect, useEffectEvent } from "react";
import { copiedNodes, type CopiedNodes } from "./nodeClipboard";
import { blockingDialogShown, typingTarget } from "./searchShortcuts";
import type { Bundle, Graph } from "./types";
export function useFlowShortcuts({
  canEdit,
  addingNode,
  bundle,
  graph,
  selection,
  selected,
  busy,
  revert,
  safe,
  copy,
  paste,
  toggleMute,
  reconnect,
}: {
  canEdit: boolean;
  addingNode: boolean;
  bundle: Bundle | null;
  graph: Graph | undefined;
  selection: string[];
  selected: string | null;
  busy: boolean;
  revert: (direction: "undo" | "redo") => void;
  safe: (action: () => Promise<unknown>) => void;
  copy: (ids: string[]) => Promise<void>;
  paste: (copied: CopiedNodes) => Promise<void>;
  toggleMute: (ids: string[]) => Promise<void>;
  reconnect: (id: string) => Promise<void>;
}) {
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      typingTarget(event.target) ||
      blockingDialogShown()
    )
      return;
    const key = event.key.toLowerCase();
    if (!event.ctrlKey && !event.metaKey) {
      if (
        key !== "m" ||
        event.shiftKey ||
        !canEdit ||
        busy ||
        addingNode ||
        !bundle
      )
        return;
      const ids = selection.length ? selection : selected ? [selected] : [];
      if (!ids.length) return;
      event.preventDefault();
      if (!event.repeat) safe(() => toggleMute(ids));
      return;
    }
    if (key === "z" || key === "y") {
      // Repeated undos queue up behind the one in flight.
      if (!canEdit || addingNode || !bundle) return;
      event.preventDefault();
      if (!event.repeat)
        revert(key === "y" || event.shiftKey ? "redo" : "undo");
    } else if (key === "c" && !event.shiftKey && graph) {
      // Selected text is copied as usual.
      if (window.getSelection()?.toString()) return;
      const ids = selection.length ? selection : selected ? [selected] : [];
      if (!graph.nodes.some((item) => ids.includes(item.id))) return;
      event.preventDefault();
      if (!event.repeat) safe(() => copy(ids));
    } else if (key === "v" && !event.shiftKey) {
      const copied = copiedNodes();
      if (!canEdit || busy || !bundle || !copied) return;
      event.preventDefault();
      if (!event.repeat) safe(() => paste(copied));
    }
  });
  const reconnectShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      // Either removal key: Mac laptops only have the one that sends Backspace.
      (event.key !== "Delete" && event.key !== "Backspace") ||
      !(event.ctrlKey || event.metaKey) ||
      event.defaultPrevented ||
      event.isComposing ||
      typingTarget(event.target) ||
      blockingDialogShown() ||
      (event.target instanceof Element && event.target.closest('[role="menu"]'))
    )
      return;
    // Never fall back to ordinary removal, even when React Flow lost track of the modifier.
    event.preventDefault();
    event.stopPropagation();
    if (
      event.altKey ||
      event.shiftKey ||
      event.repeat ||
      !canEdit ||
      busy ||
      addingNode ||
      !bundle
    )
      return;
    const ids = selection.length ? selection : selected ? [selected] : [];
    if (ids.length === 1) safe(() => reconnect(ids[0]));
  });
  useEffect(() => {
    document.addEventListener("keydown", shortcut);
    document.addEventListener("keydown", reconnectShortcut, true);
    return () => {
      document.removeEventListener("keydown", shortcut);
      document.removeEventListener("keydown", reconnectShortcut, true);
    };
  }, []);
}
