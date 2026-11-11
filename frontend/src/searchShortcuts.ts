import { useEffect } from "react";

export const searchShortcutLabel = (key: string) =>
  `${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"}${key.toUpperCase()}`;

/**
 * The shown dialogs matching a selector, in document order. A code editor's
 * own widgets, such as its find box, are dialogs that block nothing: Monaco
 * keeps the find box in the page, out of view, once closed.
 */
export const shownDialogs = (selector: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
    (dialog) =>
      !dialog.closest(".monaco-editor") && dialog.getClientRects().length > 0,
  );

/** Whether a blocking dialog is shown; page shortcuts yield to it. */
export const blockingDialogShown = () =>
  shownDialogs(
    'dialog[open], [role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]',
  ).length > 0;

/** The field or editor receiving the text typed at an event target, if any. */
export const typingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement
    ? target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
      )
    : null;

/** Search shortcuts work in the floating assistant but yield to other editors and modals. */
export function useSearchShortcut(
  key: "f" | "k" | undefined,
  onShortcut: () => void,
) {
  useEffect(() => {
    if (!key) return;
    const handle = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== key ||
        blockingDialogShown()
      )
        return;
      const editing = typingTarget(event.target);
      if (
        editing &&
        !editing.closest('.search-field, .assistant-chat[aria-modal="false"]')
      )
        return;
      event.preventDefault();
      if (!event.repeat) onShortcut();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [key, onShortcut]);
}
