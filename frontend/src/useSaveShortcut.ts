import { useEffect, useEffectEvent, type RefObject } from "react";

/** Capture Ctrl/Command+S before the browser or code editor handles it. */
export function useSaveShortcut(
  save: () => unknown,
  scope?: RefObject<HTMLElement | null>,
) {
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    if (scope && !scope.current?.contains(event.target as Node)) return;
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      event.key.toLowerCase() !== "s"
    )
      return;
    event.preventDefault();
    if (!event.repeat) void save();
  });
  useEffect(() => {
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, []);
}
