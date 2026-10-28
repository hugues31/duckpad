import { useEffect } from "react";

export const searchShortcutLabel = (key: string) =>
  `${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"}${key.toUpperCase()}`;

/** Search shortcuts yield to editors, form fields and open dialogs. */
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
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== key ||
        Array.from(
          document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
        ).some((dialog) => dialog.getClientRects().length > 0)
      )
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const editing = target?.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
      );
      if (editing && !target?.closest(".search-field")) return;
      event.preventDefault();
      onShortcut();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [key, onShortcut]);
}
