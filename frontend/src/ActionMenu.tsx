import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

export interface ActionItem {
  id: string;
  label: string;
  run: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
  danger?: boolean;
}

/** Move focus between menu items with the arrow, Home and End keys. */
export function moveMenuFocus(event: KeyboardEvent, items: HTMLElement[]) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
          items.length;
  items[index]?.focus();
}

/** Keyboard and pointer actions of a context menu. */
export function ActionMenu({
  label,
  items,
  position,
  onClose,
}: {
  label: string;
  items: ActionItem[];
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState(position);
  useLayoutEffect(() => {
    const bounds = menu.current!.getBoundingClientRect();
    setPoint({
      x: Math.max(
        8,
        Math.min(position.x, window.innerWidth - bounds.width - 8),
      ),
      y: Math.max(
        8,
        Math.min(position.y, window.innerHeight - bounds.height - 8),
      ),
    });
  }, [position]);
  useEffect(() => {
    (
      menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ||
      menu.current
    )?.focus();
  }, []);
  useEffect(() => {
    const outside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    // Zooming or scrolling would leave the menu beside another node.
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("wheel", outside, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("wheel", outside, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={menu}
      className="node-action-menu"
      role="menu"
      tabIndex={-1}
      aria-label={label}
      style={{ left: point.x, top: point.y }}
      onContextMenu={(event) => event.preventDefault()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          onClose();
        }
        moveMenuFocus(event, [
          ...menu.current!.querySelectorAll<HTMLElement>(
            "button:not(:disabled)",
          ),
        ]);
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          className={item.danger ? "danger" : undefined}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.icon && <item.icon size={14} aria-hidden="true" />}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
